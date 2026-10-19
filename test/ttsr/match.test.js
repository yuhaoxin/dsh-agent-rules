import assert from 'node:assert/strict';
import test from 'node:test';

import { createTextMatcher, extractCandidatePaths, matchToolCall } from '../../src/ttsr/match.js';
import { compileRules } from '../../src/ttsr/rules.js';

const RULE = {
  name: 'needle-rule',
  path: '/repo/.agents/rules/needle-rule.md',
  body: 'Do not emit the needle.',
  condition: 'needle',
};

function compile(descriptor) {
  return compileRules([descriptor], { warn() {} });
}

function matcherFor(descriptor) {
  return createTextMatcher(compile(descriptor), { isReminded: () => false });
}

test('累积文本命中 condition', () => {
  const matcher = matcherFor(RULE);
  assert.deepEqual(matcher.push('nee', 'text'), []);
  assert.deepEqual(matcher.push('dle', 'text').map((rule) => rule.id), ['needle-rule']);
});

test('思考流默认不参与匹配，scope 打开后才参与', () => {
  assert.deepEqual(matcherFor(RULE).push('needle', 'thinking'), []);
  assert.deepEqual(matcherFor({ ...RULE, scope: 'thinking' }).push('needle', 'thinking').map((rule) => rule.id), [
    'needle-rule',
  ]);
});

test('同一次 attempt 内同一条规则只上报一次', () => {
  const matcher = matcherFor(RULE);
  assert.equal(matcher.push('needle', 'text').length, 1);
  assert.equal(matcher.push('needle', 'text').length, 0);
});

test('超过 4096 字符后按 25% 增长节流，达到阈值才重扫', () => {
  const matcher = matcherFor(RULE);
  assert.deepEqual(matcher.push('x'.repeat(5000), 'text'), []);
  assert.deepEqual(matcher.push(`needle${'x'.repeat(1000)}`, 'text'), []);
  assert.deepEqual(matcher.push('x'.repeat(300), 'text').map((rule) => rule.id), ['needle-rule']);
});

test('final() 强制全扫，补上被节流推迟的命中', () => {
  const matcher = matcherFor(RULE);
  assert.deepEqual(matcher.push('x'.repeat(5000), 'text'), []);
  assert.deepEqual(matcher.push('needle', 'text'), []);
  assert.deepEqual(matcher.final().map((rule) => rule.id), ['needle-rule']);
});

test('恰好 4096 字符时仍然每次重扫', () => {
  const matcher = matcherFor(RULE);
  assert.deepEqual(matcher.push('x'.repeat(4090), 'text'), []);
  assert.deepEqual(matcher.push('needle', 'text').map((rule) => rule.id), ['needle-rule']);
});

test('恰好增长 25% 时重扫，差一个字符不扫', () => {
  const atThreshold = matcherFor(RULE);
  atThreshold.push('x'.repeat(4096), 'text');
  // 4096 × 1.25 = 5120
  assert.deepEqual(atThreshold.push(`needle${'x'.repeat(1018)}`, 'text').map((rule) => rule.id), ['needle-rule']);

  const belowThreshold = matcherFor(RULE);
  belowThreshold.push('x'.repeat(4096), 'text');
  assert.deepEqual(belowThreshold.push(`needle${'x'.repeat(1017)}`, 'text'), []);
  assert.deepEqual(belowThreshold.final().map((rule) => rule.id), ['needle-rule']);
});

test('已经提醒过的规则不再命中', () => {
  const rules = compile(RULE);
  const matcher = createTextMatcher(rules, { isReminded: () => true });
  assert.deepEqual(matcher.push('needle', 'text'), []);
  assert.deepEqual(matcher.final(), []);
});

test('工具 scope 按工具名与路径 glob 过滤，condition 匹配参数 JSON', () => {
  const rules = compile({ ...RULE, scope: 'tool:edit(*.ts)', condition: 'console\\.log' });
  const hit = matchToolCall(rules, {
    tool: 'Edit',
    args: { file_path: 'src/a.ts', new_string: 'console.log(1)' },
    cwd: '/repo',
  });
  assert.equal(hit.length, 1);

  const otherTool = matchToolCall(rules, {
    tool: 'Write',
    args: { file_path: 'src/a.ts', content: 'console.log(1)' },
    cwd: '/repo',
  });
  assert.equal(otherTool.length, 0);

  const otherPath = matchToolCall(rules, {
    tool: 'Edit',
    args: { file_path: 'src/a.js', new_string: 'console.log(1)' },
    cwd: '/repo',
  });
  assert.equal(otherPath.length, 0);
});

test('规则级 globs 对工具 scope 是全局门控', () => {
  const rules = compile({ ...RULE, scope: 'tool', globs: ['**/*.ts'], condition: 'TODO' });
  assert.equal(
    matchToolCall(rules, { tool: 'edit', args: { file_path: 'src/a.ts', new_string: '// TODO' }, cwd: '/repo' }).length,
    1,
  );
  assert.equal(
    matchToolCall(rules, { tool: 'edit', args: { file_path: 'src/a.py', new_string: '# TODO' }, cwd: '/repo' }).length,
    0,
  );
});

test('候选路径覆盖 path / file_path / paths / filePaths 四种键名', () => {
  const args = {
    path: './a.ts',
    file_path: 'b.ts',
    paths: ['c.ts'],
    filePaths: ['d.ts'],
    content: '/tmp/e.ts',
  };
  const candidates = extractCandidatePaths(args, '/repo');
  for (const expected of ['a.ts', 'b.ts', 'c.ts', 'd.ts', '/repo/a.ts', '/repo/b.ts']) {
    assert.ok(candidates.includes(expected), `缺少候选路径 ${expected}`);
  }
  assert.equal(candidates.includes('/tmp/e.ts'), false);
});
