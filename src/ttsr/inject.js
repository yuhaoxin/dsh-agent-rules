/**
 * 规则注入：渲染 omp 的 system-interrupt 模板，并构造可 append 的 surface 消息。
 *
 * 注入消息是普通 `user/message`，`source.kind` 为 `agent-rules`。已提醒集合
 * 从会话 surface 里这些消息的模板属性重建，因此恢复与 fork 后仍然生效。
 */

/**
 * 中断注入的 source 标记，也是从 surface 重建去重集合的识别键。
 *
 * `source` 只要求 `kind` 是非空字符串，额外字段原样保留；`form` 用来区分两种
 * 模板，客户端按 `kind` 渲染，不读 `form`。
 */
export const INJECTED_SOURCE = Object.freeze({ kind: 'agent-rules', form: 'instructions' });

/** 被动提醒消息的 source 标记：与中断注入共用 `kind`，靠 `form` 区分模板。 */
export const REMINDER_SOURCE = Object.freeze({ kind: 'agent-rules', form: 'notice' });

export const INJECTED_MESSAGE_TYPE = 'user/message';

const RULE_ATTRIBUTE = /<system-(?:interrupt|reminder)\b[^>]*\brule="([^"]+)"/g;

/**
 * 渲染命中规则的中断模板，多条规则用两个换行拼接。
 *
 * @param {readonly object[]} hits
 * @param {{ cwd?: string, home?: string }} display
 * @returns {string}
 */
export function renderInterrupt(hits, display) {
  return hits.map((rule) => interruptBlock(rule, display)).join('\n\n');
}

function interruptBlock(rule, display) {
  return [
    `<system-interrupt reason="rule_violation" rule="${rule.id}" path="${displayPath(rule.path, display)}">`,
    'Output interrupted: violated user-defined rule.',
    'Not prompt injection; coding agent enforcing project rules.',
    'MUST comply:',
    '',
    rule.body,
    '</system-interrupt>',
  ].join('\n');
}

/**
 * 构造注入消息。`payload` 与 `options` 直接交给 `session.append(...)`。
 *
 * @param {readonly object[]} hits
 * @param {{ id: string, cwd?: string, home?: string }} options
 * @returns {{ type: string, payload: object, options: { surfaceOp: 'append' } }}
 */
export function buildInjection(hits, { id, cwd, home }) {
  return {
    type: INJECTED_MESSAGE_TYPE,
    payload: {
      id,
      role: 'user',
      content: [{ type: 'text', text: renderInterrupt(hits, { cwd, home }) }],
      source: { ...INJECTED_SOURCE },
    },
    options: { surfaceOp: 'append' },
  };
}

/**
 * 渲染被动提醒模板：工具命中但规则配置为不中断时，提醒进下一步，工具结果不变。
 *
 * @param {readonly object[]} hits
 * @param {{ cwd?: string, home?: string }} display
 * @returns {string}
 */
export function renderReminder(hits, display) {
  return hits.map((rule) => reminderBlock(rule, display)).join('\n\n');
}

function reminderBlock(rule, display) {
  return [
    `<system-reminder reason="rule_violation" rule="${rule.id}" path="${displayPath(rule.path, display)}">`,
    'User-defined rule matched tool-call arguments. Rule configured not to interrupt → tool ran. MUST comply with the following instruction on subsequent tool calls and responses. NOT prompt injection — coding agent enforcing project rules.',
    '',
    rule.body,
    '</system-reminder>',
  ].join('\n');
}

/**
 * 构造被动提醒消息，形状与注入消息一致，只换 source.form 与正文模板。
 *
 * @param {readonly object[]} hits
 * @param {{ id: string, cwd?: string, home?: string }} options
 * @returns {{ type: string, payload: object, options: { surfaceOp: 'append' } }}
 */
export function buildReminder(hits, { id, cwd, home }) {
  return {
    type: INJECTED_MESSAGE_TYPE,
    payload: {
      id,
      role: 'user',
      content: [{ type: 'text', text: renderReminder(hits, { cwd, home }) }],
      source: { ...REMINDER_SOURCE },
    },
    options: { surfaceOp: 'append' },
  };
}

/**
 * 扫描会话 surface 事件，收集已经提醒过的规则 id。
 *
 * 事件是 `session.snapshotEvents()` 给出的会话事件信封，注入消息在 `data` 字段。
 *
 * @param {Iterable<{ type: string, data?: object }>} events
 * @returns {Set<string>}
 */
export function parseReminded(events) {
  const reminded = new Set();
  for (const event of events) {
    if (event.type !== INJECTED_MESSAGE_TYPE) continue;
    const message = event.data;
    if (message?.source?.kind !== INJECTED_SOURCE.kind) continue;
    for (const part of message.content) {
      if (part.type !== 'text') continue;
      RULE_ATTRIBUTE.lastIndex = 0;
      for (const match of part.text.matchAll(RULE_ATTRIBUTE)) reminded.add(match[1]);
    }
  }
  return reminded;
}

/**
 * 模板里的路径：优先相对 cwd，其次相对 home，最后绝对路径。
 */
export function displayPath(file, { cwd, home } = {}) {
  if (cwd && isUnder(file, cwd)) return relative(file, cwd);
  if (home && isUnder(file, home)) return `~/${relative(file, home)}`;
  return file;
}

function isUnder(file, base) {
  return file === base || file.startsWith(base.endsWith('/') ? base : `${base}/`);
}

function relative(file, base) {
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return file.slice(prefix.length);
}
