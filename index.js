/**
 * Host 侧入口：把用户级和项目级 `.agent`/`.agents` 规则注入会话。
 *
 * 三条路径共享同一份按会话的规则状态（见 `src/host/runtime.js`）：
 *
 * - alwaysApply 正文与 rulebook 清单进系统提示词；
 * - TTSR 工具命中在 `tools/pre-execute` 拦截，或按规则配置在 `tools/post-execute` 提醒；
 * - TTSR 正文/思考流命中在 `llm/stream` 短路，并在 `agent/request-error` 注入后重试。
 *
 * 规则发现是异步 I/O，而 section 的 `text` 回调由 `SystemPrompt.assemble()` 同步
 * 求值、早于 `system-prompt/assemble` waterfall。`assemble()` 返回 waterfall 的
 * 返回值，所以这里在 waterfall 里加载规则、回填返回值里的 section 正文，同一 step
 * 渲染出的提示词就包含本次发现的规则。section 的 `text` 回调保留，用于读取上一
 * step 已加载的内容。
 */

import { PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER, createHostRuntime } from './src/host/runtime.js';
import { installStreamHooks } from './src/host/stream-hooks.js';
import { installToolHooks } from './src/host/tool-hooks.js';

export const name = 'agent-rules';

export const inject = ['agents', 'systemPrompt', 'workingDirectory'];

export function apply(ctx, config = {}) {
  if (config.enabled === false) return;

  const runtime = createHostRuntime({
    ctx,
    directories: config.directories ?? [],
    log: ctx.logger,
  });

  installToolHooks(ctx, runtime);
  installStreamHooks(ctx, runtime);

  ctx.systemPrompt.section({
    name: PROMPT_SECTION_NAME,
    order: PROMPT_SECTION_ORDER,
    // 规则正文是用户文本，`{{name}}` 这类字样必须原样保留；否则 assemble 会按
    // 提示词变量插值，遇到未注册的名字直接抛错。
    interpolate: false,
    text: (context) => (context.agent === undefined ? '' : runtime.promptText(context.agent)),
  });

  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const downstream = await next();
    if (context.agent === undefined) return downstream;
    await runtime.attach(context.agent, context.signal);
    const section = downstream.sections.find((entry) => entry.name === PROMPT_SECTION_NAME);
    if (section === undefined) return downstream;
    section.text = runtime.promptText(context.agent);
    return downstream;
  });
}
