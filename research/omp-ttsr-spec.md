# omp TTSR 到 DeepSeek Harness 的可移植规格

## 0. 结论

omp（oh-my-pi）的 TTSR 由四层组成：规则发现与 frontmatter、分桶、流式匹配、触发后的中断/注入/重试。DeepSeek Harness 0.2.1-rc.2 没有规则发现器，也没有 TTSR 运行时，但现有事件与服务足以复刻大部分行为，少部分必须降级。

- 可直接复刻：`.agent`/`.agents` 规则文件的解析与分桶逻辑；`scope` 语法；`condition` 正则的增量匹配；toolcall 参数流匹配；`interruptMode` 四值语义；规则模板；tool-source 的 `additionalContexts` 提醒；`once`/`after-gap` 记账逻辑本身。
- 需要适配：规则发现（DSH 只加载 `AGENTS.md`/`CLAUDE.md`）；`alwaysApply` 进入系统提示词（用 `systemPrompt.section()`）；中断（用 `Agent.cancel()` + `followup()`）；重试调度（用 turn 边界，不复制 50ms 定时器）；每会话状态（用 `appendPluginRecord` 的 `plugin:` 记录，不再依赖会话事件白名单）。
- 首版降级：
  - `contextMode: "discard"` 没有精确等价能力。DSH 在中断时把部分输出提交为 `assistant/message`（`interrupted: true`），模型后续仍能看到它，行为等于 omp 的 `keep`。提交之后可以用一条 user-role 替换消息把它从模型可见表面遮蔽，但人类转录仍保留原文，角色也变了；首版不用这条路。
  - `astCondition` 不做。DSH 没有 ast-grep 引擎，也没有工具的 `matcherDigest`/`matcherEntries` 钩子。
  - `question`（judge）不做。DSH 没有 judge 模型角色；用 `llm.stream()` 自建裁判会引入额外模型调用和配置面。
  - tool 中断只能整轮 abort。DSH 没有 step-only abort，也没有“只中止某一个 tool call”的机制，并行 tool call 会被一起取消。
  - 注入消息是普通 user-role 消息。omp 的隐藏 `custom` 消息在 DSH 没有等价显示控制；规则正文会出现在对话记录里。
- 不做：`rule://` 内部 URL；omp 的 bridged AgentTool（Cursor exec、eval）路径；TTSR 通知的前端组件（需要另写客户端插件）。

## 1. 证据基准

- omp 源码：`/tmp/omp-src`，commit `9d5d4ac5b50ac2bb5866e4202efc0cf785dfc57a`。
- DSH：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 内的 `dsh`，`package.json` 版本 `0.2.1-rc.2`。
- DSH 能力事实来自本会话的 `cordis_inspect_query`（platform `host`，provider `Service` / `Event`）与 `app.asar` 内包源码；没有修改 DSH。
- 引用格式：omp 路径相对 `/tmp/omp-src`；DSH 路径写成 `dsh/node_modules/@deepseek-ai/<package>/lib/index.js:<line>`，行号取自 0.2.1-rc.2 的打包产物。

## 2. 规则发现

### 2.1 目录、扩展名、顺序

`.agent`/`.agents` provider（`packages/coding-agent/src/discovery/agents.ts`，优先级 70）加载规则：

| 层级 | 路径 |
| --- | --- |
| 项目 | 从 `cwd` 向上到 `repoRoot`，每个祖先目录依次看 `<dir>/.agent/rules`、`<dir>/.agents/rules` |
| 用户 | `~/.agent/rules`、`~/.agents/rules` |

补充事实：

- 向上遍历时跳过用户 home 目录本身，避免同一目录被同时算作项目和用户来源（`getProjectPathCandidates`）。
- WSL 下用户候选还包括 Windows 宿主 profile 的 `.agent`/`.agents`。
- 只收 `.md` 和 `.mdc`，不递归；`gitignore: true`，`hidden: false`。
- 规则名取文件名去掉 `.md`/`.mdc`。frontmatter 里的 `name` 不是识别键。
- 装载顺序是“项目候选数组顺序 → 用户候选数组顺序”，即先 `cwd/.agent`，再 `cwd/.agents`，再父目录，最后用户目录。同一目录内多个文件的先后由 glob 返回顺序决定，代码没有显式排序。
- 名字去重在 capability 层按 `rule.name` 做 first-wins。因为项目项排在用户项前，同名规则由项目文件覆盖用户文件；跨 provider 时也按优先级 first-wins（`native` 100、`omp-plugins` 90、`agents` 70、`cursor`/`windsurf` 50、`cline` 40、`github` 30、`builtin-defaults` 1）。
- `enabled: false` 在 discovery 阶段就返回 `null`，发生在按名字去重之前。结果是一个被禁用的高优先级文件不会挡住同名的低优先级文件。

### 2.2 frontmatter 解析与默认值

所有 provider 共用 `packages/utils/src/frontmatter.ts` 的 `parseFrontmatter`：

- 只有正文以 `---` 开头且存在 `\n---` 结束行时才解析 frontmatter；正文在提取后 `trim()`。
- 键名从 kebab-case 归一为 camelCase（`thinking-level` → `thinkingLevel`）。
- 整个 YAML 解析失败时：记录 warning，退回逐行 `^([\w-]+):\s*(.*)$` 解析，每个值单独再按 YAML 解析；仍失败的值保留为 trim 后的字符串。
- 退回路径无法还原多行数组和嵌套对象。合法的单行 flow 写法（如 `[text, thinking]`）仍可用。

解析结果（`packages/coding-agent/src/capability/rule.ts`、`packages/coding-agent/src/discovery/helpers.ts` 的 `buildRule`）：

| 字段 | 接受形式 | 默认值 / 丢弃条件 |
| --- | --- | --- |
| `enabled` | 仅严格 `false` | 缺省视为启用；`false` 在 discovery 阶段丢弃文件 |
| `description` | 字符串 | 缺省 `undefined`；空字符串不会进入 rulebook |
| `alwaysApply` | 仅严格 `true` | 缺省 `false` |
| `globs` | 字符串数组（只留字符串元素）或单个字符串 | 缺省 `undefined`；显式空数组保留为 `[]` |
| `condition` | 字符串或字符串数组；兼容旧键 `ttsr_trigger` / `ttsrTrigger` | 逐项 trim、去重；空则 `undefined` |
| `astCondition` | 字符串或字符串数组 | 逐项 trim、去重；不做 glob 推断 |
| `question` | 字符串 | trim 后非空才保留，否则 `undefined` |
| `scope` | 字符串或字符串数组 | 逐 token 逗号切分（尊重括号/方括号/花括号和引号）、去引号、去重 |
| `agents` | 字符串或字符串数组 | 逗号切分，去掉 `{a, b}` 花括号组内逗号两侧空白，整体小写；缺省表示适用于所有 agent |
| `interruptMode` | `never` / `prose-only` / `tool-only` / `always` | 其它值忽略为 `undefined`，回退全局设置 |

`condition` 的额外处理：

- 开头的 PCRE 风格内联旗标 `(?i)`、`(?m)`、`(?s)` 会转换成 JavaScript `RegExp` 的 flags；不支持的写法原样传给 `new RegExp`，编译失败时该条 condition 被丢弃并记 warning。
- 形如文件 glob 的 condition 会被转成 scope 简写：`*.rs` 变成 `tool:edit(*.rs)`、`tool:write(*.rs)` 两条 scope，并补一条 catch-all condition `.*`。`astCondition` 不参与这个推断。
- “像 glob”的判定（`isLikelyFileGlob`）：含 `?*[]{}` 之一、不含 `\^$+|()`；含 `/` 直接算 glob，否则必须匹配 `^\*\.[^\s/]+$`。

### 2.3 分桶

`bucketRules`（`packages/coding-agent/src/capability/rule-buckets.ts`）是唯一入口，顺序如下：

1. 丢弃 `ttsr.disabledRules` 里列出的名字（trim 后比较）。
2. `ttsr.builtinRules === false` 时丢弃 `_source.provider === "builtin-defaults"` 的规则。
3. 丢弃 `agents` glob 不匹配当前会话 agent 名的规则。`main` 表示顶层会话，`sub` 表示没有定义名的子会话；两者是保留名。
4. 有非空 `condition`、`astCondition` 或 `question` 的规则尝试注册到 `TtsrManager`。注册成功即只属于 TTSR 桶。
5. 剩下的规则里 `alwaysApply === true` 进入 always-apply 桶。
6. 再剩下的规则里有非空 `description` 的进入 rulebook 桶。

因此三类“为什么被丢弃”：

- 三个触发字段都为空，且没有 `description`、没有 `alwaysApply: true`：不属于任何桶，不注入、不列出。
- 有触发字段但 `TtsrManager.addRule()` 拒绝（正则全部编译失败、scope 排除所有流、`ttsr.enabled === false`、同名已注册）：会继续走 always-apply / rulebook；两者也不满足时同样消失。
- `rule://` 的解析快照只包含 rulebook、always-apply 和已注册 TTSR 规则，所以上述消失的规则也无法通过 `rule://<name>` 重新读取。

一个同时有触发字段和 `alwaysApply: true` 的规则，只有在 TTSR 注册失败时才落到 always-apply 桶。同时有 `alwaysApply` 和 `description` 的规则只进 always-apply 桶，不重复出现在 rulebook。

## 3. `scope` 语法与路径门控

默认 scope：`text` 开、`thinking` 关、任意 tool 开（`packages/coding-agent/src/export/ttsr.ts` 的 `DEFAULT_SCOPE`）。

token 语法（大小写不敏感）：

| token | 含义 |
| --- | --- |
| `text` | 助手正文流 |
| `thinking` | 推理/思考流 |
| `tool` 或 `toolcall` | 任意工具参数流 |
| `tool:<name>` | 指定工具的参数流 |
| `<name>` | 裸工具名，等价 `tool:<name>` |
| `tool:<name>(<path-glob>)` | 指定工具，且候选文件路径匹配 glob |
| `tool:(<path-glob>)` | 任意工具，只要候选文件路径匹配 glob |

解析细节：

- 逗号切分只在括号、方括号、花括号之外生效，引号内的逗号不切。
- 工具名转小写；路径 glob 用 `Bun.Glob`。
- 无效 token 记 warning 后跳过。所有 token 都无效或为空时 scope 不可达，`addRule` 拒绝注册。
- 路径匹配把 `\` 归一为 `/`，先匹配完整路径，再匹配 basename。
- 规则级 `globs` 是全局门控：匹配上下文必须至少有一个候选文件路径命中，否则这条规则不参与本次匹配。正文/思考流没有文件路径，所以带 `globs` 的规则永远不会命中 `text`/`thinking`。

工具流的候选路径来源：

1. 工具定义暴露的 `matcherPaths(args)` 优先（edit 的 hashline/apply_patch 能从不完整参数里解析路径）。
2. 否则扫描顶层参数：键名等于 `path` 或以 `path` 结尾的字符串；键名等于 `paths` 或以 `paths` 结尾的字符串数组。
3. 每个路径生成多个候选：原样、去掉开头的 `./`、绝对路径、相对 cwd 的路径；统一 `/` 并去重。

## 4. 流式匹配

### 4.1 缓冲与生命周期

`TtsrManager` 按 stream key 维护缓冲区（`packages/coding-agent/src/export/ttsr.ts` 的 `#bufferKey`、`StreamBuffer`）：

- key 优先用 `context.streamKey`（toolcall 用 `toolcall:<id>`，按文件拆分的 entry 再用 `#<path>` 后缀）；正文用 `text`，思考用 `thinking`；没有 key 的工具流用 `tool:<name>`。
- `turn_start`、assistant `message_start`、同一响应内 provider 的 `start` 都会清空缓冲区，防止被丢弃的尝试和重试内容拼接。
- 没有任何已注册规则允许 `text` 时，正文 delta 不进入缓冲；`thinking` 同理。
- `text_end`、`thinking_end`、`toolcall_end` 做一次 whole-buffer 的 final check，用来补上被增长节流推迟的跨行匹配。空块和已经处于 TTSR abort 等待中的响应跳过 final check。

### 4.2 增量匹配

每条编译后的正则会先做语法特征分析（`analyzeCondition`），得到三个布尔量：

- `sliceSafe`：从行首开始扫一段就能得到与整缓冲区相同的结果；有 lookbehind、sticky、非 multiline 的 `^` 时为 false。
- `lineLocal`：`sliceSafe` 且没有任何能匹配 `\n` 的语法（`. ` 在无 `s` flag 时不算；`\s`、`\W`、`\D`、字符类里的换行都算）。
- `monotonic`：追加文本不会让已有匹配消失；出现 `$`、`\b`、`\B`、负向 lookahead 时为 false。

匹配策略：

- 单行条件（`lineLocal`）每个 delta 都只从“上次扫描终点所在行的行首”重扫，结果与全量扫描一致。
- 跨行条件先扫同一行区间；整缓冲区扫描按几何节流：长度 ≤ 4096 字符时每次全扫，超过后只有相对上次全扫增长 ≥ 25% 才全扫。
- 非 final 检查可能返回“暂未命中”；`final: true` 强制全量扫描。
- `checkDelta` 默认 `final: false`；`checkSnapshot` 默认 `final: true`。
- 无法建模的正则语法（`unicode`、`unicodeSets`、未知分组）标记为 opaque，只做 whole-buffer 扫描。

### 4.3 toolcall 参数快照

工具参数流有三条路径（`packages/coding-agent/src/session/ttsr-coordinator.ts` 的 `#checkStream`，配合 `ttsr-outputs.ts`）：

1. 工具暴露 `matcherEntries(args)`：按文件投影成 `{ path, digest }`，每个 entry 用自己的 stream key 单独 `checkSnapshot`。多文件 edit 里，`tool:edit(*.ts)` 不会命中同批次里的 Markdown hunk。
2. 工具暴露 `matcherDigest(args)`：用重建后的源码快照替换缓冲区，再 `checkSnapshot`。
3. 其它工具：把 `argumentsDelta` 追加进缓冲区，用 `checkDelta` 匹配原始 JSON 片段。到 `toolcall_end` 时如果 `arguments` 已完整、但此前没有任何 delta（某些 provider 只给 start/end），用序列化后的最终参数作为快照播种一次，避免空缓冲。

`matcherDigest` 表示“这次调用会写入的源码”，不是目标文件的完整内容：replace 模式给 `new_string`，patch 类模式给新增行，create 模式给完整内容，write 给 `content`。调用没有重复的旧内容对 AST 不可见。

### 4.4 `astCondition`

- 只在 `beforeToolCall` 钩子里跑，输入是已经校验过的最终参数；不在流式 delta 上跑。
- 需要候选路径能推出文件扩展名；推不出语言就跳过。
- 用 native `astMatch`，strictness 为 `Smart`，匹配重建快照，不是线上原始 delta。
- 相同 stream key 的连续相同快照会被跳过；解析/匹配报错按“不命中”处理。
- 一条规则可以同时有 `condition` 和 `astCondition`：正则路径在所有 scope 上工作，AST 路径只在带可用路径的工具流上工作。
- `question` 规则即使带 `astCondition`，也不会进入流式/AST 匹配，AST 只作为 judge 的前置过滤。

### 4.5 `question`（judged rules）

- 只在 assistant 消息结束、且 `stopReason` 不是 `aborted`/`error` 时判断；不参与流式匹配，也不会中断。
- 输出拆分：所有 text 块拼成一个 `reply`；所有 thinking 块拼成一个 `reasoning`；每个 tool call 单独一个输出，工具暴露 `matcherEntries` 时按文件拆，内容用 digest，否则用 `matcherDigest` 或原始 JSON 参数。
- 对每个输出，先按 scope、`globs`、repeat 策略和可选的 `condition`/`astCondition` 前置过滤，选出候选规则。
- 一个输出只发一次 judge 请求，把这个输出的所有候选问题放进同一个请求；共享 state 只计费一次。内容截到最长 32,000 个 Jev token 前缀。
- yes 概率 ≥ 0.7 判为违规；`claim()` 去掉已被其它输出认领或 repeat 策略不允许的规则，其余标记为已注入。
- 违规规则用 warning 模板渲染成隐藏消息，以 `deliverAs: "aside"` 投递：运行中并入下一步、不中断；空闲时开启一轮。`onBeforeYield` 最多等 5 秒，让最后一条输出的判断赶上本轮。
- `ttsr.judge`：`auto` 只在 judge 角色解析到 native TypeSafe jev 模型时判断；`on` 用角色解析到的任意模型；`off` 不判断，但规则仍然注册。

## 5. 触发后的行为

### 5.1 `interruptMode`

每条规则的 `interruptMode` 优先于全局 `ttsr.interruptMode`：

| 值 | 中断条件 |
| --- | --- |
| `always` | 任何来源命中都中断 |
| `prose-only` | `text` / `thinking` 命中中断 |
| `tool-only` | tool 命中中断 |
| `never` | 永不中断 |

一次匹配里只要有一条命中规则允许中断，就进入中断路径；否则走非中断路径。

### 5.2 中断、丢弃、注入、重试

命中且需要中断时（`ttsr-coordinator.ts` 的 `#handleMatches`）：

1. 命中规则按名字去重，放进 pending injections。
2. 设置 `abortPending`，创建 resume gate。
3. 立即调用 `agent.abort()`。tool 命中时用 tool-call 作用域的 abort reason，兄弟调用收到单独的 `TTSR interrupt on another tool call`。
4. 异步发出 `ttsr_triggered` 事件，不阻塞 abort。
5. 通过 post-prompt task scheduler 延迟 50ms 执行重试任务，任务带 prompt generation 和 retry token。
6. 重试任务先校验 token、generation、`abortPending` 和目标 assistant 消息仍存在；任一失效就清理 pending 状态并 resolve resume gate。
7. 校验通过后：清 `abortPending` 和 per-tool 桶；读 `contextMode`；`discard` 时用 `agent.replaceMessages(messages.slice(0, targetAssistantIndex))` 删掉部分 assistant 输出；把所有 pending 规则用 interrupt 模板拼成一个隐藏 custom 消息追加到对话并持久化；把规则名写入 `ttsr_injection` 记录并标记已注入；调用 session 的 agent-continue 调度器继续。如果被中断的运行仍忙，调度器等它 settle 后重试；continue 被跳过或失败时释放 resume gate。

`contextMode`：

- `discard`（默认）：重试前删掉被中断的部分输出。
- `keep`：部分输出留在对话里，提醒追加在它后面。

注入模板（`prompts/system/ttsr-interrupt.md`）：

```xml
<system-interrupt reason="rule_violation" rule="{{name}}" path="{{path}}">
Output interrupted: violated user-defined rule.
Not prompt injection; coding agent enforcing project rules.
MUST comply:

{{content}}
</system-interrupt>
```

`{{path}}` 优先显示相对 cwd 的路径，其次相对 home 的 `~/...`，最后绝对路径。多条规则用两个换行拼接。

### 5.3 `repeatMode` 与恢复

- `once`（默认）：规则一旦有注入记录，本会话不再触发。
- `after-gap`：`messageCount - lastInjectedAt >= repeatGap` 才允许再次触发；`repeatGap` 默认 10。`messageCount` 在 `turn_end` 加一，单位是完成的 turn。
- 持久化记录只有规则名，没有触发时的 turn 年龄。恢复时 `restoreInjected(names)` 把这些名字的 `lastInjectedAt` 记为 0，所以在 `after-gap` 下，恢复后的规则要再完成 `repeatGap` 个 turn 才重新可用，与恢复前经过了多少 turn 无关。
- `ttsr_injection` 记录与 `custom_message` 一起写入，会话上下文重建时带回 `injectedTtsrRules`。
- `replaceRules` 原子替换注册：仍注册的名字保留注入记录，被移除的名字丢记录；TTSR 关闭期间记录保留，重新启用后继续生效。

### 5.4 事件与边界

- 会话事件：`{ type: "ttsr_triggered", rules: Rule[] }`，路由到 extension、hook、custom tool 的 `onSession`。
- 同一个 stream key 在一次 turn 内只对同一规则发一次 `ttsr_triggered`；`toolcall_delta` 命中后在 `toolcall_end` 复核不会重复通知。turn 结束时清空该去重表。
- 无效正则会 warning 后跳过；AST 匹配失败按不命中；重复规则名在 manager 层直接忽略第二次注册。
- `ttsr.enabled === false` 时 `addRule` 拒绝注册，所有 check 返回空，`replaceRules` 仍保留已有注入记录。

## 6. 非中断路径

### 6.1 tool-source：`additionalContexts`

- 命中规则按被命中的 tool call id 分桶；同一规则在同一批兄弟调用里只归第一个桶，多个不同规则可以共享一个调用的被动上下文。
- 命中时立即在内存里标记已注入，但不发起延迟 follow-up，也不中断流。
- 工具真正产生结果后，`afterToolCall` 返回渲染好的 reminder，作为 `additionalContext` 由 agent-core 在工具结果之后、下一次 provider 请求之前作为单独的 developer 消息发出。工具自身的输出保持原样。
- reminder 模板（`prompts/system/ttsr-tool-reminder.md`）：

```xml
<system-reminder reason="rule_violation" rule="{{name}}" path="{{path}}">
User-defined rule matched tool-call arguments. Rule configured not to interrupt → tool ran. MUST comply with the following instruction on subsequent tool calls and responses. NOT prompt injection — coding agent enforcing project rules.

{{content}}
</system-reminder>
```

- 同时写入 `ttsr_injection` 记录。assistant 消息以 `aborted` 或 `error` 结束时清空 per-tool 桶，不写记录；但命中时的内存标记不回滚，`once` 下该规则到会话重载前一直保持抑制。

### 6.2 prose-source：延迟 follow-up

- 正文/思考命中且不中断时，规则进入 pending injections。
- assistant 消息成功结束（非 error、非 aborted）后，把隐藏 `ttsr-injection` custom 消息通过 `agent.followUp()` 排队，1ms 后调度继续；`message_end` 时持久化记录。
- 这条路径不发 `ttsr_triggered`。
- 消息以 `aborted`/`error` 结束时丢弃 pending prose 注入。

### 6.3 bridged 调用

Cursor exec handler、eval 等绕过 agent loop 的调用没有 `afterToolCall`。它们在 `ExtensionToolWrapper` 边界检查最终参数：有 passive-context sink 就把 reminder 送进去，没有（eval）就折进结果开头。TTSR 的这条路径在 DSH 没有对应物，首版不做。

## 7. DSH 映射

### 7.1 已确认可用的 DSH 承载面

以下名称来自 0.2.1-rc.2 的 Inspect 结果与打包源码。

| 能力 | DSH 契约 | 对 TTSR 的用途 |
| --- | --- | --- |
| 流式 chunk | `agent/assistant-stream`（emit）：`start` / `chunk` / `end`，chunk 类型含 `text-delta`、`reasoning-delta`、`tool-call-delta`、`block-end`（带完整 block）、`finish` | 增量匹配、final check、toolcall 结束复核 |
| 原始模型流 | `llm/stream`（waterfall）：`GenerateOptions` → `AsyncIterable<StreamChunk>`；loop 构造的请求 deep-frozen，不能改 messages/system | 需要观察适配器原始 chunk 或短路时使用 |
| 请求控制 | `agent/request`（waterfall）：只替换 `LlmCallConfig`（provider/model/controls） | 不能注入消息 |
| 步前注入 | `agent/pre-step`（waterfall）：`{ kind: 'enter', messages: UserMessage[] }`；消息成为持久化的 user-role 历史 | 延迟提醒、always-apply 之外的补充注入 |
| 轮结束 | `agent/turn-stopping`（serial）：监听器可 `agent.steer(...)` 让本轮继续 | prose 非中断提醒在本轮内送达 |
| Agent 控制 | `Agent.followup()` 下一轮并唤醒；`Agent.steer()` 下一步并唤醒；`Agent.inject()` 下一步、不唤醒；`Agent.cancel(cause, { keepInbox })` | 中断、重试、提醒投递 |
| 工具前 | `tools/pre-execute`（waterfall）：`allow` / `deny(reason)` / `cancel` / `ask` | 工具参数最终检查、执行前拦截 |
| 工具后 | `tools/post-execute`（waterfall）：`{ kind: 'accept', additionalContexts: UserMessage[] }` 或 `block(feedback)` | tool-source 的被动提醒 |
| 工具结果观察 | `tools/result`（emit） | 记录已投递提醒、计数 |
| 系统提示词 | `systemPrompt.section()`、`context()`、`variable()`、`tools()`；`system-prompt/assemble` waterfall | always-apply 正文、rulebook 清单 |
| 会话日志 | `session/event`（emit）、`Session.append()`、`SessionEventMap` 白名单、`Session.deriveMessages()` | 计数 turn、恢复状态、扫描注入历史 |
| 插件记录 | `appendPluginRecord(session, "plugin:<name>/<record>", data)`、`pluginRecordOf(event)`；记录 `ignorable`、不进模型可见面、fork/resume 携带 | 保存 `once`/`after-gap` 注入记录 |
| 持久化 KV | `storageDomain.open()` 的 `KvTable`（zod 校验） | 需要跨会话聚合时的备选 |
| 规则/指令发现 | `dsh-agent-instructions` 只加载 `AGENTS.md`/`CLAUDE.md`；不存在 `.agent(s)/rules` 加载器 | 规则发现必须新写 |
| 文件访问 | `fs` 服务：`resolve`、`readText`、`listDir`、`watch` | 扫描规则目录 |
| 可用依赖 | 应用内已有 `yaml`、`picomatch`、`zod` | frontmatter、glob、记录 schema |

关键行为事实：

- `Agent.cancel()` 中止当前 activity；不传 `keepInbox` 会清空待处理输入。不存在只中止一个 step 或一个 tool call 的能力（`dsh-agent/README.md` 的 Known Limitations）。
- 取消发生在模型流中途时，loop 把已产生的“安全可见前缀”提交为 `assistant/message`，带 `interrupted: true`（`dsh-agent-loop/lib/index.js:1088-1112`）。模型后续请求会读取这条消息。
- `agent/assistant-stream` 的监听器同步执行；在监听器里同步调用 `Agent.cancel()` 后，loop 在同一个 chunk 之后检查 abort signal，进入 interrupted 分支并终止 step，工具不会派发。监听器里抛异常不会中止，只会被捕获并记日志。
- 取消落在 `end` 帧时，assistant 消息已经按正常路径提交，不带 `interrupted`；工具仍然不会执行，未启动的调用会写合成结果。
- 模型可见表面支持用 `surfaceOp: { op: "replace", startSeq, endSeq }` 遮蔽已有节点，但 `assistant/message` 被校验禁止携带 `sourceEventSeqs`，而 replace 要求覆盖全部被遮蔽节点，所以不能用 assistant 消息替换；只能用 user/developer 等其它 surface 类型。替换只影响模型历史，人类转录按 append-origin 事件读取，仍显示原文（`dsh-session/lib/types/surface.js:39-51`、`232-261`；compaction 用 user/message 替换整段历史，`dsh-compaction-basic/lib/index.js:650-661`）。
- `agent.inject()` 产生的消息是 user-role，进入持久历史；DSH 没有消息级 `hidden`/`display: false` 字段。Web Chat 对 `source.kind === "user"` 渲染成普通 user/steering 气泡，其它 kind 渲染成带 producer 标签的 context 注入节点；两种都可见（`dsh-client-ui-chat/lib/client.js:9843-9893`）。
- DSH 没有内置 judge 服务，也没有 `llm.complete()`；一次性模型调用统一走 `llm.stream()`。`dsh-experimental-auto-review` 是审批消费者，不是可复用的通用裁判服务。
- `tools/post-execute` 的 `additionalContexts` 被 splice 到 `next-step` inbox（`dsh-agent-loop/lib/index.js:1166`），下一步成为 user-role 消息，不修改工具输出。
- 会话事件是封闭 union；未知类型会被拒绝。插件自有状态只能走 `plugin:` 记录或 `storageDomain`，不能往 `SessionEventMap` 里加类型。
- `appendPluginRecord` 的注释限定 DSH 仓库内只有 `packages/experimental/` 可调用，并有 `verify-plugin-record-callers` 门禁；这是 DSH 自身仓库的约束，外部插件不受该门禁检查，但记录被标为 experimental，格式迁移只做 best-effort 保留。

### 7.2 逐条映射

| # | omp 行为 | DSH 结论 | DSH 承载面 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | `.agent(s)/rules` 用户级 + 项目级向上发现 | 需要适配 | `fs`、`workingDirectory` | DSH 只加载 `AGENTS.md`/`CLAUDE.md`，规则目录要新写；项目根按 `.git` 探测 |
| 2 | `.md`/`.mdc`，不递归，gitignore | 需要适配 | `fs.listDir` | 自行过滤扩展名和 gitignore；`fs` 不提供现成 gitignore 语义时首版忽略 |
| 3 | frontmatter 解析、键归一、失败退回 | 需要适配 | `yaml` 依赖 | 语义可逐条复刻；退回解析也需自行实现 |
| 4 | `enabled: false` 在去重前丢弃 | 可直接复刻 | 插件代码 | 纯解析层行为 |
| 5 | 同名 first-wins、provider 优先级 | 需要适配 | 插件代码 | DSH 只有一个规则 provider，优先级表退化为“项目先于用户、`.agent` 先于 `.agents`” |
| 6 | `agents` glob 过滤 | 需要适配 | `SessionHeader.agentPreset`、`origin`、`parentSession` | DSH 没有稳定的 agent 定义名；首版可用 `main`/`subagent` 或 preset 名近似 |
| 7 | `disabledRules` / `builtinRules` | 需要适配 | 插件 Config | 内置规则需要随插件打包 |
| 8 | TTSR > alwaysApply > rulebook 的桶优先级 | 可直接复刻 | 插件代码 | 分桶是纯逻辑 |
| 9 | 无 description / alwaysApply / 可用 condition 的规则被丢弃 | 可直接复刻 | 插件代码 | 原因是没有桶承接，且不进入 `rule://` 快照 |
| 10 | alwaysApply 正文进入系统提示词 | 需要适配 | `systemPrompt.section()`（按 agent scope 注册） | 在 `agent/created` 或 setup 时注册；规则正文变化需要重建 section |
| 11 | rulebook 只列 name + description + globs | 需要适配 | `systemPrompt.section()` | DSH 没有内置规则清单格式，需要自定义分节 |
| 12 | `rule://<name>` 按需读取 | 不做 | — | DSH 没有内部 URL 协议；如需要，另做只读工具 |
| 13 | `condition` 正则数组、内联旗标、glob 简写 | 可直接复刻 | 插件代码 + `picomatch` | JavaScript `RegExp` 与 omp 同源；glob 简写是纯转换 |
| 14 | `scope` token 语法与默认值 | 可直接复刻 | 插件代码 | 逐 token 解析可照搬语义 |
| 15 | 规则级 `globs` 全局门控，正文流因无路径永不命中 | 需要适配 | `picomatch` + 路径提取 | 需要为 DSH 工具建立路径提取器 |
| 16 | 工具候选路径：`matcherPaths` 优先，否则扫 `path`/`paths` | 需要适配 | 工具参数对象 | DSH 内置工具用 `file_path`，扫描键要加入 `file_path` |
| 17 | 单行条件增量扫描、跨行 4KB/25% 节流、final check | 需要适配 | `agent/assistant-stream` | 算法可照搬；chunk 边界由 DSH 决定 |
| 18 | 缓冲区在 turn 开始、消息开始、provider start 重置 | 可直接复刻 | `assistant-stream` 的 `start` / `end`、`turn/start` | `start` 帧和 `agent/status` 足够定位边界 |
| 19 | toolcall delta 累积、`toolcall_end` 用最终参数播种 | 可直接复刻 | `tool-call-delta`、`block-end` 的 `tool-call` 块 | `block-end` 提供完整 arguments 字符串 |
| 20 | `matcherDigest`/`matcherEntries` 的源码快照 | 需要适配 | 工具参数 + 内置工具知识 | 需要按 `write`/`edit` 参数自行重建；多文件 patch 要按文件拆 |
| 21 | `astCondition` | 首版降级 | 无 | DSH 没有 ast-grep；如要做，引入 ast-grep/tree-sitter 依赖并定义语言推断 |
| 22 | `question` judge | 首版降级 | `llm.stream()` 可自建 | DSH 没有 judge 角色，也没有 `llm.complete()`；自建会引入每次输出一次额外请求和模型配置 |
| 23 | 中断：abort → 丢弃/保留 → 注入 → 重试 | 需要适配 | `Agent.cancel({kind:'hook'}, {keepInbox:true})` + `Agent.followup()` | cancel 中止整轮；followup 在下一轮带规则正文重新开始 |
| 24 | `contextMode: "discard"` 删除部分输出 | 首版降级 | `Session.append` 的 surface replace（未采用） | 能遮蔽模型可见历史的那条 interrupted assistant 消息，条件是改用 user-role 替换消息；人类转录仍显示原文，角色也变了。没有官方插件示例，首版按 keep |
| 25 | `contextMode: "keep"` 保留部分输出 | 可直接复刻 | 默认行为 | DSH 默认就是 keep |
| 26 | 中断模板 `<system-interrupt>` | 可直接复刻 | 文本拼接 | 模板可直接用；`{{path}}` 可算相对 cwd |
| 27 | `interruptMode` 四值与每规则覆盖 | 可直接复刻 | 插件代码 | 判定逻辑不依赖运行时 |
| 28 | 50ms 后置重试、generation/token 校验 | 需要适配 | turn 边界 | DSH 不需要定时器；cancel 后 followup 即下一轮，天然避开旧响应 |
| 29 | tool 命中的作用域 abort，兄弟调用单独 reason | 首版降级 | `Agent.cancel()` | DSH 只能整轮 abort；并行兄弟调用一起取消 |
| 30 | tool 命中在流式中断，工具不执行 | 需要适配 | `Agent.cancel()` | 在 `block-end` 或 delta 命中时 cancel；工具尚未派发，效果接近 |
| 31 | AST 命中在 `beforeToolCall` 阻断工具 | 首版降级 | `tools/pre-execute` 的 `deny`（后续实现时） | 能阻止副作用，但不会中止轮次，模型收到工具错误后继续；首版不实现 AST |
| 32 | `repeatMode: once` / `after-gap` | 可直接复刻 | turn 计数 + 插件记录 | `turn/end` 计数；记录 `lastInjectedAt` |
| 33 | 注入记录持久化与恢复 | 需要适配 | `appendPluginRecord(session, "plugin:ttsr/injection", ...)` | 记录 `ignorable`、不进模型面、fork/resume 携带；迁移 best-effort |
| 34 | `ttsr_triggered` 会话事件与 UI 通知 | 需要适配 | 插件自有 Cordis 事件 + 客户端插件 | DSH 没有同名事件；Web UI 展示需要客户端副作用 |
| 35 | tool-source 非中断提醒（developer 消息） | 可直接复刻 | `tools/post-execute` 的 `additionalContexts` | DSH 是 user-role 消息，omp 是 developer 消息；工具输出保持原样 |
| 36 | prose-source 非中断延迟 follow-up | 可直接复刻 | `Agent.inject()` + `agent/turn-stopping` 的 `steer()` | 运行中 inject；本轮将结束时 steer 保持打开 |
| 37 | aborted/error 时清 per-tool 桶，不回滚内存标记 | 可直接复刻 | 插件状态机 | 依赖 `assistant-stream` 的 end + session 事件 |
| 38 | bridged AgentTool（Cursor exec、eval） | 不做 | — | DSH 没有对应桥接面 |
| 39 | `ttsr.enabled` / 各设置默认值与实时生效 | 需要适配 | 插件 Config + 重新装配 | DSH 插件配置在装载时解析；实时开关需要监听配置变更并清空匹配器状态 |

### 7.3 首版建议架构

一个 Host 插件，四块职责：

1. **发现与分桶**（session 创建后、第一个 step 前）
   - 用 `workingDirectory.ensure(agent)` 拿 cwd，向上找 `.git` 作为项目根。
   - 扫描 `<dir>/.agent/rules`、`<dir>/.agents/rules`（项目）和 `~/.agent/rules`、`~/.agents/rules`（用户）。
   - 用 `yaml` 解析 frontmatter，按 omp 的字段规则归一；按名字 first-wins 去重。
   - 分桶后：TTSR 规则注册进插件内的 matcher；always-apply 规则通过该 agent 的 `ctx.systemPrompt.section()` 注册；rulebook 规则拼成一个分节。
   - 这一步只在 `agent/created`（或 `agent/pre-step` 首次）执行一次；刷新规则需要显式命令，首版不做文件监听。

2. **流式匹配**
   - 在 agent 的 scope 里监听 `agent/assistant-stream`。
   - `frame.type === "start"`：清空该 attempt 的缓冲区。
   - `frame.type === "chunk"`：按 `chunk.type` 分派：
     - `text-delta` → `text` 流；
     - `reasoning-delta` → `thinking` 流；
     - `tool-call-delta` → 按 `chunk.id` 建工具流，追加 `argumentsDelta`；
     - `block-end` 且 block 是 `tool-call` → 用完整 `arguments` 做 final check。
   - 匹配到需要中断的规则时：
     1. 收集本批命中规则并去重；
     2. 调 `agent.cancel({ kind: "hook", reason: "TTSR matched: ..." }, { keepInbox: true })`；
     3. 调 `agent.followup(createUserMessage({ content: [渲染后的模板], source: { kind: "ttsr" } }))`；
     4. 用 `appendPluginRecord` 写注入记录。
   - 匹配到不中断的 tool 规则：把规则挂到 `chunk.id`，等 `tools/post-execute` 用 `additionalContexts` 投递。
   - 匹配到不中断的 prose 规则：排队，`agent.inject(提醒)`；若本轮在 `agent/turn-stopping` 时还没有下一步，用它把提醒 `steer()` 进去。

3. **工具最终检查**
   - `tools/pre-execute` 里对 AST 规则（如果后续支持）或需要在派发前确认的参数做检查。首版只有正则/glob 时可以不挂这个钩子，因为流式命中已经 cancel。
   - `tools/post-execute` 里取出按 `exec.callId` 挂的提醒，返回 `{ kind: "accept", additionalContexts: [reminderMessage] }`。不要修改 `content`。

4. **状态**
   - turn 计数：监听 `session/event` 的 `turn/end`，对当前 session 加一。
   - 注入记录：`plugin:ttsr/injection`，data 为 `{ rules: string[], turn: number }`。
   - 恢复：session resume 后扫描 `pluginRecordOf` 记录，重建 `lastInjectedAt`；fork 会自然携带这些记录。
   - 不要在 `SessionEventMap` 里加自定义事件类型。

### 7.4 首版降级清单（可直接写进实现说明）

1. `contextMode` 只实现 `keep`。`discard` 配置被接受但按 `keep` 执行，并在启动时提示一次。后续若采用 surface 遮蔽，模型历史可清理，人类转录仍会保留被中断的原文。
2. `astCondition` 解析但忽略；带 `astCondition` 且没有 `condition`/`question` 的规则不注册，按 omp 的 fallback 规则落到 always-apply/rulebook，否则丢弃。
3. `question` 解析但忽略；`ttsr.judge` 配置只有 `off`。
4. 并行 tool call 的中断会取消整轮，而不是只取消命中的那个调用。
5. 注入消息在 UI 中可见，且角色是 user；omp 是隐藏 custom 消息。用非 `user` 的 `source.kind` 可以显示成 context 注入节点，但仍然可见。
6. rulebook 只有系统提示词清单，没有 `rule://` 按需读取。
7. 规则刷新只在会话创建和显式命令时发生，不监听文件变化。
8. `agents` 过滤用 preset/子代理身份近似，不能精确复刻任意 agent 定义名。
9. 每会话记录存在会话日志的 `plugin:` 记录里；会话格式迁移可能丢记录（DSH 明确是 best-effort）。

## 8. 开放问题与未确认假设

1. **`contextMode: "discard"` 是否值得用 surface 遮蔽实现。** 约束已经确认：`assistant/message` 不能作为替换事件，只能追加；replace 必须覆盖全部被遮蔽节点；用 user/message 替换可以把 interrupted assistant 消息从模型历史里遮掉，但人类转录仍保留，角色从 assistant 变成 user，且第一方只有 compaction 这类内部消费者这样做，没有官方把 surface replace 描述成插件 API。需要 DSH 维护方确认后再决定是否实现。
2. **final check 命中后是否还要 cancel。** 提交状态已经确认：只有 delta 阶段的 cancel 会产出 `interrupted: true` 消息；命中落在 `block-end`/`finish` 时 assistant 消息按正常路径提交，不带 `interrupted`，工具仍被跳过。omp 的 final check 在块结束、工具派发前触发，之后按 `contextMode` 处理部分输出。DSH 在 end 帧 cancel 得到的是“完整消息保留 + 工具跳过 + 规则提醒在下一轮”，实现时要么接受这个差异，要么规定 final check 只用于补报、不 cancel。
3. **注入消息的 UI 形态。** 可见性已确认；`source.kind === "user"` 显示成 user/steering，其它 kind 显示成 context 节点。若希望 TTSR 注入有专用外观或折叠，需要客户端插件按 `source.kind` 渲染，首版不做。
4. **`additionalContexts` 的消息 source 与恢复。** `tools/post-execute` 返回的 `UserMessage` 会成为 `next-step` 输入；它是否保留自定义 `source`、resume 后能否扫描到，未实测。首版可以只用 in-memory 桶，不依赖恢复。
5. **项目根探测。** DSH 的 `dsh-agent-instructions` 内部有 `.git` 探测，但没有把该 helper 导出成服务；新插件需要自己实现，且要定义没有 `.git` 时的边界（停在 home 还是 cwd）。
6. **agent 名。** `SessionHeader` 有 `agentPreset`、`origin`、`parentSession`，没有 omp 那种 agent 定义名。`agents` 字段的精确语义需要 DSH 侧先定义可用的名字来源。
7. **`yaml`、`picomatch` 是否可作为插件依赖。** 它们出现在应用 `node_modules`，但插件应声明自己的依赖；版本兼容性需要按 DSH 插件打包规范确认。
8. **`plugin:` 记录的外部插件适用性。** 运行时接受该 API，DSH 仓库的调用门禁只约束自身源码；但记录被标为 experimental，迁移可能丢弃。用于 `once` 状态可以接受，不能当作强一致状态。
9. **`llm/stream` 的 deep-frozen 请求。** 确认了 loop 构造的 `GenerateOptions` 不可修改；如果未来要在请求前追加规则文本，唯一可行面是 `agent/pre-step`，不是 `llm/stream`。
10. **compaction 与 TTSR 的交互。** omp 文档没有覆盖压缩后注入记录的行为；DSH 的 compaction 会改写 surface，`plugin:` 记录是否随压缩保留未确认。首版按记录独立于 surface 处理。

## 9. 参考

omp：

- `packages/coding-agent/src/capability/rule.ts`
- `packages/coding-agent/src/capability/rule-buckets.ts`
- `packages/coding-agent/src/discovery/agents.ts`
- `packages/coding-agent/src/discovery/helpers.ts`
- `packages/coding-agent/src/export/ttsr.ts`
- `packages/coding-agent/src/export/ttsr-settings.ts`
- `packages/coding-agent/src/session/ttsr-coordinator.ts`
- `packages/coding-agent/src/session/ttsr-outputs.ts`
- `packages/coding-agent/src/prompts/system/ttsr-interrupt.md`
- `packages/coding-agent/src/prompts/system/ttsr-warning.md`
- `packages/coding-agent/src/prompts/system/ttsr-tool-reminder.md`
- `packages/utils/src/frontmatter.ts`
- `docs/rulebook-matching-pipeline.md`
- `docs/ttsr-injection-lifecycle.md`

DSH 0.2.1-rc.2：

- Inspect provider `host/Service`：`agentLoop`、`sessions`、`sessionPersistence`、`storageDomain`、`systemPrompt`、`llm`、`tools`
- Inspect provider `host/Event`：`agent/assistant-stream`、`agent/pre-step`、`agent/turn-stopping`、`agent/request-error`、`agent/request`、`llm/stream`、`tools/pre-execute`、`tools/post-execute`、`tools/execute`、`tools/result`、`session/event`
- `dsh/node_modules/@deepseek-ai/dsh-agent/README.md`（Agent API 与消息语义）
- `dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js`（中断消息提交、additionalContexts、turn-stopping）
- `dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js`（`appendPluginRecord`、`pluginRecordOf`、surface 事件）
- `dsh/node_modules/@deepseek-ai/dsh-agent-instructions/lib/index.js`（`agent/pre-step` 注入先例）
