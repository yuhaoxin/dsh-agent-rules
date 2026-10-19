/**
 * 提示词渲染：把分桶结果渲染成可拼进系统提示词的片段。
 *
 * alwaysApply 桶的正文包进 `<generic-rules>`，规则之间空一行；rulebook 桶渲染
 * 成 `<domain-rules>` 清单，每条规则一行。路径按 cwd 相对、home 用 `~` 显示，
 * 与 TTSR 注入模板共用 `displayPath`。
 *
 * 渲染顺序即入参顺序，不修改入参。
 */

import { displayPath } from '../ttsr/inject.js';

/**
 * 渲染 alwaysApply 桶。
 *
 * @param {readonly object[]} rules
 * @returns {string} 无规则时为空字符串
 */
export function renderAlwaysApply(rules) {
  if (rules.length === 0) return '';
  const bodies = rules.map((rule) => rule.body).join('\n\n');
  return ['<generic-rules>', bodies, '</generic-rules>'].join('\n');
}

/**
 * 渲染 rulebook 桶，每行 `- <name> (<globs>): <description> — <path>`，
 * 无 globs 时省略括号段。
 *
 * @param {readonly object[]} rules
 * @param {{ cwd?: string, home?: string }} display 路径显示基准
 * @returns {string} 无规则时为空字符串
 */
export function renderRulebook(rules, display = {}) {
  if (rules.length === 0) return '';
  const lines = rules.map((rule) => {
    const globs = ruleGlobs(rule);
    const target = globs ? ` (${globs})` : '';
    return `- ${rule.name}${target}: ${rule.description} — ${displayPath(rule.path, display)}`;
  });
  return ['<domain-rules>', ...lines, '</domain-rules>'].join('\n');
}

function ruleGlobs(rule) {
  const globs = rule.globs ?? [];
  return (Array.isArray(globs) ? globs : [globs]).join(', ');
}
