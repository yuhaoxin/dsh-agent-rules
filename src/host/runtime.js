/**
 * 宿主运行时：为每个会话发现并分桶规则，持有它的 TTSR 实例与系统提示词片段。
 *
 * 规则按会话的工作目录发现，所以不同会话可以读到不同的项目规则。同一会话的
 * TTSR 实例在 cwd 变化后复用：`setRules` 只替换规则，已提醒集合与 step 预算保留。
 *
 * 加载时机由 `system-prompt/assemble` 驱动：它每个 step 在渲染提示词之前执行，
 * 是唯一能同时等到异步发现结果、又把结果放进本次提示词的时机。提示词 section 的
 * 正文在 waterfall 返回后回填，因此首轮就能读到规则。工作目录变更把条目标记为
 * 过期，下一次 assemble 重新发现。
 */

import { homedir } from 'node:os';

import { bucketRules } from '../rules/bucket.js';
import { discoverRules } from '../rules/discover.js';
import { renderAlwaysApply, renderRulebook } from '../rules/render.js';
import { createTtsrRuntime } from '../ttsr/index.js';
import { compileRules } from '../ttsr/rules.js';

/** alwaysApply 与 rulebook 片段在系统提示词里的位置：策略之后、工具说明之前。 */
export const PROMPT_SECTION_ORDER = 850;

/** 提示词 section 的注册名。 */
export const PROMPT_SECTION_NAME = 'agent-rules';

/** 分桶前静默试编译，避免与运行时注册重复记同一条 warning。 */
const SILENT_LOG = { warn() {} };

/**
 * @param {{
 *   ctx: object,
 *   directories?: readonly string[],
 *   log?: { warn: (message: string, ...rest: unknown[]) => void },
 *   home?: string,
 * }} options `directories` 是追加的规则目录，`home` 是用户级规则的基准
 */
export function createHostRuntime({ ctx, directories = [], log = console, home = homedir() }) {
  /** sessionId → { cwd, display, buckets, ttsr, stale } */
  const entries = new Map();
  /** sessionId → { turn, step }，来自最近的 `step/start` */
  const positions = new Map();
  /** sessionId → 串行化的加载链，避免并发 assemble 重复发现 */
  const chains = new Map();

  /**
   * 判断一条带 `condition` 的规则能否被 TTSR 层接受。不能接受的规则按 omp 的
   * 语义回落到 alwaysApply / rulebook 桶，而不是直接消失。
   */
  const isTtsrAccepted = (rule) => compileRules([rule], SILENT_LOG).length > 0;

  async function load(agent, signal) {
    const sessionId = agent.session.id;
    const cwd = await ctx.workingDirectory.ensure(agent, signal);
    const existing = entries.get(sessionId);
    if (existing !== undefined && existing.stale !== true && existing.cwd === cwd) return existing;

    const discovered = await discoverRules({ cwd, home, extraDirectories: directories, log });
    const buckets = bucketRules(discovered.rules, { isTtsrAccepted, log });
    const ttsr = existing?.ttsr ?? createTtsrRuntime({ log, cwd, home });
    ttsr.setCwd(cwd);
    ttsr.setHome(home);
    ttsr.setRules(buckets.ttsr);
    if (existing === undefined) ttsr.session(sessionId).syncReminded(agent.session.snapshotEvents());

    const entry = { cwd, display: { cwd, home }, buckets, ttsr, stale: false };
    entries.set(sessionId, entry);
    return entry;
  }

  /**
   * 加载或复用会话的规则条目。并发调用按会话串行，后一次加载看到前一次的写入。
   *
   * @param {object} agent
   * @param {AbortSignal} [signal]
   */
  function attach(agent, signal) {
    const sessionId = agent.session.id;
    const run = (chains.get(sessionId) ?? Promise.resolve()).then(() => load(agent, signal));
    const settled = run.then(
      () => {},
      () => {},
    );
    chains.set(sessionId, settled);
    settled.then(() => {
      if (chains.get(sessionId) === settled) chains.delete(sessionId);
    });
    return run;
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'step/start') {
      positions.set(session.id, { turn: event.data.turn, step: event.data.step });
      return;
    }
    if (event.type !== 'working-directory/change') return;
    const entry = entries.get(session.id);
    if (entry !== undefined) entry.stale = true;
  });

  ctx.on('agent/disposed', ({ agent }) => {
    entries.delete(agent.session.id);
    positions.delete(agent.session.id);
  });

  return {
    attach,

    /** 会话的规则条目，尚未加载时为 undefined。 */
    entry(sessionId) {
      return entries.get(sessionId);
    },

    /** 当前 step 位置，用于判定每 step 的重试预算。 */
    position(sessionId) {
      return positions.get(sessionId);
    },

    /**
     * 系统提示词片段：alwaysApply 正文在前，rulebook 清单在后。
     *
     * section 的 `text` 回调在 `assemble()` 里先于 waterfall 执行，此时规则可能
     * 还没加载完；调用方在 waterfall 返回后用它回填 section 文本。
     *
     * @param {object} agent
     * @returns {string} 没有规则时为空字符串
     */
    promptText(agent) {
      const entry = entries.get(agent.session.id);
      if (entry === undefined) return '';
      const always = renderAlwaysApply(entry.buckets.alwaysApply);
      const rulebook = renderRulebook(entry.buckets.rulebook, entry.display);
      return [always, rulebook].filter((text) => text.length > 0).join('\n\n');
    },
  };
}
