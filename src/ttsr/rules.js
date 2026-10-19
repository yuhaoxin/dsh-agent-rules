/**
 * TTSR 规则注册：把规则发现阶段产出的触发规则编译成可匹配的形式。
 *
 * 输入描述符契约（由规则发现阶段提供）：
 *
 * ```js
 * {
 *   name: string,                 // 规则名，用作注入与去重的身份
 *   path: string,                 // 规则文件绝对路径
 *   body: string,                 // frontmatter 之后的正文，原样注入
 *   condition?: string | string[],// 触发正则，任一条命中即算命中
 *   scope?: string | string[],    // text / thinking / tool / tool:<name> / tool:<name>(<glob>)
 *   globs?: string | string[],    // 规则级 glob 门控，只对 tool scope 生效
 *   interruptMode?: string,       // always / prose-only / tool-only / never
 * }
 * ```
 *
 * 没有 `condition` 的规则不注册：`astCondition` 与 `question` 没有匹配路径，
 * 由分桶阶段记 warning。
 */

import { createGlobMatcher } from './glob.js';

export const INTERRUPT_MODES = ['always', 'prose-only', 'tool-only', 'never'];
export const DEFAULT_INTERRUPT_MODE = 'always';

/**
 * 每条规则允许中断的路径。`always` 两条都中断，`prose-only` 只中断正文流，
 * `tool-only` 只中断工具调用，`never` 两条都不中断。
 */
const INTERRUPT_SURFACES = {
  always: ['stream', 'tool'],
  'prose-only': ['stream'],
  'tool-only': ['tool'],
  never: [],
};

/**
 * 单条规则是否允许在该路径中断本次输出。
 *
 * @param {object} rule 编译后的规则
 * @param {'stream' | 'tool'} surface 命中的路径
 * @returns {boolean}
 */
export function interrupts(rule, surface) {
  return INTERRUPT_SURFACES[rule.interruptMode].includes(surface);
}

/**
 * 一次匹配是否进入中断路径：整批命中里只要有一条规则允许在该路径中断就中断。
 *
 * 中断是批级决定，注入也按整批走一条消息；不中断的整批命中转为被动提醒，
 * 不逐条拆分。
 *
 * @param {readonly object[]} rules 本次匹配的全部命中
 * @param {'stream' | 'tool'} surface 命中的路径
 * @returns {boolean}
 */
export function shouldInterrupt(rules, surface) {
  return rules.some((rule) => interrupts(rule, surface));
}

/** `tool:<name>` 与 `tool:<name>(<glob>)`。 */
const TOOL_TOKEN = /^tool:([^()\s]+)(?:\(([^)]*)\))?$/;

/**
 * 编译一批规则描述符，跳过不可用项并记 warning。
 *
 * @param {readonly object[]} descriptors
 * @param {{ warn: (message: string, ...rest: unknown[]) => void }} log
 * @returns {object[]} 编译后的规则，同名只保留第一条
 */
export function compileRules(descriptors, log) {
  const rules = [];
  const seen = new Set();
  for (const descriptor of descriptors) {
    const rule = compileRule(descriptor, log);
    if (!rule) continue;
    if (seen.has(rule.id)) {
      log.warn(`[agent-rules] TTSR 规则 ${rule.name} 与已注册规则同名，忽略后者`);
      continue;
    }
    seen.add(rule.id);
    rules.push(rule);
  }
  return rules;
}

function compileRule(descriptor, log) {
  const { name, path, body, condition, globs, interruptMode } = descriptor;
  const conditions = compileConditions(condition, name, log);
  if (conditions.length === 0) return null;

  const id = ruleId(name);
  const scope = parseScope(descriptor.scope, { id, log });
  if (!scope) return null;
  if (interruptMode !== undefined && !INTERRUPT_MODES.includes(interruptMode)) {
    log.warn(`[agent-rules] TTSR 规则 ${id} 的 interruptMode 无法识别：${interruptMode}，按 ${DEFAULT_INTERRUPT_MODE} 处理`);
  }

  const globMatcher = compileRuleGlobs(globs, id, log);
  if (globMatcher) {
    // 正文与思考流没有候选文件路径，带规则级 globs 的规则永远不会命中它们。
    scope.text = false;
    scope.thinking = false;
  }

  return {
    id,
    name,
    path,
    body,
    conditions,
    scope,
    globs: globMatcher,
    interruptMode: INTERRUPT_MODES.includes(interruptMode) ? interruptMode : DEFAULT_INTERRUPT_MODE,
  };
}

function compileConditions(condition, name, log) {
  const sources = (Array.isArray(condition) ? condition : [condition])
    .filter((source) => typeof source === 'string')
    .map((source) => source.trim())
    .filter((source) => source.length > 0);
  const compiled = [];
  const seen = new Set();
  for (const source of sources) {
    if (seen.has(source)) continue;
    seen.add(source);
    try {
      compiled.push(compileCondition(source));
    } catch (error) {
      log.warn(`[agent-rules] TTSR 规则 ${name} 的 condition 无法编译：${source}（${error.message}）`);
    }
  }
  return compiled;
}

/** 开头的 PCRE 内联旗标组，例如 `(?i)` 或 `(?ims)`。 */
const INLINE_FLAG_PREFIX = /^\(\?([a-z]+)\)/;

/** 能映射到原生 `RegExp` flags 的内联旗标。 */
const TRANSLATABLE_INLINE_FLAGS = /^[ims]+$/;

/**
 * 编译一条 `condition`。开头的 `(?i)` / `(?m)` / `(?s)` 转成 `RegExp` 的 flags：
 * JS 的 `RegExp` 不接受内联旗标前缀，直接传会让整条规则编译失败。
 *
 * 只翻译开头的 `i`/`m`/`s`；中间的组与不支持的旗标原样传给 `new RegExp`，
 * 让真正非法的模式照常报错。
 */
export function compileCondition(pattern) {
  const match = INLINE_FLAG_PREFIX.exec(pattern);
  if (match !== null && TRANSLATABLE_INLINE_FLAGS.test(match[1])) {
    const flags = [...new Set(match[1])].join('');
    return new RegExp(pattern.slice(match[0].length), flags);
  }
  return new RegExp(pattern);
}

function compileRuleGlobs(globs, id, log) {
  const list = (Array.isArray(globs) ? globs : [globs]).filter((glob) => typeof glob === 'string' && glob.length > 0);
  if (list.length === 0) return null;
  try {
    return createGlobMatcher(list);
  } catch (error) {
    log.warn(`[agent-rules] TTSR 规则 ${id} 的 globs 无法编译：${list.join(', ')}（${error.message}）`);
    return null;
  }
}

/**
 * 解析 scope。缺省为 omp 的默认值：正文开、思考关、任意工具开。
 *
 * 返回 `null` 表示该 scope 不可达（无流、无工具），规则不注册。
 *
 * @param {string | string[] | undefined} raw
 * @param {{ id: string, log: { warn: Function } }} context
 */
export function parseScope(raw, { id, log }) {
  if (raw === undefined) return defaultScope();
  const tokens = splitTokens(raw).map((token) => token.trim().toLowerCase()).filter((token) => token.length > 0);

  const scope = { text: false, thinking: false, tools: [] };
  for (const token of tokens) {
    if (token === 'text') scope.text = true;
    else if (token === 'thinking') scope.thinking = true;
    else if (token === 'tool') scope.tools.push({ name: null, glob: null });
    else {
      const match = TOOL_TOKEN.exec(token);
      if (!match) {
        log.warn(`[agent-rules] TTSR 规则 ${id} 的 scope 项无法识别：${token}`);
        continue;
      }
      const name = match[1].toLowerCase();
      if (match[2] === undefined) {
        scope.tools.push({ name, glob: null });
        continue;
      }
      const glob = compileScopeGlob(match[2], id, log);
      if (glob) scope.tools.push({ name, glob });
    }
  }
  if (!scope.text && !scope.thinking && scope.tools.length === 0) {
    log.warn(`[agent-rules] TTSR 规则 ${id} 的 scope 不匹配任何流，规则不注册`);
    return null;
  }
  return scope;
}

function defaultScope() {
  return { text: true, thinking: false, tools: [{ name: null, glob: null }] };
}

/**
 * 编译 scope 内的路径 glob。空 glob 与编译失败都返回 null，调用方跳过该 scope 项：
 * 空 glob 只匹配空路径，留着会变成一条永不命中的规则。
 */
function compileScopeGlob(glob, id, log) {
  if (glob.trim().length === 0) {
    log.warn(`[agent-rules] TTSR 规则 ${id} 的 scope glob 为空：${glob}`);
    return null;
  }
  try {
    return createGlobMatcher([glob]);
  } catch (error) {
    log.warn(`[agent-rules] TTSR 规则 ${id} 的 scope glob 无法编译：${glob}（${error.message}）`);
    return null;
  }
}

/**
 * 按逗号切分 scope，尊重括号、方括号、花括号与引号：`tool:edit(*.{ts,tsx})` 是一个 token。
 */
function splitTokens(raw) {
  const text = (Array.isArray(raw) ? raw : [raw]).map(String).join(',');
  const tokens = [];
  let current = '';
  let depth = 0;
  let quote = '';
  for (const char of text) {
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      tokens.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  tokens.push(current);
  return tokens.filter((token) => token.trim().length > 0);
}

/**
 * 规则 id：错误码用 `,` 分隔多条命中，注入模板用双引号属性，所以名字里的
 * 这些字符归一为 `_`。
 */
export function ruleId(name) {
  return String(name).replaceAll(/[",\r\n]/g, '_');
}
