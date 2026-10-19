import assert from 'node:assert/strict';
import test from 'node:test';

import { compileRules, ruleId } from '../../src/ttsr/rules.js';

const silent = { warn() {} };

function createLog() {
  const warnings = [];
  return { warnings, warn(message) { warnings.push(message); } };
}

const RULE = {
  name: 'no-tabs',
  path: '/repo/.agents/rules/no-tabs.md',
  body: 'Use spaces instead of tabs.',
  condition: '\\t',
};

test('没有 condition 的规则不注册', () => {
  const log = createLog();
  const rules = compileRules([{ ...RULE, condition: undefined }], log);
  assert.equal(rules.length, 0);
  assert.equal(log.warnings.length, 0);
});

test('condition 数组里任一条命中即算命中', () => {
  const rules = compileRules([{ ...RULE, condition: ['no-tab', '\\t'] }], createLog());
  assert.equal(rules.length, 1);
  assert.equal(rules[0].conditions.length, 2);
});

test('condition 无法编译时跳过该条并记 warning', () => {
  const log = createLog();
  const rules = compileRules([{ ...RULE, condition: '([' }], log);
  assert.equal(rules.length, 0);
  assert.match(log.warnings[0], /无法编译/);
});

test('同名规则 first-wins，后者被忽略并记 warning', () => {
  const log = createLog();
  const rules = compileRules(
    [{ ...RULE, condition: 'first' }, { ...RULE, condition: 'second' }],
    log,
  );
  assert.equal(rules.length, 1);
  assert.equal(rules[0].conditions[0].source, 'first');
  assert.match(log.warnings[0], /同名/);
});

test('scope 缺省为正文开、思考关、任意工具开', () => {
  const [rule] = compileRules([RULE], createLog());
  assert.equal(rule.scope.text, true);
  assert.equal(rule.scope.thinking, false);
  assert.deepEqual(rule.scope.tools, [{ name: null, glob: null }]);
});

test('scope 支持 text / thinking / tool:<name> 与大小写不敏感', () => {
  const [rule] = compileRules([{ ...RULE, scope: 'TEXT, Thinking, Tool:Edit' }], createLog());
  assert.equal(rule.scope.text, true);
  assert.equal(rule.scope.thinking, true);
  assert.equal(rule.scope.tools.length, 1);
  assert.equal(rule.scope.tools[0].name, 'edit');
  assert.equal(rule.scope.tools[0].glob, null);
});

test('scope 的 tool:<name>(<glob>) 带花括号时不被逗号切开', () => {
  const [rule] = compileRules([{ ...RULE, scope: 'tool:edit(*.{ts,tsx})' }], createLog());
  assert.equal(rule.scope.tools.length, 1);
  assert.equal(rule.scope.tools[0].name, 'edit');
  assert.equal(rule.scope.tools[0].glob('src/a.ts'), true);
  assert.equal(rule.scope.tools[0].glob('src/a.tsx'), true);
  assert.equal(rule.scope.tools[0].glob('src/a.js'), false);
});

test('无法识别的 scope 项记 warning 后跳过', () => {
  const log = createLog();
  const [rule] = compileRules([{ ...RULE, scope: 'text, nope' }], log);
  assert.equal(rule.scope.text, true);
  assert.equal(rule.scope.tools.length, 0);
  assert.match(log.warnings[0], /无法识别/);
});

test('scope 里的 glob 编译失败时跳过该项并记 warning', () => {
  const log = createLog();
  const [rule] = compileRules([{ ...RULE, scope: 'text, tool:edit([z-a])' }], log);
  assert.equal(rule.scope.text, true);
  assert.equal(rule.scope.tools.length, 0);
  assert.match(log.warnings[0], /scope glob 无法编译/);
});

test('空 scope glob 不留永不命中的规则', () => {
  const log = createLog();
  assert.equal(compileRules([{ ...RULE, scope: 'tool:edit()' }], log).length, 0);
  assert.match(log.warnings[0], /scope glob 为空/);
  assert.match(log.warnings.at(-1), /不匹配任何流/);
});

test('scope 不匹配任何流时规则不注册', () => {
  const log = createLog();
  const rules = compileRules([{ ...RULE, scope: 'nope' }], log);
  assert.equal(rules.length, 0);
  assert.match(log.warnings.at(-1), /不匹配任何流/);
});

test('scope 显式为空时不回退到默认值', () => {
  const log = createLog();
  assert.equal(compileRules([{ ...RULE, scope: [] }], log).length, 0);
  assert.equal(compileRules([{ ...RULE, scope: '' }], createLog()).length, 0);
});

test('规则级 globs 关闭正文与思考流', () => {
  const [rule] = compileRules([{ ...RULE, scope: 'text, thinking, tool', globs: ['**/*.ts'] }], createLog());
  assert.equal(rule.scope.text, false);
  assert.equal(rule.scope.thinking, false);
  assert.equal(rule.globs?.('src/a.ts'), true);
  assert.equal(rule.globs?.('src/a.py'), false);
});

test('interruptMode 缺省为 always，无法识别的值记 warning 后回退', () => {
  const [fallback] = compileRules([RULE], createLog());
  assert.equal(fallback.interruptMode, 'always');

  const log = createLog();
  const [rule] = compileRules([{ ...RULE, interruptMode: 'sometimes' }], log);
  assert.equal(rule.interruptMode, 'always');
  assert.match(log.warnings[0], /interruptMode/);
});

test('注入与错误码用的 id 去掉引号、逗号与换行', () => {
  assert.equal(ruleId('a,b"c\nd'), 'a_b_c_d');
});

test('开头的 PCRE 内联旗标转成 RegExp flags', () => {
  const rules = compileRules(
    [
      { name: 'case-insensitive', path: '/r/a.md', body: '', condition: '(?i)system_libs' },
      { name: 'multi', path: '/r/b.md', body: '', condition: '(?ims)a.b' },
    ],
    silent,
  );
  assert.equal(rules.length, 2);
  assert.equal(rules[0].conditions[0].flags, 'i');
  assert.ok(rules[0].conditions[0].test('SYSTEM_LIBS'));
  assert.equal(rules[1].conditions[0].flags, 'ims');
});

test('非开头的内联旗标不翻译，按原生规则报错', () => {
  const warnings = [];
  const rules = compileRules(
    [{ name: 'mid', path: '/r/c.md', body: '', condition: 'a(?i)b' }],
    { warn: (message) => warnings.push(message) },
  );
  assert.deepEqual(rules, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /无法编译/);
});

test('不支持的旗标原样传给 RegExp', () => {
  const warnings = [];
  const rules = compileRules(
    [{ name: 'bad-flag', path: '/r/d.md', body: '', condition: '(?x)abc' }],
    { warn: (message) => warnings.push(message) },
  );
  assert.deepEqual(rules, []);
  assert.match(warnings[0], /无法编译/);
});
