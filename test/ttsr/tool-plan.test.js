import assert from 'node:assert/strict';
import test from 'node:test';

import { createTtsrRuntime } from '../../src/ttsr/index.js';

function rule(name, condition, extra = {}) {
  return {
    name,
    path: `/repo/.agents/rules/${name}.md`,
    body: `遵守 ${name}。`,
    condition,
    ...extra,
  };
}

function createRuntime(rules) {
  return createTtsrRuntime({ rules, cwd: '/repo', log: { warn() {} } });
}

test('planToolDeny 返回拒绝理由与注入消息，并把命中标记为已提醒', () => {
  const runtime = createRuntime([rule('no-console', 'console\\.log', { scope: 'tool' })]);
  const session = runtime.session('s1');
  const hits = session.matchToolCall({ tool: 'edit', args: { file_path: '/repo/a.ts', new_string: 'console.log(1)' } });
  assert.equal(hits.length, 1);

  const plan = session.planToolDeny(hits, { cwd: '/repo', home: '/home/dev' });
  assert.match(plan.denied, /TTSR rule violation: no-console/);
  assert.equal(plan.injection.type, 'user/message');
  assert.deepEqual(plan.injection.options, { surfaceOp: 'append' });
  assert.deepEqual(plan.injection.payload.source, { kind: 'agent-rules', form: 'instructions' });
  const text = plan.injection.payload.content[0].text;
  assert.match(text, /<system-interrupt reason="rule_violation" rule="no-console"/);
  assert.match(text, /path="\.agents\/rules\/no-console\.md"/);

  assert.deepEqual(
    session.matchToolCall({ tool: 'edit', args: { file_path: '/repo/a.ts', new_string: 'console.log(1)' } }),
    [],
    '拒绝后同一规则不再命中',
  );
});

test('planReminder 返回 system-reminder 消息，source.form 与注入区分', () => {
  const runtime = createRuntime([rule('no-console', 'console\\.log', { scope: 'tool' })]);
  const session = runtime.session('s1');
  const hits = session.matchToolCall({ tool: 'edit', args: { file_path: '/repo/a.ts', new_string: 'console.log(1)' } });

  const reminder = session.planReminder(hits, { cwd: '/repo' });
  assert.equal(reminder.type, 'user/message');
  assert.deepEqual(reminder.payload.source, { kind: 'agent-rules', form: 'notice' });
  const text = reminder.payload.content[0].text;
  assert.match(text, /<system-reminder reason="rule_violation" rule="no-console"/);
  assert.match(text, /Rule configured not to interrupt/);
  assert.match(text, /遵守 no-console。/);

  assert.deepEqual(session.matchToolCall({ tool: 'edit', args: { file_path: '/repo/a.ts', new_string: 'console.log(1)' } }), []);
});

test('提醒消息能被 surface 重建识别', () => {
  const runtime = createRuntime([rule('no-console', 'console\\.log', { scope: 'tool' })]);
  const session = runtime.session('s1');
  const hits = session.matchToolCall({ tool: 'edit', args: { file_path: '/repo/a.ts', new_string: 'console.log(1)' } });
  const reminder = session.planReminder(hits, { cwd: '/repo' });

  const resumed = runtime.session('s2');
  resumed.syncReminded([
    { type: 'user/message', seq: 3, time: 0, data: reminder.payload, surfaceOp: 'append' },
  ]);
  const again = resumed.matchToolCall({ tool: 'edit', args: { file_path: '/repo/a.ts', new_string: 'console.log(1)' } });
  assert.deepEqual(again, []);
});
