/**
 * TTSR 运行时：规则注册、流式匹配、注入、去重与重试协调。
 *
 * 事件接线不在这里：正文/思考流路径在 `llm/stream` 与 `agent/request-error`，
 * 工具路径在 `tools/pre-execute` 与 `tools/post-execute`。两条路径都通过
 * `runtime.session(sessionId)` 取到同一份会话状态，共享「每规则每会话一次」的
 * 去重集合与「每 step 最多重试 3 次」的预算。
 *
 * 重试链路的契约：
 * `llm/stream` 命中后用 `planInterrupt(hits, { turn, step })` 决定是否短路。返回
 * `null` 表示本 step 的预算已用完，调用方继续转发输出（放行）；非 null 时停止消费
 * 底层流，只 yield 它给的合成 `finish{kind:'error'}`。loop 随即派发
 * `agent/request-error`，该监听器用 `planRetry({ code })` 拿到注入消息 append 后
 * 返回 `{kind:'retry'}`。预算必须在短路前判定：loop 只在返回 `{kind:'retry'}` 时
 * 重试，在 `agent/request-error` 上返回其它值会让本轮以 error 结束，不是放行。
 */

import { randomUUID } from 'node:crypto';

import { buildInjection, buildReminder, parseReminded } from './inject.js';
import { createTextMatcher, matchToolCall } from './match.js';
import { compileRules } from './rules.js';

export const ERROR_CODE_PREFIX = 'AGENT_RULES_TTSR:';
export const MAX_RETRIES_PER_STEP = 3;

/** 会话内保留的 step 预算条目上限，超出后丢弃最早的一条。 */
const MAX_TRACKED_STEPS = 64;

/**
 * @param {{ rules?: readonly object[], log?: { warn: Function }, cwd?: string, home?: string }} options
 */
export function createTtsrRuntime({ rules = [], log = console, cwd = process.cwd(), home } = {}) {
  const state = { rules: [], byId: new Map(), cwd, home };
  const sessions = new Map();

  const setRules = (descriptors) => {
    state.rules = compileRules(descriptors, log);
    state.byId = new Map(state.rules.map((rule) => [rule.id, rule]));
    return state.rules;
  };
  setRules(rules);

  const session = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new TypeError('TTSR 会话 id 必须是非空字符串');
    }
    let scoped = sessions.get(sessionId);
    if (!scoped) sessions.set(sessionId, scoped = createSessionState({ state, log }));
    return scoped;
  };

  return {
    get rules() {
      return state.rules;
    },
    /** 重新注册规则；已提醒集合与 step 预算保留。 */
    setRules,
    /** 工作目录变化后更新模板里的路径显示与工具路径解析基准。 */
    setCwd(next) {
      state.cwd = next;
    },
    setHome(next) {
      state.home = next;
    },
    session,
  };
}

function createSessionState({ state, log }) {
  const reminded = new Set();
  const steps = new Map();

  const isReminded = (rule) => reminded.has(rule.id);
  const unreminded = (hits) => hits.filter((rule) => !isReminded(rule));

  const markReminded = (hits) => {
    for (const rule of hits) reminded.add(rule.id);
  };

  const sessionState = {
    /** 一次 attempt 一个匹配器；命中结果已经过滤掉本会话提醒过的规则。 */
    createTextMatcher() {
      return createTextMatcher(state.rules, { isReminded });
    },

    /** 工具调用匹配，同样过滤掉提醒过的规则。 */
    matchToolCall(call) {
      return unreminded(matchToolCall(state.rules, { cwd: state.cwd, ...call }));
    },

    unreminded,
    markReminded,
    isReminded,

    /**
     * 用会话 surface 上的注入消息重建去重集合。恢复、fork 或长时间未触发的
     * 会话在匹配前调用一次即可。
     *
     * @param {Iterable<object>} events `session.snapshotEvents()` 给出的事件列表
     */
    syncReminded(events) {
      for (const id of parseReminded(events)) reminded.add(id);
      return reminded;
    },

    /** 合成 finish 的失败码，多条命中用 `,` 分隔。 */
    errorCode(hits) {
      return ERROR_CODE_PREFIX + hits.map((rule) => rule.id).join(',');
    },

    /**
     * 合成中断本次 attempt 的 finish chunk。它必须是流里的最后一个 chunk：
     * loop 只认 `reason.kind === 'error'` 的 finish，并且会把 `failure.code`、
     * `failure.message` 原样交给 LlmError，两者都不能为空。
     *
     * @param {readonly object[]} hits
     */
    interruptFinish(hits) {
      const code = sessionState.errorCode(hits);
      return { type: 'finish', reason: { kind: 'error', failure: { code, message: `TTSR rule violation: ${code}` } } };
    },

    parseErrorCode(code) {
      if (typeof code !== 'string' || !code.startsWith(ERROR_CODE_PREFIX)) return null;
      const ids = code.slice(ERROR_CODE_PREFIX.length).split(',').filter((id) => id.length > 0);
      return ids.length === 0 ? null : ids;
    },

    /**
     * 命中后决定是否中断本次 attempt。返回 null 表示放行：该 step 的重试预算
     * 已经用完，调用方继续转发模型输出，只由 `warn` 记一次日志。
     *
     * @param {readonly object[]} hits 本次 attempt 的未提醒命中
     * @param {{ turn: number, step: number }} position
     * @returns {{ hits: object[], finish: object } | null}
     */
    planInterrupt(hits, { turn, step }) {
      const key = `${turn}:${step}`;
      const used = steps.get(key) ?? 0;
      if (used >= MAX_RETRIES_PER_STEP) {
        log.warn(`[agent-rules] step ${key} 的 TTSR 重试已达上限 ${MAX_RETRIES_PER_STEP}，放行本次输出`);
        return null;
      }
      steps.set(key, used + 1);
      if (steps.size > MAX_TRACKED_STEPS) steps.delete(steps.keys().next().value);
      return { hits, finish: sessionState.interruptFinish(hits) };
    },

    /**
     * 重试请求的注入消息。返回 null 表示没有可注入的规则，调用方不要返回
     * `{kind:'retry'}`：在 `agent/request-error` 上返回其它值会让本轮以 error 结束。
     *
     * @param {{ code: string }} failure
     * @returns {{ hits: object[], injection: object } | null}
     */
    planRetry({ code }) {
      const ids = sessionState.parseErrorCode(code);
      if (!ids) return null;
      const hits = unreminded(ids.map((id) => state.byId.get(id)).filter(Boolean));
      if (hits.length === 0) return null;

      markReminded(hits);
      return { hits, injection: buildInjection(hits, { id: randomUUID(), cwd: state.cwd, home: state.home }) };
    },

    /**
     * 工具命中需要中断时的拒绝理由与注入消息。`tools/pre-execute` 的 `deny`
     * 只返回一句 reason 给模型，规则正文通过追加的 surface 消息进入下一步的模型上下文。
     *
     * 命中在返回前就标记为已提醒：deny 的工具体不执行，`tools/post-execute`
     * 不会为同一次调用再跑一遍去重。
     *
     * @param {readonly object[]} hits 本次工具调用的未提醒命中
     * @param {{ cwd?: string, home?: string }} [display] 路径显示基准
     * @returns {{ hits: object[], denied: string, injection: object }}
     */
    planToolDeny(hits, display = {}) {
      markReminded(hits);
      const names = hits.map((rule) => rule.id).join(', ');
      return {
        hits,
        denied: `TTSR rule violation: ${names}. The rule body was injected; comply with it before retrying this tool call.`,
        injection: buildInjection(hits, { id: randomUUID(), ...display }),
      };
    },

    /**
     * 命中配置为不中断时的提醒消息。工具路径经 `tools/post-execute` 的
     * `additionalContexts` 送进下一步，正文路径经 `agent/turn-stopping` 的
     * `steer` 送进下一步；两种情形工具与输出都保持不变。
     *
     * @param {readonly object[]} hits 本次命中的未提醒规则
     * @param {{ cwd?: string, home?: string }} [display] 路径显示基准
     * @returns {{ type: string, payload: object, options: object }}
     */
    planReminder(hits, display = {}) {
      markReminded(hits);
      return buildReminder(hits, { id: randomUUID(), ...display });
    },
  };

  return sessionState;
}
