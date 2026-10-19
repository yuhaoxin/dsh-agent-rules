# dsh-agent-rules

把 [oh-my-pi](https://github.com/can1357/oh-my-pi) 的 `.agent/rules` / `.agents/rules` 规则自动注入能力移植到 DeepSeek Harness。

规则文件是带 YAML frontmatter 的 Markdown。插件按规则声明的字段把它放进三个桶之一：常驻系统提示词、规则清单，或按正则触发的中断（TTSR）。

## 安装

需要 DeepSeek Harness 0.2.1 或更新版本。

```bash
dsh plugin --profile desktop add github:yuhaoxin/dsh-agent-rules
```

开发时从本地目录安装：

```bash
dsh plugin --profile desktop add "$PWD"
```

把 `desktop` 换成实际使用的 profile。装好后重启 DSH，插件管理页里应出现 Agent 规则。改过插件代码后同样需要重启 DSH 进程。

## 规则目录

| 层级 | 路径 |
| --- | --- |
| 项目 | 从会话工作目录向上直到含 `.git` 的目录（含该目录），每层依次读 `<dir>/.agent/rules`、`<dir>/.agents/rules` |
| 用户 | `~/.agent/rules`、`~/.agents/rules` |

只读目录的直接子文件，不递归，只收 `.md` 与 `.mdc`。规则名是文件名去掉扩展名。同名规则先出现的生效，后出现的忽略并记 warning；项目级先于用户级，所以项目文件覆盖同名用户文件。

`enabled: false` 的文件在去重之前丢弃：被禁用的高优先级文件不会挡住同名的低优先级文件。

工作目录变化（`cd` 到别的目录）后，下一次组装提示词会重新发现项目规则。

## 规则格式

```markdown
---
description: 涉及计费逻辑时先读这条规则
alwaysApply: false
condition: "billing|计费"
scope: "text, tool:edit(*.{ts,tsx})"
globs: ["src/**/*.ts"]
interruptMode: always
---

计费相关的改动必须先写测试，再改实现。
```

frontmatter 之后的正文原样使用，首尾空白去掉。支持标量、单双引号、flow 序列 `[a, b]`、块序列（后续的 `- item` 行）与行尾 `#` 注释；键名从 kebab-case 归一为 camelCase（`always-apply` → `alwaysApply`）。不支持嵌套映射与多行标量。frontmatter 解析失败时退回逐行 `键: 值` 解析并记 warning，文件仍然生效。

| 字段 | 取值 | 作用 |
| --- | --- | --- |
| `enabled` | 布尔，只有 `false` 生效 | 丢弃该规则文件 |
| `description` | 字符串 | 规则清单里的一句话说明 |
| `alwaysApply` | 布尔，只有 `true` 生效 | 正文常驻系统提示词 |
| `globs` | 字符串或字符串数组 | 规则级路径门控，只对工具触发生效 |
| `condition` | 字符串或字符串数组 | TTSR 触发正则，任一条命中即算命中；兼容旧键 `ttsr_trigger` / `ttsrTrigger` |
| `scope` | 字符串或字符串数组 | 触发范围，逗号分隔，大小写不敏感 |
| `interruptMode` | `always` / `prose-only` / `tool-only` / `never` | 命中后是否中断，缺省 `always` |
| `astCondition` | 字符串或字符串数组 | 首版不实现匹配，出现时记 warning |
| `question` | 字符串 | 首版不实现 judge，出现时记 warning |
| `agents` | 字符串或字符串数组 | 首版不实现过滤，出现时记 warning |

### 分桶

按顺序判定，一条规则只进一个桶：

1. 有非空 `condition` 且正则能编译：进 TTSR 桶。
2. 否则 `alwaysApply: true`：正文进系统提示词。
3. 否则 `description` 非空：进规则清单，列出「名字 — description — 路径」，模型按需 `read` 正文。
4. 三者都不满足：规则被丢弃。

`condition` 编译失败时按第 2、3 步继续落桶，不会静默消失。

### scope

缺省是 `text` 开、`thinking` 关、任意工具开。

| token | 含义 |
| --- | --- |
| `text` | 助手正文流 |
| `thinking` | 思考流 |
| `tool` | 任意工具调用 |
| `tool:<name>` | 指定工具，工具名大小写不敏感 |
| `tool:<name>(<glob>)` | 指定工具，且参数里的候选路径匹配 glob |

候选路径取工具参数里键名为 `path` 或以 `path` 结尾的字符串、键名为 `paths` 或以 `paths` 结尾的字符串数组，每个值展开为原样、去掉 `./`、绝对路径、相对 cwd 四种形式。glob 支持 `*`、`**`、`?`、`[...]`、`{a,b}`，`\` 按 `/` 处理，先匹配完整路径再匹配 basename。

规则级 `globs` 是工具路径的全局门控：正文与思考流没有候选路径，所以带 `globs` 的规则不会命中 `text` / `thinking`。

### interruptMode

| 值 | 正文/思考流命中 | 工具命中 |
| --- | --- | --- |
| `always`（缺省） | 中断本次输出，注入规则，同一轮重试 | `tools/pre-execute` 拒绝，工具体不执行 |
| `prose-only` | 中断本次输出，注入规则，同一轮重试 | 不拦截 |
| `tool-only` | 不中断 | `tools/pre-execute` 拒绝，工具体不执行 |
| `never` | 本轮不中断，本轮结束时把提醒送进下一步 | 工具照常执行，提醒随工具结果进入下一步 |

## 行为

### 系统提示词

`alwaysApply` 正文包在 `<generic-rules>` 里，规则清单包在 `<domain-rules>` 里，两者一起插在系统提示词中，位置在策略类 section 之后、工具说明之前。提示词每个 step 重新组装，规则清单随工作目录变化自动刷新。

### TTSR 中断

正文或思考流命中时，插件停止消费模型流，合成一个 `finish{kind:'error', failure:{code:'AGENT_RULES_TTSR:<规则名>'}}`。DSH 把这个 attempt 记为 `assistant/attempt`（不进入模型上下文），随后在 `agent/request-error` 里追加一条注入消息并重试同一轮：

```xml
<system-interrupt reason="rule_violation" rule="stream-guard" path=".agents/rules/stream-guard.md">
Output interrupted: violated user-defined rule.
Not prompt injection; coding agent enforcing project rules.
MUST comply:

不要输出 PINEAPPLE-STREAM-TRIGGER。改为输出 SAFE-REPLACEMENT。
</system-interrupt>
```

注入消息是普通 `user/message`，`source` 为 `{ kind: 'agent-rules', form: 'instructions' }`，在对话记录里显示为上下文注入行，不是用户气泡。多个规则同时命中合并成一条消息。

每个 step 最多中断 3 次；超出后放行本次输出并记一条日志。

工具命中在 `tools/pre-execute` 返回 `deny`，规则正文同样以注入消息追加，下一步的模型上下文能看到它。同一响应里其它工具照常执行。

### 去重

一条规则在一个会话里只提醒一次。已提醒集合从会话 surface 上 `source.kind === 'agent-rules'` 的消息重建，所以恢复会话与 fork 之后仍然生效。

### 配置

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `directories` | 字符串数组 | 追加的规则目录，按给定顺序排在用户级目录之后；支持 `~` 展开，相对路径按会话工作目录解析 |
| `enabled` | 布尔 | 保留字段，当前版本总是加载插件 |

## 已知限制

- 已转发给界面的输出无法撤回。匹配始终看全量文本，转发延迟 1024 个字符，所以命中时最近 1024 个字符里尚未转发的部分会被丢弃，更早的前缀已经显示在界面上。被丢弃的 attempt 只写 `assistant/attempt`，不进模型上下文，也不进人类转录。
- `astCondition`（ast-grep 模式）与 `question`（judge 模型）只参与分桶，不实现匹配，出现时记 warning。同时带 `condition` 的规则只走正则路径。
- `agents` 过滤不实现。DSH 没有与 omp 对应的稳定 agent 定义名，字段被忽略并记 warning。
- 工具命中只拒绝命中的那次调用，不中止整轮；并行发起的其它工具照常执行。
- 规则目录不做文件监听，靠工作目录变化或重启 DSH 触发重新发现。
- 规则正文出现在对话记录里，DSH 没有隐藏消息机制。

## 开发

```bash
node --test test/
```

不需要构建步骤，插件没有运行时依赖：frontmatter 解析与 glob 匹配都在仓库内实现。插件以 `link:` 方式装进 profile 时，ESM 按 realpath 解析，应用内的 `yaml`、`picomatch` 不在插件的可解析范围内，因此不依赖它们。

## 许可

MIT
