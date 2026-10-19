import assert from 'node:assert/strict';
import test from 'node:test';

import { installToolHooks } from '../../src/host/tool-hooks.js';
import { createTtsrRuntime } from '../../src/ttsr/index.js';

/**
 * 最小的插件上下文替身：按名字保存 waterfall 监听器，按 Cordis 的
 * `(payload, next)` 形态串起来。
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
  };
}

function createRuntime(rules) {
  const ttsr = createTtsrRuntime({ rules, cwd: '/repo', log: { warn() {} } });
  const entry = { ttsr, display: { cwd: '/repo', home: '/home/dev' } };
  return { entry: () => entry };
}

function createExec(runtime, { name = 'edit', args = {}, sessionId = 's1' } = {}) {
  const appended = [];
  const agent = {
    session: {
      id: sessionId,
      append(type, payload, options) {
        appended.push({ type, payload, options });
      },
    },
  };
  return { exec: { name, arguments: args, agent }, appended };
}

function rule(name, condition, extra = {}) {
  return { name, path: `/repo/.agents/rules/${name}.md`, body: `遵守 ${name}。`, condition, ...extra };
}

test('always 规则在 pre-execute 返回 deny，并追加规则正文', async () => {
  const ctx = createContext();
  const runtime = createRuntime([rule('no-console', 'console\\.log', { scope: 'tool' })]);
  installToolHooks(ctx, runtime);

  const { exec, appended } = createExec(runtime, {
    args: { file_path: '/repo/a.ts', new_string: 'console.log(1)' },
  });
  const decision = await ctx.waterfall('tools/pre-execute', exec, async () => ({ kind: 'allow' }));

  assert.equal(decision.kind, 'deny');
  assert.match(decision.reason, /no-console/);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].type, 'user/message');
  assert.match(appended[0].payload.content[0].text, /<system-interrupt reason="rule_violation" rule="no-console"/);
});

test('未命中时 pre-execute 放行，不追加消息', async () => {
  const ctx = createContext();
  const runtime = createRuntime([rule('no-console', 'console\\.log', { scope: 'tool' })]);
  installToolHooks(ctx, runtime);

  const { exec, appended } = createExec(runtime, { args: { file_path: '/repo/a.ts', new_string: 'ok' } });
  const decision = await ctx.waterfall('tools/pre-execute', exec, async () => ({ kind: 'allow' }));

  assert.deepEqual(decision, { kind: 'allow' });
  assert.equal(appended.length, 0);
});

test('prose-only 规则不在工具路径拦截', async () => {
  const ctx = createContext();
  const runtime = createRuntime([rule('no-console', 'console\\.log', { scope: 'tool', interruptMode: 'prose-only' })]);
  installToolHooks(ctx, runtime);

  const { exec } = createExec(runtime, { args: { file_path: '/repo/a.ts', new_string: 'console.log(1)' } });
  const decision = await ctx.waterfall('tools/pre-execute', exec, async () => ({ kind: 'allow' }));
  assert.deepEqual(decision, { kind: 'allow' });
});

test('never 规则在 post-execute 用 additionalContexts 附提醒，工具结果不变', async () => {
  const ctx = createContext();
  const runtime = createRuntime([rule('no-console', 'console\\.log', { scope: 'tool', interruptMode: 'never' })]);
  installToolHooks(ctx, runtime);

  const { exec } = createExec(runtime, { args: { file_path: '/repo/a.ts', new_string: 'console.log(1)' } });
  const result = { content: [{ type: 'text', text: 'edited' }] };
  const decision = await ctx.waterfall('tools/post-execute', exec, result, async () => ({ kind: 'accept' }));

  assert.equal(decision.kind, 'accept');
  assert.equal(decision.additionalContexts.length, 1);
  const [context] = decision.additionalContexts;
  assert.equal(context.role, 'user');
  assert.deepEqual(context.source, { kind: 'agent-rules', form: 'notice' });
  assert.match(context.content[0].text, /<system-reminder reason="rule_violation" rule="no-console"/);
});

test('always 规则不重复走 post-execute 提醒', async () => {
  const ctx = createContext();
  const runtime = createRuntime([rule('no-console', 'console\\.log', { scope: 'tool' })]);
  installToolHooks(ctx, runtime);

  const { exec } = createExec(runtime, { args: { file_path: '/repo/a.ts', new_string: 'console.log(1)' } });
  await ctx.waterfall('tools/pre-execute', exec, async () => ({ kind: 'allow' }));
  const decision = await ctx.waterfall('tools/post-execute', exec, {}, async () => ({ kind: 'accept' }));

  assert.deepEqual(decision, { kind: 'accept' });
});

test('一条规则在一个会话里只拦截一次', async () => {
  const ctx = createContext();
  const runtime = createRuntime([rule('no-console', 'console\\.log', { scope: 'tool' })]);
  installToolHooks(ctx, runtime);

  const first = createExec(runtime, { args: { file_path: '/repo/a.ts', new_string: 'console.log(1)' } });
  const firstDecision = await ctx.waterfall('tools/pre-execute', first.exec, async () => ({ kind: 'allow' }));
  assert.equal(firstDecision.kind, 'deny');

  const second = createExec(runtime, { args: { file_path: '/repo/b.ts', new_string: 'console.log(2)' } });
  const secondDecision = await ctx.waterfall('tools/pre-execute', second.exec, async () => ({ kind: 'allow' }));
  assert.deepEqual(secondDecision, { kind: 'allow' });
});

test('没有 agent 的工具调用不参与匹配', async () => {
  const ctx = createContext();
  const runtime = createRuntime([rule('no-console', 'console\\.log', { scope: 'tool' })]);
  installToolHooks(ctx, runtime);

  const decision = await ctx.waterfall(
    'tools/pre-execute',
    { name: 'edit', arguments: { file_path: '/repo/a.ts', new_string: 'console.log(1)' } },
    async () => ({ kind: 'allow' }),
  );
  assert.deepEqual(decision, { kind: 'allow' });
});

test('规则级 globs 门控工具路径', async () => {
  const ctx = createContext();
  const runtime = createRuntime([rule('no-console', 'console\\.log', { scope: 'tool', globs: ['**/*.ts'] })]);
  installToolHooks(ctx, runtime);

  const ts = createExec(runtime, { args: { file_path: '/repo/a.ts', new_string: 'console.log(1)' } });
  assert.equal((await ctx.waterfall('tools/pre-execute', ts.exec, async () => ({ kind: 'allow' }))).kind, 'deny');

  const py = createExec(runtime, { args: { file_path: '/repo/a.py', new_string: 'console.log(1)' }, sessionId: 's2' });
  assert.deepEqual(await ctx.waterfall('tools/pre-execute', py.exec, async () => ({ kind: 'allow' })), { kind: 'allow' });
});

test('#8 验收：tool:edit(*.cpp) 规则同时验证拦截与提醒两条路径', async () => {
  const rules = [
    rule('no-printf', 'printf', { scope: 'tool:edit(*.cpp)', interruptMode: 'always' }),
    rule('no-printf-remind', 'std::cout', { scope: 'tool:edit(*.cpp)', interruptMode: 'never' }),
  ];

  const denyCtx = createContext();
  const denyRuntime = createRuntime([rules[0]]);
  installToolHooks(denyCtx, denyRuntime);
  const deny = createExec(denyRuntime, {
    name: 'edit',
    args: { file_path: '/repo/src/main.cpp', new_string: 'printf("x");' },
  });
  const denied = await denyCtx.waterfall('tools/pre-execute', deny.exec, async () => ({ kind: 'allow' }));
  assert.equal(denied.kind, 'deny');
  assert.match(denied.reason, /no-printf/, '规则正文作为拒绝理由');
  assert.match(denied.reason, /遵守 no-printf。/);

  const remindCtx = createContext();
  const remindRuntime = createRuntime([rules[1]]);
  installToolHooks(remindCtx, remindRuntime);
  const remind = createExec(remindRuntime, {
    name: 'edit',
    args: { file_path: '/repo/src/main.cpp', new_string: 'std::cout << "x";' },
  });
  const accepted = await remindCtx.waterfall('tools/post-execute', remind.exec, {}, async () => ({ kind: 'accept' }));
  assert.equal(accepted.kind, 'accept');
  assert.equal(accepted.additionalContexts.length, 1);
  assert.match(accepted.additionalContexts[0].content[0].text, /rule="no-printf-remind"/);

  const py = createExec(remindRuntime, {
    name: 'edit',
    args: { file_path: '/repo/src/main.py', new_string: 'std::cout << "x";' },
    sessionId: 's2',
  });
  assert.deepEqual(
    await remindCtx.waterfall('tools/post-execute', py.exec, {}, async () => ({ kind: 'accept' })),
    { kind: 'accept' },
    '非 .cpp 文件不命中',
  );
});
