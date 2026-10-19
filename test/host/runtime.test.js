import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createHostRuntime } from '../../src/host/runtime.js';

/** 最小的 Cordis 上下文替身：记录监听器，按名字派发。 */
function createContext() {
  const listeners = new Map();
  const ctx = {
    logger: { warn() {} },
    on(name, listener) {
      const list = listeners.get(name) ?? [];
      list.push(listener);
      listeners.set(name, list);
      return () => {
        listeners.set(name, list.filter((item) => item !== listener));
      };
    },
    emit(name, ...args) {
      for (const listener of listeners.get(name) ?? []) listener(...args);
    },
    async waterfall(name, payload, inner) {
      const chain = listeners.get(name) ?? [];
      const run = (index) => (index === chain.length ? inner() : chain[index](payload, () => run(index + 1)));
      return run(0);
    },
    agents: { get: () => undefined },
    workingDirectory: { ensure: async () => cwd },
  };
  return { ctx, emit: ctx.emit };
}

let cwd = process.cwd();

async function createWorkspace(files) {
  const root = await mkdtemp(join(tmpdir(), 'agent-rules-host-'));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  return root;
}

function createAgent(sessionId, snapshotEvents = []) {
  return { session: { id: sessionId, snapshotEvents: () => snapshotEvents } };
}

test('attach 发现规则并按桶加载，promptText 渲染正文与清单', async (t) => {
  const root = await createWorkspace({
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.agents/rules/always.md': ['---', 'alwaysApply: true', '---', '', '总是遵守。', ''].join('\n'),
    '.agents/rules/listed.md': ['---', 'description: 按需读取', '---', '', '正文。', ''].join('\n'),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  cwd = root;

  const { ctx } = createContext();
  const runtime = createHostRuntime({ ctx, home: root });
  const agent = createAgent('s1');
  const entry = await runtime.attach(agent);

  assert.equal(entry.cwd, root);
  assert.deepEqual(entry.buckets.alwaysApply.map((rule) => rule.name), ['always']);
  assert.deepEqual(entry.buckets.rulebook.map((rule) => rule.name), ['listed']);

  const text = runtime.promptText(agent);
  assert.match(text, /<generic-rules>\n总是遵守。\n<\/generic-rules>/);
  assert.match(text, /<domain-rules>\n- listed: 按需读取 — \.agents\/rules\/listed\.md\n<\/domain-rules>/);
});

test('没有规则时 promptText 为空字符串', async (t) => {
  const root = await createWorkspace({ '.git/HEAD': 'ref: refs/heads/main\n' });
  t.after(() => rm(root, { recursive: true, force: true }));
  cwd = root;

  const { ctx } = createContext();
  const runtime = createHostRuntime({ ctx, home: root });
  await runtime.attach(createAgent('s1'));
  assert.equal(runtime.promptText(createAgent('s1')), '');
});

test('同一会话重复 attach 复用条目，工作目录变更后重新发现', async (t) => {
  const root = await createWorkspace({
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.agents/rules/first.md': ['---', 'alwaysApply: true', '---', '', '第一版。', ''].join('\n'),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  cwd = root;

  const { ctx, emit } = createContext();
  const runtime = createHostRuntime({ ctx, home: root });
  const agent = createAgent('s1');
  const first = await runtime.attach(agent);
  assert.equal(await runtime.attach(agent), first, '未过期时复用同一条目');

  await writeFile(join(root, '.agents/rules/first.md'), ['---', 'alwaysApply: true', '---', '', '第二版。', ''].join('\n'));
  emit('session/event', { id: 's1' }, { type: 'working-directory/change', data: { cwd: root } });
  const second = await runtime.attach(agent);
  assert.notEqual(second, first);
  assert.match(runtime.promptText(agent), /第二版。/);
});

test('step/start 记录位置，agent/disposed 清理条目', async (t) => {
  const root = await createWorkspace({ '.git/HEAD': 'ref: refs/heads/main\n' });
  t.after(() => rm(root, { recursive: true, force: true }));
  cwd = root;

  const { ctx, emit } = createContext();
  const runtime = createHostRuntime({ ctx, home: root });
  const agent = createAgent('s1');
  await runtime.attach(agent);

  emit('session/event', { id: 's1' }, { type: 'step/start', data: { turn: 2, step: 3 } });
  assert.deepEqual(runtime.position('s1'), { turn: 2, step: 3 });

  emit('agent/disposed', { agent });
  assert.equal(runtime.entry('s1'), undefined);
  assert.equal(runtime.position('s1'), undefined);
});

test('带 condition 的规则进 TTSR 桶，condition 无法编译时回落到 description 桶', async (t) => {
  const root = await createWorkspace({
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.agents/rules/trigger.md': ['---', 'condition: needle', 'description: 命中即中断', '---', '', '正文。', ''].join('\n'),
    '.agents/rules/broken.md': ['---', 'condition: "(["', 'description: 回落到清单', '---', '', '正文。', ''].join('\n'),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  cwd = root;

  const { ctx } = createContext();
  const runtime = createHostRuntime({ ctx, home: root });
  const entry = await runtime.attach(createAgent('s1'));

  assert.deepEqual(entry.buckets.ttsr.map((rule) => rule.name), ['trigger']);
  assert.deepEqual(entry.buckets.rulebook.map((rule) => rule.name), ['broken']);
  assert.equal(entry.ttsr.rules.length, 1);
});

test('surface 里已有的提醒消息在首次加载时重建去重集合', async (t) => {
  const root = await createWorkspace({
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.agents/rules/no-console.md': ['---', 'condition: "console\\\\.log"', 'scope: tool', '---', '', '禁止 console.log。', ''].join('\n'),
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  cwd = root;

  const reminder = {
    type: 'user/message',
    seq: 4,
    time: 0,
    data: {
      id: 'reminder-1',
      role: 'user',
      content: [{ type: 'text', text: '<system-reminder reason="rule_violation" rule="no-console" path="x">' }],
      source: { kind: 'agent-rules', form: 'notice' },
    },
    surfaceOp: 'append',
  };

  const { ctx } = createContext();
  const runtime = createHostRuntime({ ctx, home: root });
  const agent = createAgent('s1', [reminder]);
  const entry = await runtime.attach(agent);

  assert.deepEqual(
    entry.ttsr.session('s1').matchToolCall({ tool: 'edit', args: { file_path: join(root, 'a.ts'), new_string: 'console.log(1)' } }),
    [],
  );
});
