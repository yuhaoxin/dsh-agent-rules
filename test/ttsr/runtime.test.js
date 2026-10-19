import assert from 'node:assert/strict';
import test from 'node:test';

import { createTtsrRuntime, MAX_RETRIES_PER_STEP } from '../../src/ttsr/index.js';

function rule(name, condition) {
  return {
    name,
    path: `/repo/.agents/rules/${name}.md`,
    body: `遵守 ${name}。`,
    condition,
  };
}

function createRuntime(rules) {
  const warnings = [];
  const runtime = createTtsrRuntime({
    rules,
    cwd: '/repo',
    log: { warn(message) { warnings.push(message); } },
  });
  return { runtime, warnings };
}

function injectedSurfaceEvent(text) {
  return {
    type: 'user/message',
    seq: 7,
    time: 0,
    data: {
      id: 'injected-1',
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'agent-rules', form: 'instructions' },
    },
    surfaceOp: 'append',
  };
}

test('会话 id 必须是非空字符串', () => {
  const { runtime } = createRuntime([]);
  assert.throws(() => runtime.session(''), TypeError);
  assert.throws(() => runtime.session(undefined), TypeError);
});

test('命中规则合成失败码，planRetry 给出可 append 的注入消息', () => {
  const { runtime } = createRuntime([rule('no-needle', 'needle')]);
  const session = runtime.session('s1');
  const hits = session.createTextMatcher().push('needle', 'text');
  const code = session.errorCode(hits);
  assert.equal(code, 'AGENT_RULES_TTSR:no-needle');
  assert.deepEqual(session.parseErrorCode(code), ['no-needle']);
  assert.deepEqual(session.interruptFinish(hits), {
    type: 'finish',
    reason: { kind: 'error', failure: { code, message: `TTSR rule violation: ${code}` } },
  });

  const interrupt = session.planInterrupt(hits, { turn: 0, step: 0 });
  assert.deepEqual(interrupt.finish, session.interruptFinish(hits));

  const plan = session.planRetry({ code });
  assert.ok(plan);
  assert.deepEqual(plan.hits.map((hit) => hit.id), ['no-needle']);
  const { type, payload, options } = plan.injection;
  assert.equal(type, 'user/message');
  assert.equal(payload.role, 'user');
  assert.deepEqual(payload.source, { kind: 'agent-rules', form: 'instructions' });
  assert.deepEqual(options, { surfaceOp: 'append' });
  assert.equal(typeof payload.id, 'string');
  const text = payload.content[0].text;
  assert.match(text, /<system-interrupt reason="rule_violation" rule="no-needle" path="\.agents\/rules\/no-needle\.md">/);
  assert.match(text, /MUST comply:\n\n遵守 no-needle。/);
});

test('一次 attempt 内多条命中合并成一条消息', () => {
  const { runtime } = createRuntime([rule('rule-a', 'needle'), rule('rule-b', 'needle')]);
  const session = runtime.session('s1');
  const hits = session.createTextMatcher().push('needle', 'text');
  assert.equal(hits.length, 2);

  session.planInterrupt(hits, { turn: 0, step: 0 });
  const plan = session.planRetry({ code: session.errorCode(hits) });
  const text = plan.injection.payload.content[0].text;
  assert.equal(text.match(/<system-interrupt /g).length, 2);
  assert.match(text, /rule="rule-a"/);
  assert.match(text, /rule="rule-b"/);
});

test('同一 step 最多中断 3 次，超限后放行并记 warning', () => {
  const { runtime, warnings } = createRuntime([rule('r1', 'a'), rule('r2', 'b'), rule('r3', 'c'), rule('r4', 'd')]);
  const session = runtime.session('s1');
  const hitFor = (text) => session.createTextMatcher().push(text, 'text');

  for (const text of ['a', 'b', 'c']) {
    const hits = hitFor(text);
    assert.ok(session.planInterrupt(hits, { turn: 0, step: 0 }), `${text} 应当中断`);
  }

  const fourth = hitFor('d');
  assert.equal(session.planInterrupt(fourth, { turn: 0, step: 0 }), null, '超限后放行，不短路');
  assert.match(warnings.at(-1), /重试已达上限/);
  assert.deepEqual(fourth.map((hit) => hit.id), ['r4'], '放行时命中记录不被消费');

  assert.ok(session.planInterrupt(fourth, { turn: 0, step: 1 }), '新 step 的预算独立');
});

test('planRetry 不消耗预算，只注入未提醒的规则', () => {
  const { runtime } = createRuntime([rule('no-needle', 'needle'), rule('r2', 'b')]);
  const session = runtime.session('s1');
  const hits = session.createTextMatcher().push('needle', 'text');
  const code = session.errorCode(hits);

  assert.ok(session.planRetry({ code }));
  assert.equal(session.planRetry({ code }), null, '同一规则不重复注入');
  assert.equal(session.planRetry({ code: 'OTHER_CODE:no-needle' }), null);
  assert.equal(session.planRetry({ code: 'AGENT_RULES_TTSR:已删除的规则' }), null);

  const other = session.createTextMatcher().push('b', 'text');
  assert.ok(session.planInterrupt(other, { turn: 0, step: 0 }), '前一次注入不影响本 step 预算');
});

test('提醒过的规则不再命中', () => {
  const { runtime } = createRuntime([rule('no-needle', 'needle'), rule('other', 'haystack')]);
  const session = runtime.session('s1');
  const hits = session.createTextMatcher().push('needle', 'text');
  session.planRetry({ code: session.errorCode(hits) });

  assert.deepEqual(session.createTextMatcher().push('needle', 'text'), []);
  assert.equal(session.createTextMatcher().push('haystack', 'text').length, 1);
});

test('从 surface 重建去重集合，恢复后不再重复提醒', () => {
  const { runtime } = createRuntime([rule('no-needle', 'needle'), rule('other', 'haystack')]);
  const text = [
    '<system-interrupt reason="rule_violation" rule="no-needle" path=".agents/rules/no-needle.md">',
    'Output interrupted.',
    '</system-interrupt>',
  ].join('\n');
  const session = runtime.session('s1');
  session.syncReminded([
    { type: 'assistant/message', seq: 6, time: 0, data: { content: [{ type: 'text', text: '无关事件' }] } },
    injectedSurfaceEvent(text),
    injectedSurfaceEvent('普通 user 消息，不带 rule 属性'),
  ]);

  assert.deepEqual(session.createTextMatcher().push('needle', 'text'), []);
  assert.equal(session.createTextMatcher().push('haystack', 'text').length, 1);
});

test('注入消息能被 surface 重建识别（写入与重建闭环）', () => {
  const { runtime } = createRuntime([rule('no-needle', 'needle')]);
  const session = runtime.session('s1');
  const hits = session.createTextMatcher().push('needle', 'text');
  session.planInterrupt(hits, { turn: 0, step: 0 });
  const plan = session.planRetry({ code: session.errorCode(hits) });

  // loop append 之后，另一个会话状态（恢复或 fork）从事件里重建去重集合。
  const appended = {
    type: plan.injection.type,
    seq: 9,
    time: 0,
    data: plan.injection.payload,
    ...plan.injection.options,
  };
  const resumed = runtime.session('s2');
  resumed.syncReminded([appended]);
  assert.deepEqual(resumed.createTextMatcher().push('needle', 'text'), []);
});

test('工具路径的命中同样受去重集合约束', () => {
  const { runtime } = createRuntime([rule('no-needle', 'needle')]);
  const session = runtime.session('s1');
  const call = { tool: 'edit', args: { file_path: '/repo/a.txt', new_string: 'needle' } };
  const hits = session.matchToolCall(call);
  assert.equal(hits.length, 1);

  session.markReminded(hits);
  assert.deepEqual(session.matchToolCall(call), []);
});

test('setRules 重新注册规则但保留已提醒集合', () => {
  const { runtime } = createRuntime([rule('no-needle', 'needle')]);
  const session = runtime.session('s1');
  const hits = session.createTextMatcher().push('needle', 'text');
  session.planRetry({ code: session.errorCode(hits) });

  runtime.setRules([rule('no-needle', 'needle'), rule('second', 'other')]);
  assert.equal(runtime.rules.length, 2);
  assert.deepEqual(session.createTextMatcher().push('needle', 'text'), []);
  assert.equal(session.createTextMatcher().push('other', 'text').length, 1);
});

test('规则文件里的路径按 cwd 相对显示，cwd 之外按 home 显示', () => {
  const { runtime } = createRuntime([
    { ...rule('inside', 'needle'), path: '/repo/.agents/rules/inside.md' },
    { ...rule('home', 'haystack'), path: '/Users/dev/.agents/rules/home.md' },
  ]);
  runtime.setHome('/Users/dev');
  const session = runtime.session('s1');

  const inside = session.planRetry({ code: session.errorCode(session.createTextMatcher().push('needle', 'text')) });
  assert.match(inside.injection.payload.content[0].text, /path="\.agents\/rules\/inside\.md"/);

  const home = session.planRetry({ code: session.errorCode(session.createTextMatcher().push('haystack', 'text')) });
  assert.match(home.injection.payload.content[0].text, /path="~\/\.agents\/rules\/home\.md"/);
});
