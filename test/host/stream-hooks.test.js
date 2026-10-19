import assert from 'node:assert/strict';
import test from 'node:test';

import { FORWARD_WINDOW, installStreamHooks } from '../../src/host/stream-hooks.js';
import { createTtsrRuntime } from '../../src/ttsr/index.js';

/**
 * 最小的插件上下文替身：`on` 保存监听器，`waterfall` 按 Cordis 的
 * `(…args, next)` 形态串起来，`emit` 派发普通事件。
 */
function createContext() {
  const listeners = new Map();
  return {
    on(name, listener) {
      const list = listeners.get(name) ?? [];
      list.push(listener);
      listeners.set(name, list);
    },
    waterfall(name, ...args) {
      const inner = args.pop();
      const chain = listeners.get(name) ?? [];
      const run = (index) => (index === chain.length ? inner() : chain[index](...args, () => run(index + 1)));
      return run(0);
    },
    emit(name, ...args) {
      for (const listener of listeners.get(name) ?? []) listener(...args);
    },
  };
}

function createRuntime(rules) {
  const ttsr = createTtsrRuntime({ rules, cwd: '/repo', log: { warn() {} } });
  const entry = { ttsr, display: { cwd: '/repo', home: '/home/dev' } };
  return { entry: (sessionId) => (sessionId === 's1' ? entry : undefined), position: () => ({ turn: 0, step: 0 }) };
}

function rule(name, condition, extra = {}) {
  return { name, path: `/repo/.agents/rules/${name}.md`, body: `遵守 ${name}。`, condition, ...extra };
}

/** 从 chunk 数组造一个可异步迭代的流，并在被提前关闭时记录。 */
function createStream(chunks, observe = () => {}) {
  const queue = [...chunks];
  const iterator = {
    async next() {
      observe('pull');
      if (queue.length === 0) return { done: true, value: undefined };
      return { done: false, value: queue.shift() };
    },
    async return() {
      closed = true;
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
  let closed = false;
  return {
    stream: iterator,
    get closed() {
      return closed;
    },
  };
}

function text(text, index = 0) {
  return { type: 'text-delta', index, text };
}

function finish(kind = 'stop') {
  return { type: 'finish', reason: { kind } };
}

async function collect(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
}

function createAgent(sessionId = 's1') {
  const appended = [];
  return {
    appended,
    agent: {
      session: {
        id: sessionId,
        append(type, payload, options) {
          appended.push({ type, payload, options });
        },
      },
    },
  };
}

test('命中后短路：只 yield 一个合成 finish error，不再转发模型输出', async () => {
  const ctx = createContext();
  const runtime = createRuntime([rule('no-needle', 'needle')]);
  installStreamHooks(ctx, runtime);

  const source = createStream([text('nee'), text('dle'), text('后续输出'), finish()]);
  const options = { sessionId: 's1' };
  const chunks = await collect(
    await ctx.waterfall('llm/stream', options, () => source.stream),
  );

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].type, 'finish');
  assert.equal(chunks[0].reason.kind, 'error');
  assert.equal(chunks[0].reason.failure.code, 'AGENT_RULES_TTSR:no-needle');
  assert.equal(source.closed, true, '底层流被关闭');
});

test('未命中时完整转发并关闭底层流', async () => {
  const ctx = createContext();
  const runtime = createRuntime([rule('no-needle', 'needle')]);
  installStreamHooks(ctx, runtime);

  const source = createStream([text('haystack'), finish()]);
  const chunks = await collect(await ctx.waterfall('llm/stream', { sessionId: 's1' }, () => source.stream));

  assert.deepEqual(chunks.map((chunk) => chunk.type), ['text-delta', 'finish']);
  assert.equal(source.closed, true);
});

test('转发窗口之外的文本命中时，窗口内未转发的输出被丢弃', async () => {
  const ctx = createContext();
  const runtime = createRuntime([rule('no-needle', 'needle')]);
  installStreamHooks(ctx, runtime);

  const chunks = [text('a'.repeat(FORWARD_WINDOW + 100)), text('needle'), finish()];
  const source = createStream(chunks);
  const out = await collect(await ctx.waterfall('llm/stream', { sessionId: 's1' }, () => source.stream));

  // 首块超过窗口后被转发；命中时窗口里只剩 needle 与 finish。
  assert.equal(out.length, 2);
  assert.equal(out[0].type, 'text-delta');
  assert.equal(out[1].reason.failure.code, 'AGENT_RULES_TTSR:no-needle');
});

test('带 purpose 的请求不参与匹配', async () => {
  const ctx = createContext();
  const runtime = createRuntime([rule('no-needle', 'needle')]);
  installStreamHooks(ctx, runtime);

  const source = createStream([text('needle'), finish()]);
  const out = await collect(
    await ctx.waterfall('llm/stream', { sessionId: 's1', purpose: 'session-title' }, () => source.stream),
  );

  assert.deepEqual(out.map((chunk) => chunk.type), ['text-delta', 'finish']);
});

test('会话没有加载规则时原样转发', async () => {
  const ctx = createContext();
  const runtime = createRuntime([rule('no-needle', 'needle')]);
  installStreamHooks(ctx, runtime);

  const source = createStream([text('needle'), finish()]);
  const out = await collect(
    await ctx.waterfall('llm/stream', { sessionId: 'unknown' }, () => source.stream),
  );

  assert.deepEqual(out.map((chunk) => chunk.type), ['text-delta', 'finish']);
});

test('思考流默认不匹配，scope 打开后才中断', async () => {
  const ctx = createContext();
  const runtime = createRuntime([rule('no-needle', 'needle', { scope: 'thinking' })]);
  installStreamHooks(ctx, runtime);

  const source = createStream([{ type: 'reasoning-delta', index: 0, text: 'needle' }, finish()]);
  const out = await collect(await ctx.waterfall('llm/stream', { sessionId: 's1' }, () => source.stream));

  assert.equal(out.length, 1);
  assert.equal(out[0].reason.failure.code, 'AGENT_RULES_TTSR:no-needle');
});

test('never 规则的正文命中不中断，本轮结束时用 steer 投递提醒', async () => {
  const ctx = createContext();
  const runtime = createRuntime([rule('no-needle', 'needle', { interruptMode: 'never' })]);
  installStreamHooks(ctx, runtime);

  const source = createStream([text('needle'), finish()]);
  const out = await collect(await ctx.waterfall('llm/stream', { sessionId: 's1' }, () => source.stream));
  assert.deepEqual(out.map((chunk) => chunk.type), ['text-delta', 'finish'], '不中断');

  const { agent } = createAgent('s1');
  const steered = [];
  agent.steer = (message) => steered.push(message);
  ctx.emit('agent/turn-stopping', { agent, signal: { aborted: false } });

  assert.equal(steered.length, 1);
  assert.equal(steered[0].role, 'user');
  assert.deepEqual(steered[0].source, { kind: 'agent-rules', form: 'notice' });
  assert.match(steered[0].content[0].text, /<system-reminder reason="rule_violation" rule="no-needle"/);
});

test('never 命中在多次 attempt 里只投递一次提醒', async () => {
  const ctx = createContext();
  const runtime = createRuntime([rule('no-needle', 'needle', { interruptMode: 'never' })]);
  installStreamHooks(ctx, runtime);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const source = createStream([text('needle'), finish()]);
    await collect(await ctx.waterfall('llm/stream', { sessionId: 's1' }, () => source.stream));
  }

  const { agent } = createAgent('s1');
  const steered = [];
  agent.steer = (message) => steered.push(message);
  ctx.emit('agent/turn-stopping', { agent, signal: { aborted: false } });

  assert.equal(steered.length, 1);
  const blocks = steered[0].content[0].text.match(/<system-reminder\b/g);
  assert.equal(blocks.length, 1, '同一规则只提醒一次');
});

test('流结束时的 final 全扫补上被节流推迟的命中', async () => {
  const ctx = createContext();
  // 规则在超过 FULL_SCAN_LIMIT 后命中：中途的增量扫描被节流跳过，只有结束时的
  // 全扫能看到它。
  const { FULL_SCAN_LIMIT } = await import('../../src/ttsr/match.js');
  const ctxRuntime = createRuntime([rule('late-needle', 'LATE')]);
  installStreamHooks(ctx, ctxRuntime);

  const source = createStream([text('a'.repeat(FULL_SCAN_LIMIT + 10)), text('LATE'), finish()]);
  const out = await collect(await ctx.waterfall('llm/stream', { sessionId: 's1' }, () => source.stream));

  assert.equal(out.at(-1).type, 'finish');
  assert.equal(out.at(-1).reason.failure.code, 'AGENT_RULES_TTSR:late-needle');
});

test('工具增量也推进转发窗口，输出不会攒到流结束才发出', async () => {
  const ctx = createContext();
  const runtime = createRuntime([rule('no-needle', 'needle')]);
  installStreamHooks(ctx, runtime);

  const chunks = [];
  for (let index = 0; index < 5000; index += 1) chunks.push({ type: 'tool-call-delta', index: 0, text: '' });
  chunks.push(finish());

  const events = [];
  const source = createStream(chunks, (kind) => events.push(kind));
  const out = [];
  for await (const chunk of await ctx.waterfall('llm/stream', { sessionId: 's1' }, () => source.stream)) {
    events.push('yield');
    out.push(chunk);
  }

  assert.equal(out.length, 5001, '所有帧都被转发');
  const firstYield = events.indexOf('yield');
  const lastPull = events.lastIndexOf('pull');
  assert.ok(firstYield < lastPull, '转发在流结束前就开始，pending 不会无界增长');
});

test('tool-only 规则不在正文流中断，命中改为本轮结束后的提醒', async () => {
  const ctx = createContext();
  const runtime = createRuntime([rule('no-needle', 'needle', { interruptMode: 'tool-only' })]);
  installStreamHooks(ctx, runtime);

  const source = createStream([text('needle'), finish()]);
  const out = await collect(await ctx.waterfall('llm/stream', { sessionId: 's1' }, () => source.stream));
  assert.deepEqual(out.map((chunk) => chunk.type), ['text-delta', 'finish'], '不中断');

  const { agent } = createAgent('s1');
  const steered = [];
  agent.steer = (message) => steered.push(message);
  ctx.emit('agent/turn-stopping', { agent, signal: { aborted: false } });

  assert.equal(steered.length, 1, '命中不丢弃，改为提醒');
  assert.match(steered[0].content[0].text, /rule="no-needle"/);
});

test('request-error 用错误码注入规则并返回 retry', async () => {
  const ctx = createContext();
  const runtime = createRuntime([rule('no-needle', 'needle')]);
  installStreamHooks(ctx, runtime);

  const source = createStream([text('needle')]);
  await collect(await ctx.waterfall('llm/stream', { sessionId: 's1' }, () => source.stream));

  const { agent, appended } = createAgent('s1');
  const action = await ctx.waterfall(
    'agent/request-error',
    { agent, failure: { code: 'AGENT_RULES_TTSR:no-needle' }, signal: { aborted: false } },
    async () => undefined,
  );

  assert.deepEqual(action, { kind: 'retry' });
  assert.equal(appended.length, 1);
  assert.match(appended[0].payload.content[0].text, /<system-interrupt reason="rule_violation" rule="no-needle"/);
});

test('request-error 对无关错误码不接管', async () => {
  const ctx = createContext();
  const runtime = createRuntime([rule('no-needle', 'needle')]);
  installStreamHooks(ctx, runtime);

  const { agent, appended } = createAgent('s1');
  const action = await ctx.waterfall(
    'agent/request-error',
    { agent, failure: { code: 'RATE_LIMIT' }, signal: { aborted: false } },
    async () => undefined,
  );

  assert.equal(action, undefined);
  assert.equal(appended.length, 0);
});

test('同一 step 命中超过 3 次后放行，不再短路', async () => {
  const ctx = createContext();
  const runtime = createRuntime([
    rule('r1', 'a'),
    rule('r2', 'b'),
    rule('r3', 'c'),
    rule('r4', 'd'),
  ]);
  installStreamHooks(ctx, runtime);

  for (const letter of ['a', 'b', 'c']) {
    const source = createStream([text(letter)]);
    const out = await collect(await ctx.waterfall('llm/stream', { sessionId: 's1' }, () => source.stream));
    assert.equal(out[0].reason.failure.code, `AGENT_RULES_TTSR:r${['a', 'b', 'c'].indexOf(letter) + 1}`);
  }

  const source = createStream([text('d'), finish()]);
  const out = await collect(await ctx.waterfall('llm/stream', { sessionId: 's1' }, () => source.stream));
  assert.deepEqual(out.map((chunk) => chunk.type), ['text-delta', 'finish'], '预算用完后放行');
});
