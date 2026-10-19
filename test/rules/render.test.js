import assert from 'node:assert/strict';
import test from 'node:test';

import { renderAlwaysApply, renderRulebook } from '../../src/rules/render.js';

function rule(name, fields = {}) {
  return {
    name,
    path: `/repo/.agents/rules/${name}.md`,
    body: `遵守 ${name}。`,
    ...fields,
  };
}

test('alwaysApply 空集渲染为空字符串', () => {
  assert.equal(renderAlwaysApply([]), '');
});

test('alwaysApply 用 generic-rules 包裹，规则正文之间空一行', () => {
  const text = renderAlwaysApply([rule('a'), rule('b')]);
  assert.equal(text, ['<generic-rules>', '遵守 a。', '', '遵守 b。', '</generic-rules>'].join('\n'));
});

test('alwaysApply 保持入参顺序且不修改入参', () => {
  const rules = [rule('a'), rule('b')];
  const snapshot = JSON.stringify(rules);
  assert.ok(renderAlwaysApply(rules).indexOf('遵守 a。') < renderAlwaysApply(rules).indexOf('遵守 b。'));
  assert.equal(JSON.stringify(rules), snapshot);
});

test('rulebook 空集渲染为空字符串', () => {
  assert.equal(renderRulebook([]), '');
});

test('rulebook 每条规则一行，带 globs 时列出 glob', () => {
  const text = renderRulebook([
    rule('ts-only', { description: '只用 TypeScript', globs: ['**/*.ts', '**/*.tsx'] }),
    rule('one-glob', { description: '单条 glob', globs: '**/*.js' }),
  ], { cwd: '/repo' });
  assert.equal(
    text,
    [
      '<domain-rules>',
      '- ts-only (**/*.ts, **/*.tsx): 只用 TypeScript — .agents/rules/ts-only.md',
      '- one-glob (**/*.js): 单条 glob — .agents/rules/one-glob.md',
      '</domain-rules>',
    ].join('\n'),
  );
});

test('rulebook 无 globs 时省略括号段', () => {
  const text = renderRulebook([rule('plain', { description: '有说明', globs: [] })], { cwd: '/repo' });
  assert.equal(text, ['<domain-rules>', '- plain: 有说明 — .agents/rules/plain.md', '</domain-rules>'].join('\n'));
});

test('rulebook 路径按 cwd 相对显示，cwd 之外按 home 显示', () => {
  const inside = rule('inside');
  const home = { ...rule('home'), path: '/Users/dev/.agents/rules/home.md' };
  const outside = { ...rule('outside'), path: '/opt/rules/outside.md' };
  const text = renderRulebook(
    [
      { ...inside, description: '项目规则' },
      { ...home, description: '用户规则' },
      { ...outside, description: '其它规则' },
    ],
    { cwd: '/repo', home: '/Users/dev' },
  );
  assert.match(text, /- inside: 项目规则 — \.agents\/rules\/inside\.md/);
  assert.match(text, /- home: 用户规则 — ~\/\.agents\/rules\/home\.md/);
  assert.match(text, /- outside: 其它规则 — \/opt\/rules\/outside\.md/);
});

test('rulebook 保持入参顺序且不修改入参', () => {
  const rules = [
    rule('a', { description: '甲' }),
    rule('b', { description: '乙' }),
  ];
  const snapshot = JSON.stringify(rules);
  const lines = renderRulebook(rules, { cwd: '/repo' }).split('\n');
  assert.deepEqual(lines.slice(1, 3).map((line) => line.slice(2, line.indexOf(':'))), ['a', 'b']);
  assert.equal(JSON.stringify(rules), snapshot);
});
