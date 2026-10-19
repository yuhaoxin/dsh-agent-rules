/**
 * 一次性探针插件：验证 DSH 的「流中断 + 注入规则 + 同轮重试」链路。
 *
 * 命中 PROBE_TRIGGER 后不调用 agent.cancel()，而是短路 llm/stream 并合成
 * finish{kind:'error'}；agent/request-error 里追加 surface 规则消息并返回
 * {kind:'retry'}。PROBE_MODE=buffer 时命中前的 chunk 不转发，UI 看不到被
 * 丢弃的部分输出。
 */
export const name = 'proto-probe';
export const inject = ['agents'];

const MODE = process.env.PROBE_MODE ?? 'buffer';
const CHANNEL = process.env.PROBE_CHANNEL ?? 'user';
const TRIGGER = process.env.PROBE_TRIGGER ?? 'pineapple';
const RULE = process.env.PROBE_RULE ?? 'Reply with exactly OK and nothing else.';
const MAX_RETRIES = Number(process.env.PROBE_MAX_RETRIES ?? 1);
const EMIT_RETRY_EVENT = process.env.PROBE_EMIT_RETRY_EVENT === '1';
const state = new Map();

function stateFor(id) {
  let s = state.get(id);
  if (!s) state.set(id, s = { reminded: false, retries: 0 });
  return s;
}

export function apply(ctx) {
  ctx.on('llm/stream', async function* (options, next) {
    // 会话标题、压缩等非 loop 请求也可能带 sessionId，必须按 purpose 过滤。
    if (options.purpose !== undefined || options.sessionId === undefined) {
      yield* next();
      return;
    }
    const s = stateFor(options.sessionId);
    if (s.reminded || s.retries >= MAX_RETRIES) {
      yield* next();
      return;
    }

    const inner = next()[Symbol.asyncIterator]();
    let text = '';
    const buffered = [];
    try {
      while (true) {
        const { done, value } = await inner.next();
        if (done) {
          for (const chunk of buffered) yield chunk;
          return;
        }
        if (value.type === 'text-delta' || value.type === 'reasoning-delta') {
          text += value.text;
          if (text.toLowerCase().includes(TRIGGER)) {
            console.error('[probe] hit at %d chars', text.length);
            // 只发一个合成 finish：转发 adapter 的 finish 或不发 finish 都会
            // 让部分输出被当成完整回答提交。
            yield { type: 'finish', reason: { kind: 'error', failure: { code: 'PROTO_TTSR:rule-1', message: 'probe hit' } } };
            return;
          }
        }
        if (MODE === 'buffer') {
          buffered.push(value);
          continue;
        }
        yield value;
      }
    } finally {
      await inner.return?.();
    }
  });

  ctx.on('agent/request-error', async ({ agent, turn, step, failure, signal }, next) => {
    if (!failure.code.startsWith('PROTO_TTSR:') || signal.aborted) return next();
    const s = stateFor(agent.session.id);
    if (s.reminded || s.retries >= MAX_RETRIES) return next();
    s.reminded = true;
    s.retries += 1;

    const content = [{ type: 'text', text: RULE }];
    if (CHANNEL === 'developer') {
      // developer/message 必须带 turn 与 step，否则 append 直接抛错。
      agent.session.append('developer/message', {
        turn, step,
        message: { id: `probe-${Date.now()}`, role: 'developer', content, source: { kind: 'user' } },
      }, { surfaceOp: 'append' });
    } else if (CHANNEL === 'instructions') {
      agent.session.append('user/message', {
        id: `probe-${Date.now()}`, role: 'user', content,
        source: { kind: 'agent-instructions', form: 'instructions', baseline: false },
      }, { surfaceOp: 'append' });
    } else {
      agent.session.append('user/message', {
        id: `probe-${Date.now()}`, role: 'user', content, source: { kind: 'user' },
      }, { surfaceOp: 'append' });
    }
    if (EMIT_RETRY_EVENT) {
      // llm/retry 是 Client 重置 assistant 块的信号；append 它可以把 forward
      // 模式下已经发出去的片段从对话视图里清掉。载荷形状与 dsh-llm-retry 一致。
      agent.session.append('llm/retry', {
        retryId: `probe-${Date.now()}`,
        turn, step,
        provider: 'agent-rules',
        mode: 'normal',
        policyKey: 'agent-rules',
        retry: s.retries,
        maxRetries: MAX_RETRIES,
        delayMs: 0,
        failure,
      });
    }
    console.error('[probe] injected via %s, retry #%d', CHANNEL, s.retries);
    return { kind: 'retry' };
  });
}
