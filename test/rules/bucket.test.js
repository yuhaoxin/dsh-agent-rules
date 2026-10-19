import assert from 'node:assert/strict';
import test from 'node:test';

import { bucketRules } from '../../src/rules/bucket.js';

function createLog() {
  const warnings = [];
  return { warnings, warn(message) { warnings.push(message); } };
}

function rule(name, fields = {}) {
  return {
    name,
    path: `/repo/.agents/rules/${name}.md`,
    body: `遵守 ${name}。`,
    ...fields,
  };
}

test('有 condition 的规则只进 TTSR 桶，优先于 alwaysApply 与 description', () => {
  const log = createLog();
  const target = rule('no-tabs', { condition: '\\t', alwaysApply: true, description: '不要用制表符' });
  const buckets = bucketRules([target], { log });
  assert.deepEqual(buckets.ttsr, [target]);
  assert.deepEqual(buckets.alwaysApply, []);
  assert.deepEqual(buckets.rulebook, []);
  assert.deepEqual(log.warnings, []);
});

test('isTtsrAccepted 放行时才进 TTSR 桶', () => {
  const target = rule('no-tabs', { condition: '\\t' });
  const accepted = [];
  const buckets = bucketRules([target], {
    isTtsrAccepted: (candidate) => {
      accepted.push(candidate.name);
      return true;
    },
  });
  assert.deepEqual(accepted, ['no-tabs']);
  assert.deepEqual(buckets.ttsr, [target], '放行的规则真的进了 TTSR 桶');
});

test('isTtsrAccepted 拒绝时按 alwaysApply、rulebook 顺序回落', () => {
  const always = rule('always', { condition: 'x', alwaysApply: true });
  const described = rule('described', { condition: 'y', description: '有说明' });
  const buckets = bucketRules([always, described], { isTtsrAccepted: () => false });
  assert.deepEqual(buckets.ttsr, []);
  assert.deepEqual(buckets.alwaysApply, [always]);
  assert.deepEqual(buckets.rulebook, [described]);
});

test('alwaysApply 优先于 description', () => {
  const target = rule('both', { alwaysApply: true, description: '有说明' });
  const buckets = bucketRules([target]);
  assert.deepEqual(buckets.alwaysApply, [target]);
  assert.deepEqual(buckets.rulebook, []);
});

test('没有触发条件时 alwaysApply 为 true 才进 alwaysApply 桶', () => {
  const buckets = bucketRules([rule('strict', { alwaysApply: 'true' }), rule('no-flag')]);
  assert.deepEqual(buckets.alwaysApply, []);
  assert.deepEqual(buckets.rulebook, []);
});

test('剩下 description 非空的规则进 rulebook 桶', () => {
  const target = rule('described', { description: '有说明' });
  const buckets = bucketRules([target]);
  assert.deepEqual(buckets.rulebook, [target]);
});

test('三个桶都不满足的规则被丢弃且不记 warning', () => {
  const log = createLog();
  const buckets = bucketRules([rule('bare'), rule('blank', { description: '   ' })], { log });
  assert.deepEqual(buckets, { ttsr: [], alwaysApply: [], rulebook: [], warnings: [] });
  assert.deepEqual(log.warnings, []);
});

test('空 condition 不注册 TTSR，按后续桶落位', () => {
  const target = rule('empty', { condition: [], alwaysApply: true });
  const buckets = bucketRules([target]);
  assert.deepEqual(buckets.ttsr, []);
  assert.deepEqual(buckets.alwaysApply, [target]);
});

test('只有 astCondition 或 question 的规则不注册 TTSR，记 warning 后照常落桶', () => {
  const log = createLog();
  const ast = rule('ast', { astCondition: 'foo($x)', description: '语法规则' });
  const question = rule('ask', { question: '这里要改吗？', alwaysApply: true });
  const buckets = bucketRules([ast, question], { log });
  assert.deepEqual(buckets.ttsr, []);
  assert.deepEqual(buckets.rulebook, [ast]);
  assert.deepEqual(buckets.alwaysApply, [question]);
  assert.equal(log.warnings.length, 2);
  assert.match(log.warnings[0], /astCondition\/question 没有匹配路径/);
});

test('condition 与 astCondition 同时存在时只走正则路径并记 warning', () => {
  const log = createLog();
  const target = rule('mixed', { condition: 'needle', astCondition: 'foo($x)' });
  const buckets = bucketRules([target], { log });
  assert.deepEqual(buckets.ttsr, [target]);
  assert.equal(log.warnings.length, 1);
  assert.match(log.warnings[0], /只走 condition 正则路径/);
});

test('agents 字段不参与过滤，规则照常分桶且只记一次 warning', () => {
  const log = createLog();
  const first = rule('first', { agents: ['claude'], alwaysApply: true });
  const second = rule('second', { agents: 'codex', description: '有说明' });
  const buckets = bucketRules([first, second], { log });
  assert.deepEqual(buckets.alwaysApply, [first]);
  assert.deepEqual(buckets.rulebook, [second]);
  assert.equal(log.warnings.length, 1);
  assert.match(log.warnings[0], /agents 字段不参与过滤/);
  assert.deepEqual(buckets.warnings, log.warnings);
});

test('同名规则分桶时不去重', () => {
  const first = rule('same', { alwaysApply: true });
  const second = rule('same', { description: '有说明' });
  const buckets = bucketRules([first, second]);
  assert.deepEqual(buckets.alwaysApply, [first]);
  assert.deepEqual(buckets.rulebook, [second]);
});

test('桶内顺序与入参顺序一致，且不修改入参', () => {
  const rules = [rule('a', { description: '甲' }), rule('b', { description: '乙' })];
  const snapshot = JSON.stringify(rules);
  const buckets = bucketRules(rules);
  assert.deepEqual(buckets.rulebook.map((entry) => entry.name), ['a', 'b']);
  assert.equal(JSON.stringify(rules), snapshot);
});
