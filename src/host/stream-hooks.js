/**
 * TTSR 正文与思考流路径的事件接线：`llm/stream` 增量匹配、短路，`agent/request-error` 注入并重试。
 *
 * 链路：
 *
 * 1. `llm/stream` 包住 `next()`，累积 `text-delta` 与 `reasoning-delta`，按规则
 *    `scope` 与 `condition` 做增量匹配。命中后调 `planInterrupt(hits, {turn, step})`：
 *    返回 `null` 表示本 step 预算已用完，继续转发模型输出；否则停止消费底层流，
 *    只 yield 一个合成的 `finish{kind:'error'}`。被丢弃的 attempt 只进
 *    `assistant/attempt`，不进模型上下文。
 * 2. loop 派发 `agent/request-error`，那里 append 注入消息并返回 `{kind:'retry'}`；
 *    重试请求从 surface 重新派生消息，因此能看到规则正文。
 *
 * 转发用滑窗：匹配始终看全量累积文本，转发延迟 `FORWARD_WINDOW` 个字符。命中时
 * 只丢弃窗口内尚未转发的部分，已转发的字符无法撤回。
 *
 * `interruptMode: never` 的正文命中不中断：命中先记下来，本轮正常结束时由
 * `agent/turn-stopping` 用 `agent.steer()` 把提醒送进下一步，本轮因此不关闭。
 *
 * 只处理 loop 发起的请求：会话标题、压缩等辅助调用带 `purpose`，不参与匹配。
 */

import { interrupts, reminds } from '../ttsr/rules.js';

/**
 * 转发窗口：匹配看全量文本，转发落后这么多字符。窗口越大，命中时丢弃的输出越
 * 完整，代价是首字延迟越高。
 */
export const FORWARD_WINDOW = 1024;

/**
 * 安装流路径的监听器。
 *
 * @param {object} ctx 插件上下文
 * @param {object} runtime 宿主运行时
 * @returns {void}
 */
export function installStreamHooks(ctx, runtime) {
  /** sessionId → 本轮待投递的 `never` 命中 */
  const deferred = new Map();

  ctx.on('llm/stream', async function* (options, next) {
    if (options.purpose !== undefined || options.sessionId === undefined) {
      yield* next();
      return;
    }
    const entry = runtime.entry(options.sessionId);
    const position = runtime.position(options.sessionId);
    if (entry === undefined || position === undefined) {
      yield* next();
      return;
    }

    const session = entry.ttsr.session(options.sessionId);
    const matcher = session.createTextMatcher();
    const inner = next()[Symbol.asyncIterator]();
    const pending = [];
    let buffered = 0;
    try {
      while (true) {
        const { done, value } = await inner.next();
        if (done) {
          const hits = matcher.final();
          if (hits.length > 0) {
            const interrupt = settle(session, hits, position, options.sessionId, deferred);
            if (interrupt !== null) {
              yield interrupt;
              return;
            }
          }
          for (const chunk of pending) yield chunk;
          return;
        }

        const hits = matchChunk(matcher, value);
        if (hits.length > 0) {
          const interrupt = settle(session, hits, position, options.sessionId, deferred);
          if (interrupt !== null) {
            yield interrupt;
            return;
          }
        }

        pending.push(value);
        buffered += forwardedLength(value);
        while (buffered > FORWARD_WINDOW) {
          const chunk = pending.shift();
          buffered -= forwardedLength(chunk);
          yield chunk;
        }
      }
    } finally {
      await inner.return?.();
    }
  });

  ctx.on('agent/turn-stopping', ({ agent, signal }) => {
    const queued = deferred.get(agent.session.id);
    if (queued === undefined) return;
    deferred.delete(agent.session.id);
    if (signal.aborted) return;
    const entry = runtime.entry(agent.session.id);
    if (entry === undefined) return;
    const reminder = entry.ttsr.session(agent.session.id).planReminder([...queued.values()], entry.display);
    agent.steer(reminder.payload);
  });

  ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
    if (signal.aborted) return next();
    const entry = runtime.entry(agent.session.id);
    if (entry === undefined) return next();
    const plan = entry.ttsr.session(agent.session.id).planRetry({ code: failure.code });
    if (plan === null) return next();
    agent.session.append(plan.injection.type, plan.injection.payload, plan.injection.options);
    return { kind: 'retry' };
  });

  ctx.on('agent/disposed', ({ agent }) => {
    deferred.delete(agent.session.id);
  });
}

const interruptsStream = (rule) => interrupts(rule, 'stream');

/**
 * 一个 chunk 命中的规则。工具调用增量不参与正文/思考匹配。
 */
function matchChunk(matcher, chunk) {
  if (chunk.type === 'text-delta') return matcher.push(chunk.text, 'text');
  if (chunk.type === 'reasoning-delta') return matcher.push(chunk.text, 'thinking');
  return [];
}

/**
 * 处理一次命中的规则集合，返回要 yield 的中断 finish，或 null 表示继续转发。
 *
 * 中断型命中交给 `planInterrupt` 判定本 step 的重试预算；`never` 命中先记进
 * 本轮待投递列表，同一规则在同一轮里只记一次。
 *
 * @returns {object | null}
 */
function settle(session, hits, position, sessionId, deferred) {
  const interruptHits = hits.filter(interruptsStream);
  if (interruptHits.length > 0) {
    const interrupt = session.planInterrupt(interruptHits, position);
    if (interrupt !== null) return interrupt.finish;
  }

  // 不中断的命中一律排进本轮待投递表：`tool-only` 的正文命中与 `never` 一样，
  // 本轮结束后把提醒送进下一步，不丢弃。
  const queued = deferred.get(sessionId) ?? new Map();
  for (const rule of hits) {
    if (interruptHits.includes(rule)) continue;
    queued.set(rule.id, rule);
  }
  if (queued.size > 0) deferred.set(sessionId, queued);
  return null;
}

/**
 * 一个 chunk 在转发窗口里占用的字符数。正文与思考增量按字符数计，其它帧各占
 * 一个字符：工具增量本身不携带待丢弃的正文，但窗口要能推进，否则 `pending`
 * 会在整段工具调用期间无界增长。
 */
function forwardedLength(chunk) {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return chunk.text.length;
  return 1;
}
