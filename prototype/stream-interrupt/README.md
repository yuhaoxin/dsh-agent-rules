# 流中断重试原型

一次性探针，回答一个问题：DSH 能否在模型输出命中规则时中断本次流、注入规则并在同一轮重试，且被丢弃的部分输出不进入模型上下文。

## 运行

```sh
AIFLASHAPI_API_KEY=... ./run.sh "Say exactly: PINEAPPLE"
```

脚本在临时 DSH_HOME（默认 `$TMPDIR/dsh-agent-rules-proto`）里建 profile，不碰 desktop profile。环境变量：

| 变量 | 取值 | 作用 |
| --- | --- | --- |
| `PROBE_MODE` | `buffer`（默认）/ `forward` | 命中前是否把 chunk 转发给 UI |
| `PROBE_CHANNEL` | `user`（默认）/ `developer` / `instructions` | 注入消息的角色与 source |
| `PROBE_TRIGGER` | 词（默认 `pineapple`） | 命中词，大小写不敏感 |
| `PROBE_RULE` | 文本 | 注入的规则正文 |
| `PROBE_MAX_RETRIES` | 数字（默认 1） | 同一 step 的重试上限 |
| `PROBE_EMIT_RETRY_EVENT` | `1` | 额外 append 一条 `llm/retry` |

## 已验证的链路

`llm/stream` listener 包住 `next()`，累积 text/reasoning delta。命中后停止消费底层迭代器，只 yield 一个合成 `finish{kind:'error', failure:{code:'PROTO_TTSR:rule-1'}}`。loop 把这次 attempt 写成 `assistant/attempt`（非 surface 事件，不进模型上下文），随后派发 `agent/request-error`。listener 在那里 append 一条 surface 消息并返回 `{kind:'retry'}`；loop 重新 `prepareRequest`，`deriveMessages()` 带上新消息。

durable log 的实际顺序：

```
17 assistant/attempt            ← 被丢弃的 attempt，非 surface
18 user/message  append         ← 注入的规则
19 assistant/message append     ← 重试成功
21 turn/end completed
```

## 失败模式（实测）

| 做法 | 结果 |
| --- | --- |
| 命中后不发 finish | `BlockAssembler` 按 `stop` 收尾，部分输出作为完整 `assistant/message` 提交 |
| 命中后又转发 adapter 的 finish | attempt 里出现两个 finish，最终提交空消息，`final` 为空 |
| 不设重试上限 | 同一 step 无限重试；实测 30+ 次，模型持续命中触发词 |
| `developer/message` 漏 `turn`/`step` | append 抛错：`developer/message turn must be a non-negative integer` |
| 在 `session/event` 监听器里 append | 抛错：`session append cannot reenter while another append is being published` |
| 在 `llm/stream` 迭代回调里 append | 可以，append 已返回，不会重入 |

## 注入通道的实测差异

同一份规则「Reply with exactly OK and nothing else.」，命中后注入，看重试请求是否遵守：

| 通道 | 重试请求里的角色 | 3 次试验结果 |
| --- | --- | --- |
| `source.kind='user'` | user | 遵守 |
| `source.kind='agent-instructions'` | user（带 form） | 2/3 遵守 |
| `developer/message` | developer | 不遵守 |

样本小，只说明三条通道都能进入重试请求并生效；遵守率差异不是稳定结论。

## 局限

- `forward` 模式已经发出的 chunk 无法撤回。append 一条 `llm/retry` 会让 Chat 客户端 `resetForRetry` 清空该 step 已渲染的 assistant 块，但这依赖客户端对 `llm/retry` 的处理，且 durable log 里仍保留那次 `assistant/attempt`。
- 每会话每规则的状态放在进程内存，进程重启后丢失。
- 会话标题、压缩请求也带 `sessionId`，必须用 `options.purpose` 过滤。
