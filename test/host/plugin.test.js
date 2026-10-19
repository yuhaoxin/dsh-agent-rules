import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER } from '../../src/host/runtime.js';
import { apply } from '../../index.js';

/**
 * 插件上下文替身：记录 section 注册与监听器，按 Cordis 的 `(…args, next)` 形态
 * 串起 waterfall。`system-prompt/assemble` 的返回值形状与 DSH 一致：`{ sections }`。
 */
function createContext(cwd) {
  const listeners = new Map();
  const sections = [];
  return {
    logger: { warn() {} },
    systemPrompt: {
      section(definition) {
        sections.push(definition);
      },
    },
    workingDirectory: { ensure: async () => cwd },
    agents: { get: () => undefined },
    on(name, listener) {
      const list = listeners.get(name) ?? [];
      list.push(listener);
      listeners.set(name, list);
    },
    sections,
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

/**
 * 临时工作区与临时用户目录。`homedir()` 在 `apply()` 里求值，所以测试把 HOME
 * 指到空目录，避免读到运行测试的机器上的真实用户规则。
 */
async function createWorkspace() {
  const root = await mkdtemp(join(tmpdir(), 'agent-rules-plugin-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-rules-home-'));
  await mkdir(join(root, '.git'), { recursive: true });
  await mkdir(join(root, '.agents', 'rules'), { recursive: true });
  await writeFile(
    join(root, '.agents', 'rules', 'always.md'),
    ['---', 'alwaysApply: true', '---', '', '总是遵守。', ''].join('\n'),
    'utf8',
  );
  await writeFile(
    join(root, '.agents', 'rules', 'listed.md'),
    ['---', 'description: 按需读取', '---', '', '正文。', ''].join('\n'),
    'utf8',
  );
  return { root, home };
}

/** 在给定的 HOME 下运行回调，结束后恢复。 */
async function withHome(home, run) {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return await run();
  } finally {
    process.env.HOME = previous;
  }
}

function createAgent(sessionId) {
  return { session: { id: sessionId, snapshotEvents: () => [] } };
}

/** 构造 DSH 组装结果的最小形状：sections 带注册名与初始正文。 */
function createAssembly(ctx) {
  return {
    sections: ctx.sections.map((definition) => ({ name: definition.name, text: definition.text({}) })),
  };
}

test('apply 注册 agent-rules section 与三条路径的监听器', async (t) => {
  const { root, home } = await createWorkspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));

  const ctx = createContext(root);
  await withHome(home, () => apply(ctx, {}));

  assert.equal(ctx.sections.length, 1);
  assert.equal(ctx.sections[0].name, PROMPT_SECTION_NAME);
  assert.equal(ctx.sections[0].order, PROMPT_SECTION_ORDER);
  assert.equal(typeof ctx.sections[0].text, 'function');
});

test('assemble 加载规则并回填 section 正文', async (t) => {
  const { root, home } = await createWorkspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));

  const ctx = createContext(root);
  await withHome(home, () => apply(ctx, {}));
  const agent = createAgent('s1');
  const assembly = createAssembly(ctx);

  const assembled = await ctx.waterfall(
    'system-prompt/assemble',
    assembly,
    { agent, signal: undefined },
    async () => assembly,
  );

  const section = assembled.sections.find((entry) => entry.name === PROMPT_SECTION_NAME);
  assert.match(section.text, /<generic-rules>\n总是遵守。\n<\/generic-rules>/);
  assert.match(section.text, /<domain-rules>\n- listed: 按需读取 — \.agents\/rules\/listed\.md\n<\/domain-rules>/);
});

test('assemble 在没有 agent 时原样返回，不改 section', async (t) => {
  const { root, home } = await createWorkspace();
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));

  const ctx = createContext(root);
  await withHome(home, () => apply(ctx, {}));
  const assembly = createAssembly(ctx);

  const assembled = await ctx.waterfall('system-prompt/assemble', assembly, {}, async () => assembly);
  assert.equal(assembled.sections[0].text, '');
});

test('directories 配置追加规则目录', async (t) => {
  const { root, home } = await createWorkspace();
  const extra = await mkdtemp(join(tmpdir(), 'agent-rules-extra-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(home, { recursive: true, force: true }));
  t.after(() => rm(extra, { recursive: true, force: true }));
  await writeFile(
    join(extra, 'extra.md'),
    ['---', 'alwaysApply: true', '---', '', '来自额外目录。', ''].join('\n'),
    'utf8',
  );

  const ctx = createContext(root);
  await withHome(home, () => apply(ctx, { directories: [extra] }));
  const agent = createAgent('s1');
  const assembly = createAssembly(ctx);

  const assembled = await ctx.waterfall(
    'system-prompt/assemble',
    assembly,
    { agent, signal: undefined },
    async () => assembly,
  );
  const section = assembled.sections.find((entry) => entry.name === PROMPT_SECTION_NAME);
  assert.match(section.text, /来自额外目录。/);
});
