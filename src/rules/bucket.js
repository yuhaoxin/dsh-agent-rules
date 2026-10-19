/**
 * 规则分桶：把规则发现阶段产出的描述符分到 TTSR、alwaysApply 与 rulebook 三个桶。
 *
 * 输入描述符契约（由规则发现阶段提供）：
 *
 * ```js
 * {
 *   name: string,                       // 规则名
 *   path: string,                       // 规则文件绝对路径
 *   body: string,                       // frontmatter 之后的正文
 *   description?: string,               // 规则清单里的一句话说明
 *   alwaysApply?: boolean,              // 是否把正文注入系统提示词
 *   globs?: string | string[],          // 规则适用的路径 glob
 *   condition?: string | string[],      // TTSR 正则触发条件
 *   astCondition?: string | string[],   // 无匹配路径，只参与分桶
 *   question?: string,                  // 无匹配路径，只参与分桶
 *   agents?: string | string[],         // 不参与过滤
 * }
 * ```
 *
 * 判定顺序：有非空 `condition` 且 `isTtsrAccepted` 放行时只进 TTSR 桶；否则
 * `alwaysApply === true` 进 alwaysApply 桶；否则 `description` 非空进 rulebook
 * 桶；三者都不满足的规则丢弃，不记 warning。
 *
 * `astCondition` 与 `question` 没有匹配路径，`agents` 不参与过滤：带这些字段的
 * 规则按上述顺序照常落桶，只记 warning。
 */

/**
 * 分桶。桶内顺序与入参顺序一致，不修改入参。
 *
 * @param {readonly object[]} rules 规则发现阶段产出的描述符
 * @param {{
 *   isTtsrAccepted?: (rule: object) => boolean,
 *   log?: { warn: (message: string, ...rest: unknown[]) => void },
 * }} [options] `isTtsrAccepted` 判断规则在运行时能否注册为 TTSR，缺省接受
 * @returns {{ ttsr: object[], alwaysApply: object[], rulebook: object[], warnings: string[] }}
 */
export function bucketRules(rules, { isTtsrAccepted = () => true, log = console } = {}) {
  const buckets = { ttsr: [], alwaysApply: [], rulebook: [], warnings: [] };
  const warn = (message) => {
    buckets.warnings.push(message);
    log.warn(message);
  };
  let agentsWarned = false;

  for (const rule of rules) {
    if (!agentsWarned && hasEntries(rule.agents)) {
      agentsWarned = true;
      warn(`[agent-rules] 规则 ${rule.name} 的 agents 字段不参与过滤，按普通规则分桶`);
    }

    const hasCondition = hasEntries(rule.condition);
    const hasOtherTrigger = hasEntries(rule.astCondition) || hasEntries(rule.question);
    if (hasCondition && hasOtherTrigger) {
      warn(`[agent-rules] 规则 ${rule.name} 同时声明 condition 与 astCondition/question，只走 condition 正则路径`);
    } else if (!hasCondition && hasOtherTrigger) {
      warn(`[agent-rules] 规则 ${rule.name} 的 astCondition/question 没有匹配路径，不注册 TTSR`);
    }

    if (hasCondition && isTtsrAccepted(rule)) {
      buckets.ttsr.push(rule);
      continue;
    }
    if (rule.alwaysApply === true) {
      buckets.alwaysApply.push(rule);
      continue;
    }
    if (hasEntries(rule.description)) {
      buckets.rulebook.push(rule);
    }
  }

  return buckets;
}

/**
 * 描述符里的可选多值字段：字符串、字符串数组或 undefined。
 */
function hasEntries(value) {
  if (value === undefined) return false;
  return Array.isArray(value) ? value.length > 0 : value.trim().length > 0;
}
