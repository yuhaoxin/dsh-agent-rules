# DSH 流中断与重试能力研究

- 研究对象：DeepSeek Harness 0.2.1-rc.2，安装于 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/`
- 结论日期：2026-10-19
- 证据来源：安装包内的 `lib/index.js` 运行时实现，以及 Host 通过 `cordis_inspect` 暴露的事件契约。安装包声明了 `lib/types/*.d.ts`，但这些文件在 asar 中不存在（`read` 返回 not found），因此类型结论以运行时代码和 Host 契约为准。
- 下文包路径省略前缀 `node_modules/@deepseek-ai/`；`LOOP` 指 `dsh-agent-loop/lib/index.js`，`LLM` 指 `dsh-llm/lib/index.js`，`SESSION` 指 `dsh-session/lib/index.js`。

## 结论

| 能力 | 结论 | 关键原因 |
| --- | --- | --- |
| 用 `agent.cancel()`（abort turn signal）中止当前流并让 loop 自动重试 | **NO-GO** | abort 走 loop 的 interrupted 分支，部分输出以 `assistant/message {interrupted:true}` 落盘并进入模型上下文；turn 以 `aborted` 结束，不进入 `agent/request-error` |
| 在 `llm/stream` listener 里停止转发，并 yield 自己的 `finish` chunk | **GO** | loop 把 listener 返回的 `AsyncIterable<StreamChunk>` 当作模型流；`finish.kind === 'error'` 会进入 `agent/request-error` |
| 把失败 attempt 的部分输出排除出模型上下文 | **GO** | 失败 attempt 只写 `assistant/attempt`；该事件不是 surface event，`deriveMessages()` 不会包含它 |
| 从 durable log 或已发布的 UI 帧里彻底删除部分输出 | **NO-GO** | session log 只追加，无删除 API；每个 chunk 到达时已通过 `agent/assistant-stream` 发布；`assistant/message` 不能做 surface replace |
| 在重试请求里注入规则文本 | **GO（限定通道）** | 必须在 `agent/request-error` 里追加一条 surface `user/message`；重试从 session surface 重新派生 messages |
| 用 `agent.inject()` / `agent.followup()` 把文本带进重试请求 | **NO-GO** | 两者写 inbox；重试循环不 claim inbox。`inject` 落在下一个 step，`followup` 落在下一个 turn |
| 官方的“abort 后带额外上下文重试”通用 API | **不存在** | 有同类先例：`dsh-compaction-image-offload` 用 `agent/request-error` + durable projection + `{kind:'retry'}` |
| 内置 `dsh-llm-retry` 会把 aborted 当成可重试错误 | **NO（默认策略）** | 重试只按 `failure.code` 判定；`ABORTED` 不在默认集合；turn signal 已 abort 时 loop 在 waterfall 之前就抛出 |

一句话结论：原问法的“中断当前流 + 丢弃部分输出 + 注入规则 + 自动重试”不能通过 abort 实现；可行的路径是 **不 abort turn signal，由 `llm/stream` listener 短路底层流并合成一个 `finish {kind:'error'}`，再由 `agent/request-error` listener 追加 surface 消息并返回 `{kind:'retry'}`**。部分输出可以排除出模型上下文，但无法从日志或已发布的流帧中撤回。

---

## 1. 调用链：waterfall 在哪里被调用

每次模型 attempt 的调用顺序：

1. `LOOP:1051-1052`：`step()` 的 attempt 循环顶部调用 `prepareRequest(turn, step, signal)`。
2. `LOOP:1201`：`prepareRequest` 调用 `llm.prepareCall(proposedConfig, signal)`，拿到绑定当前 adapter 注册的 prepared call。
3. `LOOP:1075-1078`：`buildRequest(...)` 生成冻结的请求对象。
4. `LOOP:1084`：

```js
const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request);
```

5. `LLM:2249-2259`：`preparedCall.stream` 只允许派发一次，随后进入 `streamWithRegistration`。
6. `LLM:2393-2398`：

```js
stream(options) { return this.streamWithRegistration(options); }
streamWithRegistration(options, prepared) {
  return this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared));
}
```

因此 `preparedCall` 路径和直接 `llm.stream()` 路径都会经过 `llm/stream` waterfall，每个 attempt 一次。重试会重新 `prepareRequest`，得到新的 prepared call 和新的 waterfall 调用。

请求对象由 `LOOP:1281-1288` 构造：

```js
return markAgentLoopRequest(Object.freeze({
  ...header.config,
  messages: boundaryMessages,          // session.deriveMessages()，LOOP:1274
  toolHistory: session.toolHistory(),
  ...header.tools !== void 0 ? { tools: header.tools } : {},
  sessionId: this.session.id,
  signal                              // turn 的 AbortSignal
}));
```

对象已冻结并带 `markAgentLoopRequest` 标记（`LLM:377-388`）。Host 契约对 `llm/stream` 的说明是：调用 `next()` 到达 adapter 流，或者 yield 自己的 chunk 短路；loop 构造的请求是深冻结的，listener 只能读，不能改写 messages。

---

## 2. StreamChunk 的消费路径与落盘

### 2.1 消费

`LOOP:1088-1091`：

```js
for await (const chunk of stream) {
  signal.throwIfAborted();
  live.push(chunk);
}
```

`live.push`（`LOOP:396-410`）同时做三件事：

1. `AssistantStreamAccumulator.push`：压缩成 durable 的 compact stream。
2. `BlockAssembler.push`：累积 text / reasoning / tool-call 参数，记录 usage 和 finish。
3. `dispatch.emit("agent/assistant-stream", { frame })`：发布实时帧。

每个 chunk 到达就发布，没有“延迟提交”或撤回机制。

### 2.2 落盘结果

| 流结束方式 | durable 事件 | 是否进模型上下文 |
| --- | --- | --- |
| `finish.kind === 'stop'` / `'tool-calls'` | `assistant/message`（`LOOP:1156-1162`，`surfaceOp:'append'`） | 是 |
| `finish.kind === 'max-tokens'` | `assistant/message`，tool-call block 被 `BlockAssembler` 丢弃（`LOOP:1163`，`LLM:1051-1070`） | 是 |
| `finish.kind === 'error'` 或 `'aborted'`，且 signal 未 abort | `assistant/attempt`（`LOOP:1131-1135`），无 `surfaceOp` | 否 |
| signal 在流中被 abort | `assistant/message {interrupted:true}`（`LOOP:1096-1112`），只保留非空白的 text/reasoning（`LLM:1088-1095`） | 是 |
| listener 或消费者抛错，且已 `live.start()`、signal 未 abort | `assistant/attempt`（`LOOP:1118-1122`） | 否 |
| 在 `live.start()` 之前抛错 | 无 settlement（`LOOP:1094`） | 否 |

`assistant/attempt` 不是 surface event。`SESSION:157-163` 定义 surface 类型只有：

```js
const SURFACE_EVENT_TYPES = new Set([
  "system/message", "developer/message", "user/message",
  "assistant/message", "tool/result"
]);
```

`SESSION:217-229` 的 `deriveEventMessage` 对其他类型返回 `null`；`SESSION:1654-1687` 的 `deriveMessages()` 只遍历 `session.surface.nodes`，注释写明“surface is the single source of derived history”。

### 2.3 能否丢弃或替换

不能删除。`Session` 的公开写入口只有 `append`（`SESSION:1517-1538`），日志只追加，没有删除、截断或回滚方法。

`assistant/message` 也不能用 surface replace 覆盖：

- `SESSION:316`：`assistant/message` 不能携带 `sourceEventSeqs`。
- `SESSION:330-331`：replace 必须用 `sourceEventSeqs` 列出全部被遮蔽的 surface 节点。

两条约束互斥，因此 `assistant/message` 不能被替换；loop 只用 replace 处理 `system/message`（`LOOP:283-295`）。

可以做到的是“不进入模型上下文”：失败 attempt 走 `assistant/attempt`，模型后续看不到它。已经发送给 UI 的 `agent/assistant-stream` 帧无法撤回；是否在 UI 留痕取决于 UI 对 attempt 帧的处理。durable transcript 的消息源是 append 型 surface 事件（`SESSION:181-194` 的注释），`assistant/attempt` 不在其中。

---

## 3. 三种干预方式的具体后果

### 3.1 listener 抛错

流迭代期间抛错会传播到 `LOOP:1093-1126`：

```js
} catch (error) {
  if (!started) throw error;
  try {
    if (signal.aborted) { /* interrupted message */ }
    else live.settle("assistant/attempt", () => this.session.append("assistant/attempt", {
      turn, step, stream: live.stream
    }).seq);
  } catch (settlementError) { /* AggregateError */ }
  throw error;
}
```

- signal 未 abort：写 `assistant/attempt`，然后重新抛出。
- `step()` 的 catch（`LOOP:1168-1171`）在 attempt 已 settled 时不再 `abandon()`，继续抛。
- `turn()` 的 catch（`LOOP:1010-1026`）把它转成 `turn/end {kind:'error'}`，发出 `agent/error`，`kick()` 吞掉异常。
- **不会进入 `agent/request-error`，不会重试。**

这符合 `LLM:2304-2308` 的边界说明：adapter 的失败被转换成终结 finish chunk，middleware 和消费者的失败保持抛出。

### 3.2 abort turn signal（`agent.cancel`）

`LOOP:1088-1089` 在每个 chunk 前检查 `signal.throwIfAborted()`。abort 后下一次检查抛出，进入 `LOOP:1096-1112`：

```js
if (signal.aborted) {
  const content = live.interruptedBlocks();
  if (content.length > 0) live.settle("assistant/message", () => this.session.append("assistant/message", {
    turn, step,
    message: createAssistantMessage({ content, source: {...} }),
    interrupted: true,
    ...live.usage === void 0 ? {} : { usage: live.usage },
    stream: live.stream
  }, { surfaceOp: "append" }).seq);
```

结果：

- 部分 text/reasoning 以 `assistant/message`、`interrupted: true` 落盘，**进入模型上下文**。tool-call block 被丢弃，因为中断发生在派发之前。
- 重新抛出后 `turn()` 记录 `turn/end {kind:'aborted', reason}`（`LOOP:1010-1018`）。
- `agent.cancel` 默认先 `inbox.clear()` 并清除 `wakeRequested`（`LOOP:815-821`），所以随后注入的消息会被丢弃。
- **不会进入 `agent/request-error`，不会重试。**
- 即使 listener 同时 yield 一个合成的 `finish`，abort 后的 `throwIfAborted()` 也会先抛出：合成 finish 可能根本没被 `live.push`，即使 push 了，catch 仍按 `signal.aborted` 走 interrupted 分支。

### 3.3 listener 短路并 yield 自己的 chunk

Host 契约明确支持“yield your own chunks to short-circuit”。实际行为取决于短路的内容：

| listener 行为 | loop 看到的结果 |
| --- | --- |
| 停止转发，yield 自己的 `finish {kind:'error', failure}` | 走 `LOOP:1130-1146`：写 `assistant/attempt`，进入 `agent/request-error`，返回 retry 则重试 |
| yield `finish {kind:'aborted', failure}`，signal 未 abort | 与 `error` 同路径（`LOOP:1130` 同时判断两种 kind），是否重试由 `failure.code` 决定 |
| 停止转发，不发 finish | `BlockAssembler.finish` 默认 `{kind:'stop'}`（`LLM:1100-1103`），部分输出被当作完整 `assistant/message` 提交 |
| yield 自定义 text / reasoning / tool-call chunk | loop 当作模型输出，正常组装和提交；不会有“这不是模型说的”的区分 |
| 消费 `next()` 后提前 `break` / `return` | 底层 async iterator 的 `return` 被调用，adapterStream 的 `finally` 关闭 adapter iterator（`LLM:2375-2380`），HTTP 流随之取消 |
| 从不调用 `next()` | adapter 流不会启动，也不存在需要关闭的请求 |

推荐路径是 3.3 表格第一行：**短路 + 合成 `finish error`**，不触碰 turn signal。

---

## 4. 重试策略：`dsh-llm-retry`

### 4.1 接线

loop 只在 finish 为 `error` 或 `aborted` 时调用 waterfall（`LOOP:1129-1146`）：

```js
const finish = live.finish;
if (finish.kind === "error" || finish.kind === "aborted") {
  live.settle("assistant/attempt", () => this.session.append("assistant/attempt", {
    turn, step, stream: live.stream
  }).seq);
  const action = await this.dispatch.waterfall("agent/request-error", {
    turn, step,
    provider: request.provider,
    failure: finish.failure,
    retryPolicy: preparedCall?.retryPolicy,
    signal
  }, () => Promise.resolve(void 0));
  signal.throwIfAborted();
  if (action?.kind !== "retry") throw new LlmError(finish.failure.message, finish.failure.code, finish.failure);
  continue;
}
```

`continue` 回到 `while (true)` 顶部，重新 `prepareRequest`、重新派发 waterfall、重新 `buildRequest`。默认下游返回 `undefined`，即终止并抛 `LlmError`。

`@deepseek-ai/dsh-llm-retry` 只注册一个 `agent/request-error` listener（`dsh-llm-retry/lib/index.js:175-178`），本身不接触 stream，也不是 adapter 或 service。

### 4.2 判定

`dsh-llm-retry/lib/index.js:160-164`：

```js
} else if (!policy.retryableCodes.includes(failure.code)) return next();
const previous = ctx.sessionProjections.stateOf(agent.session, "llmRetry")[retryStateKey(provider, policyKey)];
const previousRetry = previous?.retry ?? 0;
if (policy.mode === "normal" && previousRetry >= policy.maxRetries) return next();
```

判定只读 `failure.code` 和 `providerRetryAfterMs`，不读 `FinishReason.kind`。默认集合（`LLM:251-257`）：

```js
["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"]
```

具体结论：

- `finish.kind === 'aborted'`：默认不重试。`ABORTED` 不在集合中；如果 turn signal 已 abort，loop 在 interrupted 分支就结束了，根本不到 waterfall。
- `finish.kind === 'error'`：按 code 重试。`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE` 会重试；`AUTH`、`QUOTA`、`INVALID_REQUEST`、`CONTEXT_WINDOW_EXCEEDED`、`MALFORMED_RESPONSE`、`UNKNOWN` 不重试。
- 抛出的 `AbortError`：adapter 边界把它转成 `finish`（`LLM:2350-2352`、`LLM:2402-2413`）；非 HarnessError 的 code 是 `UNKNOWN`（`LLM:471-473`），不在默认集合。
- DeepSeek adapter 把 turn signal 的取消映射成 `ABORTED`（`dsh-llm-deepseek/lib/index.js:2153-2156`）。
- `always` 模式不检查 code、没有重试次数上限（`dsh-llm-retry/lib/index.js:153-159`）。

参数：默认 `maxRetries: 5`、`initialDelayMs: 500`、`maxDelayMs: 10000`、`jitterRatio: 0.1`（`LLM:247-250`）；退避指数翻倍加 jitter（`dsh-llm-retry/lib/index.js:44-49`）；每次重试先 append `llm/retry`，等待后再 append `llm/retry-started`（`:141-149`）。计数存在 `llmRetry` session projection 中，`step/start` 或 `turn/end` 清零（`:88-107`），即每个 step 独立计数。

### 4.3 重试时的 messages 来源

不是复用失败请求的 `messages` 数组，而是每次 attempt 重新组装：

- `LOOP:1051-1052`：每次循环都 `prepareRequest`。
- `LOOP:1274`：`const boundaryMessages = session.deriveMessages();`，从当前 surface 重新派生。
- `LOOP:1049`：`renderedPrompt` 在 attempt 循环外只渲染一次，重试复用同一系统提示。
- `LOOP:1053-1073`：runtime context 每次 attempt 重新投影；快照变化时追加新的 `user/message`。
- `LOOP:1066-1073`：非 runtime-context 的 `decision.messages` 只在 `firstAttempt` 时 append，重试不重复写用户消息（`else` 绑定内层 `if`，外层 `firstAttempt` 为 false 时整段跳过）。
- `LOOP:1191-1195`：每次 attempt 都重新跑 `agent/request` waterfall，所以 provider/model 和 `retryPolicy` 可以在两次 attempt 之间被插件改变；重试插件应保持路由稳定。

失败 attempt 的 partial 输出只存在于 `assistant/attempt`，不在 surface，因此不会出现在下一次请求里。成功 attempt 才写 `assistant/message`（`LOOP:1148-1162`）。

---

## 5. 流回调里的 Agent API

### 5.1 找到 agent

`options.sessionId` 由 `LOOP:1286` 写入，等于 session id。`ctx.agents.get(id)` 返回 live agent（`dsh-agent/lib/index.js:596-598`）：

```js
get(id) { return this.store.get(id)?.agent; }
```

`llm/stream` 也会被非 loop 调用使用（compaction、session-title 等），这些请求可能没有 `sessionId`。用 `LLM:377-388` 导出的 `isAgentLoopRequest(options)` 区分，找不到 agent 时不要假定。

### 5.2 可用方法

`ReactLoopAgent` 的公开控制面（`LOOP:800-821`）：

| 方法 | 行为 | 在流回调里调用的效果 |
| --- | --- | --- |
| `cancel(cause, options?)` | 默认清空 inbox，然后 abort turn signal | 当前流在下一个 `throwIfAborted()` 处终止；部分输出以 interrupted `assistant/message` 落盘；turn 以 aborted 结束；不重试 |
| `inject(message)` | 写入 `next-step` inbox，不唤醒 | 当前流继续；step 正常结束后，下一次 `preStep` claim 它并开启同一 turn 的新 step。对**当前 attempt 的重试请求无效**；turn 出错时滞留且无 wake，被 cancel 时清空 |
| `steer(message)` | 写入 `next-step` inbox，并调用 `wakeDriver` | 运行中的非 abort 阶段 `wakeDriver(false)` 不 latch，实际效果来自 `nextStep` 非空：step 正常结束后继续新 step。用于 `agent/turn-stopping` 里让 turn 继续；step 抛错时滞留 |
| `followup(message)` | 写入 `next-turn` inbox，并调用 `wakeDriver` | 当前流继续；turn 正常结束后 `inbox.hasPending` 为真，`kick()` 的 `while (await this.turn())` 开启新 turn。若当前 turn 抛错，异常路径跳过 `LOOP:1037-1041`，消息滞留且没有 wake |

`agent.abort()` 在 0.2.1-rc.2 不存在；终止入口是 `cancel`，cause 为 `{kind:'user'|'parent'|'disposed'}` 或 `{kind:'hook', reason}`。

### 5.3 安全性与重入

在 `llm/stream` 的迭代回调里调用上述方法不会造成 session append 重入：每次 append 都已返回，事件派发发生在 append 返回之后。`Session.append` 只在另一个 append 正在发布时拒绝重入（`SESSION:1568-1572`）；`session/event` 的监听器在 `commit` 内同步执行，从那里再 append 会触发这条拒绝。

`cancel` 是安全但终态的；它会把 turn 推进到 aborted，无法在同一 turn 内恢复重试。`inject` / `steer` / `followup` 都只写 inbox，是持久的、可观察的，但不会改变已经构造好的请求。

---

## 6. 官方先例与推荐路径

### 6.1 官方先例：`dsh-compaction-image-offload`

该插件的模式与本题最接近（`dsh-compaction-image-offload/lib/index.js:139-145`）：

```js
ctx.on("agent/request-error", ({ agent, failure, signal }, next) => {
  if (failure.code !== IMAGE_OFFLOAD_REQUIRED_CODE || failure.offloadImages === void 0 || signal.aborted) return next();
  if (!offloadOldestImages(agent.session, agent.session.surface.nodes, failure.offloadImages)) return next();
  return Promise.resolve({ kind: "retry" });
});
```

它先 append 一个 durable 的 `image/offload` 决策（`:14-43`，带 message projection），再返回 `{kind:'retry'}`。重试请求从更新后的 surface 派生，被选中的图片变成 `offloaded: true`。

这证明 DSH 的设计支持“请求失败 → 持久化地改变下一次请求的派生结果 → 重试”，但没有通用的“abort with context”API；每个插件自己定义 failure code、自己的 durable 决策和自己的 retry listener。

### 6.2 推荐的 TTSR 文本/思考流路径（GO）

1. 插件注册一个 `llm/stream` listener。只处理 `isAgentLoopRequest(options)` 的请求，跳过 compaction/title。
2. listener 包装 `next()`，累积 text / reasoning delta 做规则匹配。两种策略：
   - **转发式**：立即把 chunk 转发给 loop，命中后停止消费并合成 finish。UI 已经看到部分输出；模型上下文里没有。
   - **缓冲式**：在 listener 内缓冲，确认未命中后再转发。UI 看不到违规片段，但首 token 延迟等于判定窗口长度，内存随窗口增长。
3. 命中规则时：
   - 停止消费底层 iterator（`for await` 里 `break` 或显式 `return()`），让 adapterStream 关闭 HTTP 流。
   - 不再转发 adapter 的终结 finish，避免一个 attempt 里出现两个 finish。
   - yield 一个合成 chunk：`{ type: 'finish', reason: { kind: 'error', failure: { code: 'AGENT_RULES_TTSR:<ruleId>', message: ... } } }`。
   - **不要**调用 `agent.cancel()`，不要 abort `options.signal`。
4. loop 走 `LOOP:1130-1146`：把当前 attempt 的 stream 写成 `assistant/attempt`（非 surface），然后调用 `agent/request-error`。
5. 插件注册 `agent/request-error` listener：
   - 识别自己的 failure code，提取 rule id。
   - 用 `agent.session.append("user/message", createUserMessage({ content: [...], source: { kind: "user" } }), { surfaceOp: "append" })` 追加规则提醒。必须带 `surfaceOp`，否则 `SESSION:298-311` 会拒绝 surface 事件。
   - 返回 `{ kind: "retry" }`。如果先 `await next()`，下游返回 `undefined` 时仍可返回 retry；下游已返回 retry 时直接沿用。
6. loop `continue`：重新 `prepareRequest`，`session.deriveMessages()` 已经包含规则消息，新的 attempt 带上规则。
7. 自己做“每条规则每会话只提醒一次”和最大重试次数的保护。`dsh-llm-retry` 的计数只针对它自己重试的 code，不会约束插件的自定义 retry。

参考骨架（TypeScript 语义，未编译）：

```ts
ctx.on("llm/stream", async function* (options, next) {
  if (!isAgentLoopRequest(options) || options.sessionId === undefined) {
    yield* next();
    return;
  }
  const inner = next()[Symbol.asyncIterator]();
  let text = "";
  try {
    while (true) {
      const { done, value } = await inner.next();
      if (done) return;
      if (value.type === "text-delta" || value.type === "reasoning-delta") {
        text += value.text;
        const hit = matchRules(text);          // 只做判定，不发送
        if (hit !== undefined) {
          await inner.return?.();               // 关闭底层流
          yield { type: "finish", reason: { kind: "error", failure: {
            code: `AGENT_RULES_TTSR:${hit.id}`,
            message: `rule ${hit.id} matched streamed output`,
          } } };
          return;
        }
      }
      yield value;
    }
  } finally {
    await inner.return?.();
  }
});

ctx.on("agent/request-error", async ({ agent, failure, signal }, next) => {
  const hit = parseRuleCode(failure.code);
  if (hit === undefined || signal.aborted) return next();
  if (alreadyReminded(agent.session, hit.id)) return next();  // 由 projection/内存状态决定
  const message = createUserMessage({
    content: [{ type: "text", text: renderRuleReminder(hit) }],
    source: { kind: "user" },
  });
  agent.session.append("user/message", message, { surfaceOp: "append" });
  return { kind: "retry" };
});
```

注意：上面的 listener 如果在命中前已经把 text delta 转发给 loop，UI 会看到那段输出。要完全避免 UI 留痕，把 `yield value` 推迟到规则判定之后（缓冲式）。

---

## 7. 失败模式清单

| 做法 | 结果 |
| --- | --- |
| `agent.cancel()` 后期待重试 | turn 以 aborted 结束；interrupted `assistant/message` 进入模型上下文；inbox 被清空；不调用 `agent/request-error` |
| listener 抛错 | turn 以 error 结束；写 `assistant/attempt`；不重试；`agent/error` 发出 |
| listener 停止转发但不发 finish | `finish` 默认 stop，部分输出被当作完整回答提交 |
| 合成 finish 后又转发 adapter 的 finish | attempt 里出现两个 finish；`BlockAssembler` 以最后一个为准，durable stream 记录两份 |
| 自定义 failure code + 依赖默认 retry | 默认策略不认识该 code，直接抛错，不重试 |
| 自定义 retry listener 不设上限 | 规则持续命中时同一 step 无限重试 |
| 在 `agent/request-error` 里调用 `agent.inject()` | 消息进入 next-step inbox，不在重试请求里；重试成功后才在下一步出现 |
| 在 `agent/request-error` 里调用 `agent.followup()` | 消息进入 next-turn；重试仍在同一 turn，规则不在该请求里 |
| append 规则消息时漏掉 `surfaceOp` | `Session.append` 抛出：surface-eligible 事件必须带 marker |
| 尝试 replace `assistant/message` | 校验拒绝：assistant/message 不能带 `sourceEventSeqs`，replace 又要求列出全部被遮蔽节点 |
| 在 `llm/stream` 里改 `options.messages` | 请求已深冻结，写入抛错（Host 契约明确说明） |
| abort 后仍返回 `{kind:'retry'}` | `LOOP:1144` 的 `signal.throwIfAborted()` 先抛出，retry 不生效 |
| 把非 loop 请求（compaction/title）也包装 | 没有 `sessionId`/agent，规则判定和注入都无目标；用 `isAgentLoopRequest` 过滤 |

---

## 8. 替代路径

### 8.1 `tools/pre-execute` + `tools/post-execute`（工具调用规则）

- `tools/pre-execute` waterfall 可以返回 `{kind:'deny', reason}`、`{kind:'cancel'}` 或 `{kind:'ask'}`（Host 契约）。
- `tools/post-execute` 可以 `block`、替换 result 或返回 `additionalContexts: UserMessage[]`（Host 契约）。
- loop 会把 `additionalContexts` 通过 `acceptContext` 写入 next-step inbox（`LOOP:570-573`、`LOOP:1166`），在下一个 step 边界 claim 并进入请求。
- 这条路径不重试已经完成的请求，也不丢弃 assistant 输出；它把纠正信息放进下一步。工具调用已经被拦截时这是正确的 seam。

### 8.2 `agent/turn-stopping` + `agent.steer`

turn 本来要结束时，`agent/turn-stopping`（serial，`LOOP:1001-1004`）的 listener 可以 `agent.steer(message)`。`LOOP:1007` 发现 `nextStep` 非空就不关闭 turn，改为进入新 step。Host 契约明确写了这个用法：“a listener that objects steers (`agent.steer(...)`) and the machine re-reads its inbox”。

适合“回答已经完成，但需要补一条纠正/继续”的场景。不重试原请求，违规输出保留在 transcript 里。

### 8.3 `agent/pre-step`

在 step 开始前替换 `messages` 或 reject（`LOOP:902-927`，Host 契约）。适合基于 session 状态（而不是本次流内容）的规则判定；对“已经流出的文本”太晚。

### 8.4 `agent/request`

每个 attempt 都会跑（`LOOP:1191-1195`），但只能改 provider/model/reasoningEffort/temperature/maxTokens/stop。Host 契约明确说“this waterfall cannot mutate messages”。不能用它注入规则；可以用 `stop` 序列提前截断输出，但截断后 loop 仍按正常 finish 处理，不会自动重试。

### 8.5 `system-prompt/assemble`

在 `preStep` 内、stream 之前运行（`LOOP:907`）；重试复用已渲染的系统提示（`LOOP:1049`），不会在 attempt 之间重新组装。适合 alwaysApply 规则，不适合 TTSR 的流命中注入。

### 8.6 abort 之后

没有在 turn 内部恢复的路径。aborted 的 catch 直接 rethrow（`LOOP:1010-1018`），不触发 `agent/error`（只有非 abort 错误才走 `throwError`）；turn 以 `aborted` 结束后 driver 回到 idle。之后可以用 `followup` 开一个新 turn，但 interrupted 的部分回答已经进入模型历史，而且这不是对原请求的重试。abort 只适合真正停止，不适合 TTSR。

---

## 9. 对插件实现的约束

1. **TTSR 重试不能 abort turn signal。** 用 listener 短路 + 合成 finish 表达“这次不要了”，不要 `agent.cancel`。
2. **failure code 必须由插件自己定义和识别。** 用 `AGENT_RULES_TTSR:<ruleId>` 这类稳定编码；消息文本只作诊断。
3. **重试决策必须由插件在 `agent/request-error` 返回。** 默认 `dsh-llm-retry` 不重试自定义 code；如果需要它的 backoff，先把 code 加进 provider 的 `retryableCodes`（配置面），否则自己实现退避。
4. **注入只走 surface 通道。** `agent.session.append("user/message" | "developer/message", …, {surfaceOp:'append'})`；不要用 `agent.inject`/`followup` 代替。
5. **自己做重试上限和去重。** 内置计数按 step 清零且只统计它自己发起的 retry；规则命中的重试由插件负责，否则会无限循环。
6. **只包装 loop 构造的请求。** 用 `isAgentLoopRequest(options)` 和 `options.sessionId` 过滤；compaction / session-title 没有 agent 目标。
7. **命中后关闭底层 iterator。** 否则 adapter 的 HTTP 流会继续读取；`adapterStream` 只在消费者提前结束时通过 `finally` 关闭 iterator（`LLM:2375-2380`）。
8. **一个 attempt 只 yield 一个 finish。** 合成 finish 后不要再转发 adapter 的终结 chunk。
9. **部分输出无法撤回。** 已转发的 chunk 已经过 `agent/assistant-stream` 发布；需要 UI 完全不留痕时只能缓冲到判定之后再转发。
10. **规则消息会永久留在 session log。** 每次重试都 append 会累积；去重状态要持久化（session projection 或等价机制），或者明确接受重复。
11. **turn 结束后的收尾。** 重试成功后，被拦截的 attempt 仍以 `assistant/attempt` 存在于日志；如果 UI 依据 attempt 帧显示内容，需要在展示层区分 `assistant/attempt` 与 `assistant/message`。
12. **不要修改 `options`。** 深冻结；需要变换请求时只能在 waterfall 里返回不同的流，不能改 messages。

---

## 10. 证据索引

| 主题 | 位置 |
| --- | --- |
| loop 调用 stream | `dsh-agent-loop/lib/index.js:1084` |
| waterfall 发射点 | `dsh-llm/lib/index.js:2393-2398` |
| prepared call 的 stream | `dsh-llm/lib/index.js:2249-2259` |
| 请求构造（messages、sessionId、signal、冻结） | `dsh-agent-loop/lib/index.js:1274-1288` |
| 每 chunk 的消费与实时帧 | `dsh-agent-loop/lib/index.js:1088-1091`、`:396-410` |
| abort 分支与 interrupted message | `dsh-agent-loop/lib/index.js:1096-1112` |
| finish error/aborted → attempt + waterfall | `dsh-agent-loop/lib/index.js:1129-1146` |
| 成功 finish → assistant/message | `dsh-agent-loop/lib/index.js:1156-1162` |
| attempt 循环与重试 continue | `dsh-agent-loop/lib/index.js:1049-1074` |
| `agent/request` waterfall | `dsh-agent-loop/lib/index.js:1191-1195` |
| `agent/pre-step` waterfall | `dsh-agent-loop/lib/index.js:902-927` |
| `agent/turn-stopping` | `dsh-agent-loop/lib/index.js:1001-1007` |
| `send`/`followup`/`steer`/`inject`/`cancel` | `dsh-agent-loop/lib/index.js:800-821` |
| `ctx.agents.get` | `dsh-agent/lib/index.js:596-598` |
| surface 事件类型 | `dsh-session/lib/index.js:157-163` |
| deriveMessages 只走 surface | `dsh-session/lib/index.js:1654-1687` |
| `deriveEventMessage` 的非 surface 返回 null | `dsh-session/lib/index.js:217-229` |
| append 的 surface 元数据规则 | `dsh-session/lib/index.js:1490-1538` |
| assistant/message 不能带 sourceEventSeqs | `dsh-session/lib/index.js:316` |
| replace 必须列出全部被遮蔽节点 | `dsh-session/lib/index.js:330-331` |
| append 重入拒绝 | `dsh-session/lib/index.js:1568-1572` |
| adapter 失败转终结 finish | `dsh-llm/lib/index.js:2350-2352`、`:2402-2413` |
| `BlockAssembler` 的 interruptedBlocks / finish 默认值 | `dsh-llm/lib/index.js:1088-1103` |
| retry 默认参数 | `dsh-llm/lib/index.js:247-257` |
| retry code 谓词 | `dsh-llm-retry/lib/index.js:160-164` |
| retry 计数 projection | `dsh-llm-retry/lib/index.js:88-107` |
| retry 监听器 | `dsh-llm-retry/lib/index.js:175-178` |
| 退避公式 | `dsh-llm-retry/lib/index.js:44-49` |
| 官方先例：image offload + retry | `dsh-compaction-image-offload/lib/index.js:139-145` |
| DeepSeek adapter 的 ABORTED 映射 | `dsh-llm-deepseek/lib/index.js:2153-2156` |
| `llm/stream` Host 契约 | `cordis_inspect` Event `llm/stream` |
| `agent/request-error` Host 契约 | `cordis_inspect` Event `agent/request-error` |
| `agent/request` / `agent/pre-step` / `agent/turn-stopping` Host 契约 | `cordis_inspect` Event 对应条目 |
