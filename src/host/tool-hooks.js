/**
 * TTSR 工具调用路径的事件接线：`tools/pre-execute` 拦截与 `tools/post-execute` 提醒。
 *
 * 判定按 omp 的批级语义：一次工具调用的全部命中放在一起看，只要有一条规则允许
 * 在工具路径中断就整批中断，否则整批转成被动提醒。不逐条拆分，也不丢弃命中。
 *
 * - 中断：`tools/pre-execute` 返回 `deny`，拒绝理由是 omp 的 `<system-interrupt>`
 *   模板（含规则正文），工具体不执行。同一响应里其它工具照常执行：DSH 的 deny
 *   只作用于命中的那次调用。
 * - 不中断：`tools/post-execute` 用 `additionalContexts` 附一条
 *   `<system-reminder>`，工具照常执行，提醒进入下一步。`never` 与 `prose-only`
 *   的工具命中都走这条路径。
 *
 * 一条规则在一个会话里只提醒一次，去重集合由运行时持有并从 surface 重建。
 */

import { shouldInterrupt } from '../ttsr/rules.js';

/**
 * 安装工具路径的监听器。
 *
 * @param {object} ctx 插件上下文
 * @param {object} runtime 宿主运行时
 * @returns {void}
 */
export function installToolHooks(ctx, runtime) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const scope = resolve(runtime, exec);
    const hits = scope === undefined ? [] : scope.session.matchToolCall(toolCall(exec));
    if (!shouldInterrupt(hits, 'tool')) return next();

    const { denied, injection } = scope.session.planToolDeny(hits, scope.display);
    exec.agent.session.append(injection.type, injection.payload, injection.options);
    return { kind: 'deny', reason: denied };
  });

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next();
    const scope = resolve(runtime, exec);
    const hits = scope === undefined ? [] : scope.session.matchToolCall(toolCall(exec));
    if (hits.length === 0 || shouldInterrupt(hits, 'tool')) return downstream;

    const reminder = scope.session.planReminder(hits, scope.display);
    return { ...downstream, additionalContexts: [...(downstream.additionalContexts ?? []), reminder.payload] };
  });
}

/**
 * 解析一次工具调用所属会话的 TTSR 状态。没有 agent 的调用（例如插件直接发起的
 * 工具执行）不参与匹配；规则尚未加载的会话同样跳过。
 *
 * @returns {{ session: object, display: object } | undefined}
 */
function resolve(runtime, exec) {
  if (exec.agent === undefined) return undefined;
  const entry = runtime.entry(exec.agent.session.id);
  if (entry === undefined) return undefined;
  return { session: entry.ttsr.session(exec.agent.session.id), display: entry.display };
}

function toolCall(exec) {
  return { tool: exec.name, args: exec.arguments };
}
