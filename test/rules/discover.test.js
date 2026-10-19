import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { discoverRules } from '../../src/rules/discover.js';

/**
 * 临时工作区：root 下建 home 与若干目录，测试结束删除整棵树。
 *
 * `git` 为 true 时在 root 放一个 `.git`，把项目级向上遍历限制在工作区内；
 * 临时目录的真实祖先目录可能带规则目录，不设边界会让断言依赖机器环境。
 */
async function createWorkspace(t, { git = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agent-rules-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = {
    root,
    home: join(root, 'home'),
    async mkdir(...segments) {
      const directory = join(...segments);
      await mkdir(directory, { recursive: true });
      return directory;
    },
    async rule(file, frontmatter = '', body = '正文') {
      await mkdir(join(file, '..'), { recursive: true });
      const text = frontmatter.length > 0 ? ['---', frontmatter, '---', body].join('\n') : body;
      await writeFile(file, text, 'utf8');
      return file;
    },
    async discover(options = {}) {
      const warnings = [];
      const result = await discoverRules({
        cwd: root,
        home: workspace.home,
        log: { warn(message) { warnings.push(message); } },
        ...options,
      });
      return { ...result, warnings };
    },
  };
  await workspace.mkdir(workspace.home);
  if (git) await workspace.mkdir(root, '.git');
  return workspace;
}

test('项目级目录从 cwd 向上逐层扫描，找到 .git 即停', async (t) => {
  const workspace = await createWorkspace(t);
  const outer = await workspace.mkdir(workspace.root, 'outer');
  const project = await workspace.mkdir(outer, 'project');
  await workspace.mkdir(project, '.git');
  const app = await workspace.mkdir(project, 'pkg', 'app');

  await workspace.rule(join(outer, '.agents', 'rules', 'outer.md'));
  await workspace.rule(join(project, '.agent', 'rules', 'project-agent.md'));
  await workspace.rule(join(project, '.agents', 'rules', 'project-agents.md'));
  await workspace.rule(join(project, 'pkg', '.agents', 'rules', 'pkg.md'));
  await workspace.rule(join(app, '.agent', 'rules', 'app.md'));

  const { rules, warnings } = await workspace.discover({ cwd: app });
  assert.deepEqual(rules.map((rule) => rule.name), ['app', 'pkg', 'project-agent', 'project-agents']);
  assert.deepEqual(warnings, []);
  for (const rule of rules) assert.equal(rule.level, 'project');
});

test('没有 .git 时向上走到文件系统根目录', async (t) => {
  const workspace = await createWorkspace(t, { git: false });
  const project = await workspace.mkdir(workspace.root, 'no-git');
  const app = await workspace.mkdir(project, 'app');
  const file = await workspace.rule(join(workspace.root, '.agents', 'rules', 'root.md'));

  const { rules } = await workspace.discover({ cwd: app });
  const found = rules.filter((rule) => rule.path.startsWith(workspace.root));
  assert.deepEqual(found.map((rule) => rule.name), ['root']);
  assert.equal(found[0].path, file);
  assert.equal(found[0].level, 'project');
});

test('同一层 .agent/rules 先于 .agents/rules，同名规则 first-wins 并记 warning', async (t) => {
  const workspace = await createWorkspace(t);
  const project = await workspace.mkdir(workspace.root, 'project');
  await workspace.mkdir(project, '.git');
  const first = await workspace.rule(join(project, '.agent', 'rules', 'dup.md'), 'description: 先');
  await workspace.rule(join(project, '.agents', 'rules', 'dup.md'), 'description: 后');

  const { rules, warnings } = await workspace.discover({ cwd: project });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].path, first);
  assert.equal(rules[0].description, '先');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /同名/);
  assert.match(warnings[0], /dup/);
});

test('离 cwd 更近的项目级规则优先于更上层的同名规则', async (t) => {
  const workspace = await createWorkspace(t);
  const project = await workspace.mkdir(workspace.root, 'project');
  await workspace.mkdir(project, '.git');
  const app = await workspace.mkdir(project, 'app');
  const near = await workspace.rule(join(app, '.agents', 'rules', 'dup.md'), 'description: 近');
  await workspace.rule(join(project, '.agents', 'rules', 'dup.md'), 'description: 远');

  const { rules, warnings } = await workspace.discover({ cwd: app });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].path, near);
  assert.equal(rules[0].description, '近');
  assert.match(warnings[0], /同名/);
});

test('向上遍历跳过 home 目录本身，home 下的规则按用户级发现', async (t) => {
  const workspace = await createWorkspace(t);
  await workspace.mkdir(workspace.home, '.git');
  const app = await workspace.mkdir(workspace.home, 'work', 'app');
  await workspace.rule(join(workspace.home, '.agents', 'rules', 'user.md'));

  const { rules } = await workspace.discover({ cwd: app });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].name, 'user');
  assert.equal(rules[0].level, 'user');
});

test('用户级 ~/.agent/rules 先于 ~/.agents/rules', async (t) => {
  const workspace = await createWorkspace(t);
  const first = await workspace.rule(join(workspace.home, '.agent', 'rules', 'dup.md'), 'description: agent');
  await workspace.rule(join(workspace.home, '.agents', 'rules', 'dup.md'), 'description: agents');

  const { rules, warnings } = await workspace.discover();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].path, first);
  assert.equal(rules[0].level, 'user');
  assert.match(warnings[0], /同名/);
});

test('项目级规则先于用户级规则', async (t) => {
  const workspace = await createWorkspace(t);
  const project = await workspace.mkdir(workspace.root, 'project');
  await workspace.mkdir(project, '.git');
  const projectRule = await workspace.rule(join(project, '.agents', 'rules', 'dup.md'), 'description: 项目');
  await workspace.rule(join(workspace.home, '.agents', 'rules', 'dup.md'), 'description: 用户');

  const { rules } = await workspace.discover({ cwd: project });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].path, projectRule);
  assert.equal(rules[0].level, 'project');
});

test('只收目录直接子文件里的 .md 与 .mdc，按文件名排序', async (t) => {
  const workspace = await createWorkspace(t);
  const project = await workspace.mkdir(workspace.root, 'project');
  await workspace.mkdir(project, '.git');
  const rulesDirectory = join(project, '.agents', 'rules');
  await workspace.rule(join(rulesDirectory, 'b.mdc'));
  await workspace.rule(join(rulesDirectory, 'a.md'));
  await workspace.rule(join(rulesDirectory, 'note.txt'));
  await workspace.rule(join(rulesDirectory, 'nested', 'deep.md'));

  const { rules } = await workspace.discover({ cwd: project });
  assert.deepEqual(rules.map((rule) => rule.name), ['a', 'b']);
  assert.deepEqual(rules.map((rule) => rule.path), [join(rulesDirectory, 'a.md'), join(rulesDirectory, 'b.mdc')]);
});

test('符号链接的规则文件按目标内容读取', async (t) => {
  const workspace = await createWorkspace(t);
  const project = await workspace.mkdir(workspace.root, 'project');
  await workspace.mkdir(project, '.git');
  const target = await workspace.rule(join(workspace.root, 'shared', 'linked.md'), 'description: 链接');
  const rulesDirectory = await workspace.mkdir(project, '.agents', 'rules');
  await symlink(target, join(rulesDirectory, 'linked.md'));

  const { rules } = await workspace.discover({ cwd: project });
  assert.deepEqual(rules.map((rule) => rule.name), ['linked']);
  assert.equal(rules[0].description, '链接');
  assert.equal(rules[0].path, join(rulesDirectory, 'linked.md'));
});

test('失效的符号链接记 warning 后跳过，不影响其它规则', async (t) => {
  const workspace = await createWorkspace(t);
  const project = await workspace.mkdir(workspace.root, 'project');
  await workspace.mkdir(project, '.git');
  const rulesDirectory = await workspace.mkdir(project, '.agents', 'rules');
  await symlink(join(workspace.root, 'missing.md'), join(rulesDirectory, 'broken.md'));
  await workspace.rule(join(rulesDirectory, 'ok.md'));

  const { rules, warnings } = await workspace.discover({ cwd: project });
  assert.deepEqual(rules.map((rule) => rule.name), ['ok']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /规则文件读取失败/);
  assert.match(warnings[0], /broken\.md/);
});

test('空规则目录产出空结果且不记 warning', async (t) => {
  const workspace = await createWorkspace(t);
  const project = await workspace.mkdir(workspace.root, 'project');
  await workspace.mkdir(project, '.git');
  await workspace.mkdir(project, '.agents', 'rules');

  const { rules, warnings } = await workspace.discover({ cwd: project });
  assert.deepEqual(rules, []);
  assert.deepEqual(warnings, []);
});

test('规则目录缺失不算错误', async (t) => {
  const workspace = await createWorkspace(t);
  const project = await workspace.mkdir(workspace.root, 'project');
  await workspace.mkdir(project, '.git');

  const { rules, warnings } = await workspace.discover({ cwd: project });
  assert.deepEqual(rules, []);
  assert.deepEqual(warnings, []);
});

test('enabled: false 在去重前丢弃，不占用同名规则', async (t) => {
  const workspace = await createWorkspace(t);
  const project = await workspace.mkdir(workspace.root, 'project');
  await workspace.mkdir(project, '.git');
  const app = await workspace.mkdir(project, 'app');
  await workspace.rule(join(app, '.agents', 'rules', 'dup.md'), 'enabled: false');
  const enabled = await workspace.rule(join(project, '.agents', 'rules', 'dup.md'), 'description: 保留');

  const { rules, warnings } = await workspace.discover({ cwd: app });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].path, enabled);
  assert.deepEqual(warnings, []);
});

test('enabled 只有严格 false 才丢弃', async (t) => {
  const workspace = await createWorkspace(t);
  const project = await workspace.mkdir(workspace.root, 'project');
  await workspace.mkdir(project, '.git');
  await workspace.rule(join(project, '.agents', 'rules', 'quoted.md'), 'enabled: "false"');
  await workspace.rule(join(project, '.agents', 'rules', 'true.md'), 'enabled: true');

  const { rules } = await workspace.discover({ cwd: project });
  assert.deepEqual(rules.map((rule) => rule.name), ['quoted', 'true']);
});

test('extraDirectories 追加在用户级之后，支持 ~ 展开', async (t) => {
  const workspace = await createWorkspace(t);
  const userRule = await workspace.rule(join(workspace.home, '.agents', 'rules', 'dup.md'), 'description: 用户');
  await workspace.mkdir(workspace.home, 'extra-rules');
  await workspace.rule(join(workspace.home, 'extra-rules', 'dup.md'), 'description: 额外');
  await workspace.rule(join(workspace.home, 'extra-rules', 'only-extra.md'));

  const { rules, warnings } = await workspace.discover({ extraDirectories: ['~/extra-rules'] });
  assert.deepEqual(rules.map((rule) => rule.name), ['dup', 'only-extra']);
  assert.equal(rules[0].path, userRule);
  assert.equal(rules[1].level, 'user');
  assert.match(warnings[0], /同名/);
});

test('extraDirectories 的相对路径按 cwd 解析', async (t) => {
  const workspace = await createWorkspace(t);
  const project = await workspace.mkdir(workspace.root, 'project');
  await workspace.mkdir(project, '.git');
  await workspace.rule(join(project, 'shared-rules', 'relative.md'));

  const { rules } = await workspace.discover({ cwd: project, extraDirectories: ['shared-rules'] });
  assert.deepEqual(rules.map((rule) => rule.name), ['relative']);
});

test('描述符字段按 frontmatter 归一', async (t) => {
  const workspace = await createWorkspace(t);
  const project = await workspace.mkdir(workspace.root, 'project');
  await workspace.mkdir(project, '.git');
  const file = await workspace.rule(
    join(project, '.agents', 'rules', 'full.md'),
    [
      'description: "  只用 TypeScript  "',
      'always-apply: true',
      'globs: [**/*.ts, "**/*.tsx"]',
      'condition:',
      '  - TODO',
      '  - TODO',
      '  - FIXME',
      'ast-condition: regex',
      'question: 为什么',
      "scope: 'tool:edit(*.{ts,tsx}), text, text'",
      'interrupt-mode: prose-only',
      'agents: Claude, Codex',
      'unknown: 保留',
    ].join('\n'),
    '  正文  ',
  );

  const { rules } = await workspace.discover({ cwd: project });
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0], {
    name: 'full',
    path: file,
    body: '正文',
    description: '只用 TypeScript',
    alwaysApply: true,
    globs: ['**/*.ts', '**/*.tsx'],
    condition: ['TODO', 'FIXME'],
    astCondition: ['regex'],
    question: '为什么',
    scope: ['tool:edit(*.{ts,tsx})', 'text'],
    interruptMode: 'prose-only',
    agents: ['claude', 'codex'],
    level: 'project',
  });
});

test('缺省字段：description/question/condition 为空时是 undefined，alwaysApply 默认 false', async (t) => {
  const workspace = await createWorkspace(t);
  const project = await workspace.mkdir(workspace.root, 'project');
  await workspace.mkdir(project, '.git');
  await workspace.rule(
    join(project, '.agents', 'rules', 'blank.md'),
    ['description: "   "', 'question:', 'condition: []', 'always-apply: "true"'].join('\n'),
  );

  const { rules } = await workspace.discover({ cwd: project });
  const [rule] = rules;
  assert.equal(rule.description, undefined);
  assert.equal(rule.question, undefined);
  assert.equal(rule.condition, undefined);
  assert.equal(rule.alwaysApply, false);
  assert.equal(rule.globs, undefined);
  assert.equal(rule.scope, undefined);
  assert.equal(rule.interruptMode, undefined);
  assert.equal(rule.agents, undefined);
});

test('globs 保留单字符串与显式空数组', async (t) => {
  const workspace = await createWorkspace(t);
  const project = await workspace.mkdir(workspace.root, 'project');
  await workspace.mkdir(project, '.git');
  await workspace.rule(join(project, '.agents', 'rules', 'single.md'), 'globs: "**/*.js"');
  await workspace.rule(join(project, '.agents', 'rules', 'empty.md'), 'globs: []');

  const { rules } = await workspace.discover({ cwd: project });
  const globs = Object.fromEntries(rules.map((rule) => [rule.name, rule.globs]));
  assert.deepEqual(globs, { empty: [], single: '**/*.js' });
});

test('旧键 ttsr_trigger 与 ttsr-trigger 都作为 condition', async (t) => {
  const workspace = await createWorkspace(t);
  const project = await workspace.mkdir(workspace.root, 'project');
  await workspace.mkdir(project, '.git');
  await workspace.rule(join(project, '.agents', 'rules', 'snake.md'), 'ttsr_trigger: needle');
  await workspace.rule(join(project, '.agents', 'rules', 'kebab.md'), 'ttsr-trigger: [a, b]');

  const { rules } = await workspace.discover({ cwd: project });
  const conditions = Object.fromEntries(rules.map((rule) => [rule.name, rule.condition]));
  assert.deepEqual(conditions, { kebab: ['a', 'b'], snake: ['needle'] });
});

test('坏 interruptMode 置 undefined 并记 warning', async (t) => {
  const workspace = await createWorkspace(t);
  const project = await workspace.mkdir(workspace.root, 'project');
  await workspace.mkdir(project, '.git');
  await workspace.rule(join(project, '.agents', 'rules', 'bad.md'), 'interrupt-mode: sometimes');

  const { rules, warnings } = await workspace.discover({ cwd: project });
  assert.equal(rules[0].interruptMode, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /interruptMode/);
  assert.match(warnings[0], /bad/);
});

test('frontmatter 解析失败的文件仍产出规则并记 warning', async (t) => {
  const workspace = await createWorkspace(t);
  const project = await workspace.mkdir(workspace.root, 'project');
  await workspace.mkdir(project, '.git');
  await workspace.rule(
    join(project, '.agents', 'rules', 'broken.md'),
    ['description: "未闭合', 'condition: needle'].join('\n'),
  );

  const { rules, warnings } = await workspace.discover({ cwd: project });
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].condition, ['needle']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /frontmatter 解析失败/);
  assert.match(warnings[0], /broken\.md/);
});
