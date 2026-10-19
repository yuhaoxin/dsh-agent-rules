/**
 * Host 侧入口：把用户级和项目级 `.agent`/`.agents` 规则注入会话。
 *
 * 三条路径共享同一份按会话的规则状态（见 `src/host/runtime.js`）：
 *
 * - alwaysApply 正文与 rulebook 清单进系统提示词；
 * - TTSR 工具命中在 `tools/pre-execute` 拦截，或按规则配置在 `tools/post-execute` 提醒；
 * - TTSR 正文/思考流命中在 `llm/stream` 短路，并在 `agent/request-error` 注入后重试。
 *
 * 规则发现是异步 I/O，而 section 的 `text` 回调在 `assemble()` 里同步执行、早于
 * `system-prompt/assemble` waterfall。所以加载放在 waterfall 里，加载完成后再用
 * 返回值里的 section 回填正文；`assemble()` 拿到的是 waterfall 的返回值，因此
 * 同一 step 的提示词已经包含规则。
 */

import { PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER, createHostRuntime } from './src/host/runtime.js';
import { installStreamHooks } from './src/host/stream-hooks.js';
import { installToolHooks } from './src/host/tool-hooks.js';

export const name = 'agent-rules';

export const inject = ['agents', 'systemPrompt', 'workingDirectory'];

export function apply(ctx, config = {}) {
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
