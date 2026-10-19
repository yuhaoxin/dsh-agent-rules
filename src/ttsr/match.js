/**
 * TTSR 匹配：正文/思考流的累积文本匹配，以及工具调用的参数匹配。
 *
 * 文本匹配按全量累积文本扫描 `condition`；缓冲区超过 4096 字符后按几何节流，
 * 相对上次全扫增长不足 25% 时跳过扫描，块结束时由 `final()` 补一次全扫。
 */

import path from 'node:path';

export const FULL_SCAN_LIMIT = 4096;
export const GROWTH_FACTOR = 0.25;

const KINDS = ['text', 'thinking'];

/**
 * 建立一次 attempt 的文本匹配器。命中集合按规则去重：同一条规则在一次
 * attempt 内只上报一次。
 *
 * @param {readonly object[]} rules 编译后的规则
 * @param {{ isReminded: (rule: object) => boolean }} options
 */
export function createTextMatcher(rules, { isReminded }) {
  const rulesByKind = Object.fromEntries(
    KINDS.map((kind) => [kind, rules.filter((rule) => rule.scope[kind])]),
  );
  const buffers = new Map();
  const reported = new Set();

  const scan = (text, kind) => {
    const hits = [];
    for (const rule of rulesByKind[kind]) {
      if (reported.has(rule.id) || isReminded(rule)) continue;
      if (rule.conditions.some((condition) => condition.test(text))) {
        reported.add(rule.id);
        hits.push(rule);
      }
    }
    return hits;
  };

  return {
    /**
     * 追加一段流式增量；返回本次扫描新命中的规则。
     *
     * @param {string} delta
     * @param {'text' | 'thinking'} kind
     * @returns {object[]}
     */
    push(delta, kind) {
      const scoped = rulesByKind[kind];
      if (scoped.length === 0 || delta.length === 0) return [];
      let buffer = buffers.get(kind);
      if (!buffer) buffers.set(kind, buffer = { text: '', scanned: 0 });
      buffer.text += delta;
      const length = buffer.text.length;
      if (length > FULL_SCAN_LIMIT && length < buffer.scanned * (1 + GROWTH_FACTOR)) return [];
      buffer.scanned = length;
      return scan(buffer.text, kind);
    },

    /**
     * 块结束时强制全扫，补上被节流推迟的命中。
     *
     * @returns {object[]}
     */
    final() {
      const hits = [];
      for (const [kind, buffer] of buffers) {
        buffer.scanned = buffer.text.length;
        hits.push(...scan(buffer.text, kind));
      }
      return hits;
    },
  };
}

/**
 * 匹配一次工具调用。
 *
 * @param {readonly object[]} rules 编译后的规则
 * @param {{ tool: string, args: object, cwd: string }} call 工具名、已校验的参数与当前工作目录
 * @returns {object[]}
 */
export function matchToolCall(rules, { tool, args, cwd }) {
  const toolName = tool.toLowerCase();
  const json = JSON.stringify(args);
  const candidates = extractCandidatePaths(args, cwd);
  return rules.filter((rule) => {
    const inScope = rule.scope.tools.some(
      (entry) =>
        (entry.name === null || entry.name === toolName) &&
        (entry.glob === null || candidates.some((candidate) => entry.glob(candidate))),
    );
    if (!inScope) return false;
    if (rule.globs && !candidates.some((candidate) => rule.globs(candidate))) return false;
    return rule.conditions.some((condition) => condition.test(json));
  });
}

/**
 * 从工具参数里提取候选文件路径：键名以 `path` 结尾的字符串值，以及以 `paths`
 * 结尾的字符串数组。每个原始值展开为原样、去掉 `./`、绝对路径、相对 cwd 四种形式。
 *
 * @param {object} args
 * @param {string} cwd
 * @returns {string[]}
 */
export function extractCandidatePaths(args, cwd) {
  const candidates = new Set();
  for (const [key, value] of Object.entries(args)) {
    const lower = key.toLowerCase();
    if (lower.endsWith('paths')) {
      if (!Array.isArray(value)) continue;
      for (const item of value) addCandidate(candidates, item, cwd);
      continue;
    }
    if (lower.endsWith('path')) addCandidate(candidates, value, cwd);
  }
  return [...candidates];
}

function addCandidate(candidates, raw, cwd) {
  if (typeof raw !== 'string' || raw.length === 0) return;
  const value = raw.replaceAll('\\', '/');
  const absolute = path.resolve(cwd, value).replaceAll('\\', '/');
  candidates.add(value);
  if (value.startsWith('./')) candidates.add(value.slice(2));
  candidates.add(absolute);
  candidates.add(path.relative(cwd, absolute).replaceAll('\\', '/'));
}
