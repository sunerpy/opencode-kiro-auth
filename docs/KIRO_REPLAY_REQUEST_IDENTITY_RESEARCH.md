# Kiro 恢复请求身份、exact replay 与 compaction 原子性研究

> 研究日期：2026-08-05
> 本地基线：`opencode-kiro-auth` `7f3955098e156768bc31a74c2cd61f9dc7bea7b7` (`0.18.0`)
> OpenCode 对比基线：`9f38562237f3ca4e41eb8a04fd776be3f944742e`
> 范围：只分析和提出方案，不修改运行代码，不执行新的真实 Kiro API 探针

关联报告：[`SESSION_STOP_AFTER_NEXT_STEP_FORENSICS.md`](./SESSION_STOP_AFTER_NEXT_STEP_FORENSICS.md)
专门分析“AI 宣布下一步后看似停止”的正常 `finish:"stop"`、后台任务检查点和 OMO
父会话唤醒问题。该问题与本文的 Kiro 事件流错误、exact replay 和 compaction
原子性属于不同故障域，不能互相归因。

## 1. 最终结论

本次目标事故可以拆成三个连续问题，不能合并成一句“exact replay 失效”：

1. **初始失败已经证实**：Kiro 的首个 HTTP 200 事件流在输出 1,487 个可见字符后，以
   `InternalServerException` 中断。
2. **恢复失败也已证实**：插件确实进入 `exact_replay`，但 attempts 2-5 分别只匹配
   15、28、53、15 个可见字符就发生逐字分叉，最终以
   `terminalSource:"stream_attempt_budget_exhausted"` 结束。
3. **分叉的直接机制已证实，最初诱因仍未证实**：当前每个恢复 attempt 都重新执行完整请求转换，
   并生成新的随机 `conversationId`。这使所谓 replay 并不是严格意义上的“原请求重发”。
   但现有日志没有转换后语义请求指纹，所以不能断言 UUID 变化就是分叉的唯一根因。

因此，推荐方案不是放宽 `ExactReplayMatcher`，也不是增加 `stream_max_attempts`，而是：

- 保留现有三通道 byte-exact 匹配和追平前不发布的安全闸门。
- 给一个入站请求建立稳定的 `recoveryGroupId` 和脱敏语义请求指纹。
- 在恢复组内冻结转换后的语义请求，包括 `conversationState`、`conversationId`、签名回放结果、
  effective model 和 effort。
- 每个 attempt 只重绑账号信封，包括 `profileArn`、region、凭据和 SDK client。
- 仅对 OpenCode 的 `compaction` 请求启用原子缓冲和整段重试，不全局启用
  `stream_buffer_until_complete`。
- 长期推动 OpenCode 将 compaction 摘要改为成功后原子提交。

提交
[`5d45121` feat(request): 恢复被丢弃的推理签名并在工具循环中回放 (#79)](https://github.com/sunerpy/opencode-kiro-auth/commit/5d45121c553bc605bdc09e8ed96a1a31eaa9c298)
仍然有明确价值。它解决的是**下一用户回合对上一助手回合原生 reasoning signature 的恢复**；
本报告解决的是**同一个入站请求的多个恢复 attempts 是否具有相同 wire 身份**。两者正交，
不能互相替代。

## 2. 证据等级与边界

本文使用以下标签：

| 标签   | 含义                                                  |
| ------ | ----------------------------------------------------- |
| **L1** | 本机目标会话的 SQLite、持久化 part 和插件日志直接证据 |
| **L2** | 当前本地 HEAD 源码直接证据                            |
| **U1** | 固定 Git SHA 的官方开源客户端源码                     |
| **U2** | 固定 Git SHA 的第三方网关源码或公开 issue/PR          |
| **H1** | 与证据一致、但仍需真实 API A/B 才能确认的高概率假设   |
| **N**  | 当前证据不能回答的问题                                |

必须保持以下边界：

- 本报告的目标消息是一个持久化 `error`，不是正常的 `finish:"stop"`。
- “回复里宣布下一步后正常结束”仍可能来自模型决策、工具暴露、历史组装或 OMO 编排。
- `Kiro upstream event stream failed unexpectedly` 则是技术失败路径。
- 两类问题在用户界面上都表现为“任务没有继续”，但不能使用同一个根因解释。
- 本报告没有证明 Kiro 服务端要求 retry 必须复用 `conversationId`。
- 本报告证明的是当前插件没有重发同一转换后请求，而且这是最值得隔离验证的变量。

## 3. 目标事故重建

### 3.1 持久化结果

目标对象：

- session：`ses_039764971ffe124P6fFlsPzgV9`
- assistant message：`msg_fc69659f70014ywqqWU9uy7cH2`
- assistant `finish`：`null`
- error：`UnknownError: Kiro upstream event stream failed unexpectedly`
- parts：一个 `step-start`，一个 1,487 字符的 `text`
- tool part：0

这说明 OpenCode 已经持久化部分 compaction 文本，之后才收到 provider 错误。

### 3.2 五次 SDK attempt

账号标识已脱敏；同一字母表示同一账号。

| Attempt | Wire conversation ID | 账号 | 关键结果                                                                      |
| ------- | -------------------- | ---- | ----------------------------------------------------------------------------- |
| 1       | `c3b38d3b...`        | A    | 696 个上游事件，约 42.0 秒后 `InternalServerException`；此前已发布 1,487 字符 |
| 2       | `5b352f5e...`        | A    | exact replay 匹配 15 个可见字符后分叉                                         |
| 3       | `e8d3f6e4...`        | B    | 匹配 28 个可见字符后分叉                                                      |
| 4       | `9565b7db...`        | C    | 匹配 53 个可见字符后分叉                                                      |
| 5       | `4927c5fb...`        | D    | 匹配 15 个可见字符后分叉                                                      |

最终结果：

```text
terminalSource: "stream_attempt_budget_exhausted"
```

### 3.3 从这组数据可以和不可以得出什么

**已证实：**

- `exact_replay` 配置已加载并实际执行，不是配置未生效。
- 五次 attempt 使用了五个不同的 `conversationId`。
- Attempt 2 仍使用账号 A，却已经在第 15 个可见字符处分叉。
- 因此，账号轮换不是发生分叉的必要条件。
- 本次失败不是“达到配额后五次都被拒绝”的那一类事故；终点是 replay attempt 预算耗尽。

**不能据此断言：**

- 不能断言只要固定 `conversationId`，Kiro 就一定逐字生成相同结果。
- 不能断言账号切换完全没有影响，只能说它不是必要条件。
- 不能把 15/28/53/15 的分叉全部归因于采样随机性。
- 不能把本次事故归因于 `TEXT_TOOL_CALL_OPENING_MARKERS`，因为日志明确显示该路径未激活。

## 4. 本地实现审计

### 4.1 当前 exact replay 不是严格原请求重发

首个 attempt 在
[`RequestHandler.handleKiroRequest`](https://github.com/sunerpy/opencode-kiro-auth/blob/7f3955098e156768bc31a74c2cd61f9dc7bea7b7/src/core/request/request-handler.ts#L282-L290)
中调用 `prepareSdkRequest`。

启用 live recovery 后，`RequestHandler` 给工厂传入的 `prepareRequest` 又会调用同一个完整转换入口：

- [`request-handler.ts:391-431`](https://github.com/sunerpy/opencode-kiro-auth/blob/7f3955098e156768bc31a74c2cd61f9dc7bea7b7/src/core/request/request-handler.ts#L391-L431)
- [`recovery-attempt.ts:271-298`](https://github.com/sunerpy/opencode-kiro-auth/blob/7f3955098e156768bc31a74c2cd61f9dc7bea7b7/src/core/request/recovery-attempt.ts#L271-L298)

`buildCodeWhispererRequest` 每次转换都会执行：

```ts
const convId = crypto.randomUUID()
```

证据：

- [`request.ts:79-90`](https://github.com/sunerpy/opencode-kiro-auth/blob/7f3955098e156768bc31a74c2cd61f9dc7bea7b7/src/plugin/request.ts#L79-L90)
- [`request.ts:345-385`](https://github.com/sunerpy/opencode-kiro-auth/blob/7f3955098e156768bc31a74c2cd61f9dc7bea7b7/src/plugin/request.ts#L345-L385)

所以 attempt 2+ 重新执行了这些工作：

- 解析入站 body。
- 合并相邻 messages。
- 重建 history。
- 查找并回放 reasoning signature。
- 推断历史工具定义。
- 解析 model variant 和 effort。
- 生成新的 `conversationId`。
- 重新附加当前账号的 `profileArn` 和 region。

除了 UUID，当前实现大部分转换是预期确定性的，但“预期确定性”不等于“已记录为相同”。
日志目前没有转换后请求的稳定指纹，无法证明 attempts 之间除 UUID 和账号信封外完全一致。

### 4.2 `SdkPreparedRequest` 混合了两类状态

当前结构见
[`types.ts:95-136`](https://github.com/sunerpy/opencode-kiro-auth/blob/7f3955098e156768bc31a74c2cd61f9dc7bea7b7/src/plugin/types.ts#L95-L136)。

可以按所有权拆成：

| 冻结在恢复组中的语义状态              | 每个 attempt 重绑的账号信封 |
| ------------------------------------- | --------------------------- |
| `conversationState`                   | `profileArn`                |
| `conversationId`                      | region / endpoint           |
| `effectiveModel`                      | access token / auth         |
| effort                                | SDK client                  |
| 已完成的 reasoning signature 回放结果 | account attempt epoch       |
| streaming 语义                        | usage / health 归属         |

不能直接缓存并跨账号复用整个 `SdkPreparedRequest`，因为其中的 `profileArn` 和 region 属于账号。
正确做法是冻结语义主体，再构造 attempt-specific envelope。

### 4.3 ExactReplayMatcher 的安全性应保留

[`ExactReplayMatcher.consume`](https://github.com/sunerpy/opencode-kiro-auth/blob/7f3955098e156768bc31a74c2cd61f9dc7bea7b7/src/core/request/replay-matcher.ts#L137-L178)
对三个通道分别匹配：

- reasoning text
- visible text
- tool calls，包括 ID、名称和规范化参数

它在完整追平已发布前缀之前不发布任何新 chunk；遇到文本、reasoning、工具分叉或
`early_end` 就拒绝该 attempt。

这正是防止以下错误的核心安全属性：

- 将两个不同回答的共同短前缀拼接成一个回答。
- 重复执行或改写已经发布的工具调用。
- 将 replay 的提前结束伪装成成功。
- 在 compaction 中悄悄生成由两个不同摘要拼接而成的摘要。

固定请求身份的目标是提高 matcher 追平概率，不是降低 matcher 的严格程度。

### 4.4 #79 的签名回放仍然必要

当前签名回放路径：

- [`request-replay.ts:26-49`](https://github.com/sunerpy/opencode-kiro-auth/blob/7f3955098e156768bc31a74c2cd61f9dc7bea7b7/src/plugin/reasoning/request-replay.ts#L26-L49)
  使用可从下一回合入站消息重建的 fingerprint 查找签名 envelope。
- [`correlation-cache.ts:144-170`](https://github.com/sunerpy/opencode-kiro-auth/blob/7f3955098e156768bc31a74c2cd61f9dc7bea7b7/src/plugin/reasoning/correlation-cache.ts#L144-L170)
  的 lookup 是非消费式的，并在多个不同 envelope 命中时 fail closed。
- [`request-replay.ts:58-92`](https://github.com/sunerpy/opencode-kiro-auth/blob/7f3955098e156768bc31a74c2cd61f9dc7bea7b7/src/plugin/reasoning/request-replay.ts#L58-L92)
  只对一个未合并的 active tool-loop turn 恢复原生 reasoning。

它解决的时序是：

```text
Kiro attempt 成功
  -> 插件把 reasoning text 发给 OpenCode
  -> OpenCode 持久化后不保留 Kiro 原生 signature
  -> 用户或工具结果触发下一次入站请求
  -> 插件用上一回合输出 fingerprint 找回 signature
  -> 在 history 中回放 Kiro 原生 reasoningContent
```

恢复请求身份解决的时序是：

```text
同一个入站请求
  -> attempt 1 的流中断
  -> attempts 2-N 应重发同一语义请求
```

若删除 #79，下一用户回合仍可能因缺少或错误 signature 收到
`THINKING_SIGNATURE_INVALID`。固定 `conversationId` 不会生成缺失的 signature。

反过来，即使 #79 正确工作，每个 recovery attempt 重新生成 `conversationId` 的问题仍然存在。

### 4.5 `agentContinuationId` 不是当前主修复点

当前生产请求的 `conversationState` 只设置 `chatTriggerType`、`conversationId`、
`history` 和 `currentMessage`，见
[`request.ts:199-211`](https://github.com/sunerpy/opencode-kiro-auth/blob/7f3955098e156768bc31a74c2cd61f9dc7bea7b7/src/plugin/request.ts#L199-L211)。

插件没有发送 `agentContinuationId`。这不自动构成缺陷：

- 本仓库既有 V6 探针曾补充 `agentTaskType` / `agentContinuationId`，没有改善对应的
  premature-stop 指标。
- Kiro-Go 会设置随机 `agentContinuationId`，但 OpenAI 路径又不一致地省略它。
- `conversationId` 与 `agentContinuationId` 的服务端语义没有公开协议保证。

因此，不应把“新增并冻结 `agentContinuationId`”与“冻结已有转换后请求”捆绑上线。
若以后测试它，应作为独立实验因子。

### 4.6 `TEXT_TOOL_CALL_OPENING_MARKERS` 的副作用边界

定义包括：

```text
<function_calls
<invoke name=
<｜DSML｜function_calls
```

证据：

- [`tool-call-parser.ts:77-84`](https://github.com/sunerpy/opencode-kiro-auth/blob/7f3955098e156768bc31a74c2cd61f9dc7bea7b7/src/infrastructure/transformers/tool-call-parser.ts#L77-L84)
- [`dialect-gate.ts:9-30`](https://github.com/sunerpy/opencode-kiro-auth/blob/7f3955098e156768bc31a74c2cd61f9dc7bea7b7/src/plugin/streaming/dialect-gate.ts#L9-L30)
- [`dialect-gate.ts:52-84`](https://github.com/sunerpy/opencode-kiro-auth/blob/7f3955098e156768bc31a74c2cd61f9dc7bea7b7/src/plugin/streaming/dialect-gate.ts#L52-L84)

可预期副作用：

- 为避免 marker 跨 chunk，被认为可能是 marker 前缀的尾部会被短暂保留。
- 一旦出现可执行 opening marker，从 marker 起的正文会暂缓发布到 finalization。
- 普通正文中出现类似 XML 字样，可能造成误判或额外延迟。
- 代码区域识别依赖 fence/inline-code 状态；尚未闭合的反引号可能扩大暂缓范围。

但目标事故日志为：

```text
dialectActive: false
dialectMarkerIndex: null
sawToolIntent: false
```

因此这些 marker **不是本次 1,487 字符 compaction 事故的原因**。它们应保留为独立的解析风险，
不能用来解释本次 exact replay 分叉。

## 5. 外部实现对比

### 5.1 对比表

| 实现                    | 身份策略                                                                   | 同一请求内部重试                                         | 已发布内容后的处理                                                 | 证据价值                                                |
| ----------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------- |
| Amazon Q Developer CLI  | 会话启动生成一次 UUID，`ConversationState` 持续复用                        | compaction 使用同一 conversation state                   | 只有收到 `EndStream` 才替换历史；错误或 channel 提前关闭不提交摘要 | 官方开源客户端，最强设计信号                            |
| `jwadow/kiro-gateway`   | 每个外层账号 attempt 生成 conversation ID                                  | 同一账号的 HTTP/首 token retry 复用同一个 `kiro_payload` | 公开 issue 说明 mid-stream 已输出后首 token retry 无法修复         | 证明“内部 retry 复用 payload”是现实做法，但跨账号不稳定 |
| `Quorinex/Kiro-Go`      | 从模型、system、首个真实用户 anchor 生成稳定 ID；合成 anchor 回退随机 UUID | 完整性 retry 复用同一 payload 和账号                     | 未 flush 可重试；已 flush 返回错误，不伪造成功                     | 与本报告的安全边界高度一致                              |
| `hank9999/kiro.rs`      | 优先从 Claude metadata 的 session UUID 取 conversation ID                  | handler 转换/序列化一次；provider 对同一 body 重试       | 每个账号只通过 endpoint 层重写 `profileArn`                        | 最接近“冻结语义主体、重绑账号信封”的结构                |
| `caidaoli/kiro2api`     | IP + User-Agent + 小时时间窗生成稳定 ID                                    | 稳定窗口内复用                                           | 未形成同等严格的发布闸门证据                                       | 能证明稳定 ID 可实现，但 NAT/共享 UA 有误合并风险       |
| `TsinHzl/kiro2cc-proxy` | 继承 `kiro.rs` 设计                                                        | 不能算独立实现证据                                       | README 明确“基于 kiro.rs 二次开发”                                 | 仅记录派生关系，不重复计票                              |

### 5.2 Amazon Q Developer CLI

固定提交：
[`15cc8f3cd18c4272925ce1c7053268eedff1ea0a`](https://github.com/aws/amazon-q-developer-cli/tree/15cc8f3cd18c4272925ce1c7053268eedff1ea0a)

会话启动时生成一次 UUID：

- [`chat/mod.rs:301-303`](https://github.com/aws/amazon-q-developer-cli/blob/15cc8f3cd18c4272925ce1c7053268eedff1ea0a/crates/chat-cli/src/cli/chat/mod.rs#L301-L303)

`Conversation` 保存并在每次 backend state 中复用：

- [`conversation.rs:170-200`](https://github.com/aws/amazon-q-developer-cli/blob/15cc8f3cd18c4272925ce1c7053268eedff1ea0a/crates/chat-cli/src/cli/chat/conversation.rs#L170-L200)
- [`conversation.rs:612-622`](https://github.com/aws/amazon-q-developer-cli/blob/15cc8f3cd18c4272925ce1c7053268eedff1ea0a/crates/chat-cli/src/cli/chat/conversation.rs#L612-L622)

compaction 只在收到 `ResponseEvent::EndStream` 后取得完整 summary，并随后替换历史：

- [`chat/mod.rs:1569-1702`](https://github.com/aws/amazon-q-developer-cli/blob/15cc8f3cd18c4272925ce1c7053268eedff1ea0a/crates/chat-cli/src/cli/chat/mod.rs#L1569-L1702)

这不能证明服务端强制要求固定 ID，但证明官方客户端把 conversation ID 视为会话状态，
而且 compaction 采用成功后提交，而不是流式写入最终历史。

### 5.3 `jwadow/kiro-gateway`

固定提交：
[`a5292ca04c7c6231e0b47673ac3f981f5a706e1e`](https://github.com/jwadow/kiro-gateway/tree/a5292ca04c7c6231e0b47673ac3f981f5a706e1e)

在 OpenAI route 中：

- 外层账号循环内生成 `conversation_id` 并构造 `kiro_payload`：
  [`routes_openai.py:314-340`](https://github.com/jwadow/kiro-gateway/blob/a5292ca04c7c6231e0b47673ac3f981f5a706e1e/kiro/routes_openai.py#L314-L340)
- 初始 HTTP request 使用该 payload：
  [`routes_openai.py:346-363`](https://github.com/jwadow/kiro-gateway/blob/a5292ca04c7c6231e0b47673ac3f981f5a706e1e/kiro/routes_openai.py#L346-L363)
- 首 token retry 的 closure 继续复用同一个 `kiro_payload`：
  [`routes_openai.py:373-393`](https://github.com/jwadow/kiro-gateway/blob/a5292ca04c7c6231e0b47673ac3f981f5a706e1e/kiro/routes_openai.py#L373-L393)

但外层切换账号后会重新进入 conversation ID 生成，所以它只支持“同账号内部 retry 固定 payload”，
不能作为“跨账号也必须固定 ID”的证据。

公开
[`issue #129`](https://github.com/jwadow/kiro-gateway/issues/129)
记录了 Kiro 中途断开 chunked stream：

- 初始 request retry 不覆盖迭代中的断流。
- first-token retry 对已经开始输出后的错误无效。
- partial SSE 已发布后，直接重试不安全。

### 5.4 `Quorinex/Kiro-Go`

固定提交：
[`f8f6071c9298a4266ad3e0c7e483d4a2510cbcaf`](https://github.com/Quorinex/Kiro-Go/tree/f8f6071c9298a4266ad3e0c7e483d4a2510cbcaf)

对真实 anchor，conversation ID 是稳定的 UUID v5 风格值；合成或空 anchor 才随机生成：

- [`translator.go:1923-1943`](https://github.com/Quorinex/Kiro-Go/blob/f8f6071c9298a4266ad3e0c7e483d4a2510cbcaf/proxy/translator.go#L1923-L1943)

Claude 路径另外生成随机 `AgentContinuationId`：

- [`translator.go:307-314`](https://github.com/Quorinex/Kiro-Go/blob/f8f6071c9298a4266ad3e0c7e483d4a2510cbcaf/proxy/translator.go#L307-L314)

完整性重试直接复用同一个 `payload *KiroPayload`：

- [`stream_integrity.go:9-58`](https://github.com/Quorinex/Kiro-Go/blob/f8f6071c9298a4266ad3e0c7e483d4a2510cbcaf/proxy/stream_integrity.go#L9-L58)

安全边界：

- 未 flush 时允许同账号有界重试。
- 已 flush 时返回 integrity error，明确不伪造 `end_turn`。

证据：

- [`stream_integrity.go:61-82`](https://github.com/Quorinex/Kiro-Go/blob/f8f6071c9298a4266ad3e0c7e483d4a2510cbcaf/proxy/stream_integrity.go#L61-L82)
- [`PR #145`](https://github.com/Quorinex/Kiro-Go/pull/145)
- [`PR #146`](https://github.com/Quorinex/Kiro-Go/pull/146)

这与本插件的 exact matcher 安全目标一致，但 Kiro-Go 没有实现“已 flush 后逐字追平再续发”；
它选择直接报错。

### 5.5 `hank9999/kiro.rs`

固定提交：
[`5ca5703a57a970f0707108cd866b02d4f0f765cb`](https://github.com/hank9999/kiro.rs/tree/5ca5703a57a970f0707108cd866b02d4f0f765cb)

Claude converter 优先从 `metadata.user_id.session_id` 提取合法 UUID：

- [`converter.rs:157-165`](https://github.com/hank9999/kiro.rs/blob/5ca5703a57a970f0707108cd866b02d4f0f765cb/src/anthropic/converter.rs#L157-L165)
- [`converter.rs:252-256`](https://github.com/hank9999/kiro.rs/blob/5ca5703a57a970f0707108cd866b02d4f0f765cb/src/anthropic/converter.rs#L252-L256)

handler 将 Kiro request 序列化一次，再把同一字符串交给 provider：

- [`handlers.rs:322-384`](https://github.com/hank9999/kiro.rs/blob/5ca5703a57a970f0707108cd866b02d4f0f765cb/src/anthropic/handlers.rs#L322-L384)

provider 的账号重试接收同一个 `request_body`，每次只通过 endpoint 重新加工：

- [`provider.rs:279-329`](https://github.com/hank9999/kiro.rs/blob/5ca5703a57a970f0707108cd866b02d4f0f765cb/src/kiro/provider.rs#L279-L329)

IDE endpoint 只在根对象注入或覆盖当前账号的 `profileArn`：

- [`ide.rs:108-117`](https://github.com/hank9999/kiro.rs/blob/5ca5703a57a970f0707108cd866b02d4f0f765cb/src/kiro/endpoint/ide.rs#L108-L117)

这是本报告推荐结构的直接先例：

```text
转换并序列化一次的语义 body
  + 每个账号 attempt 的 profileArn / token / endpoint
```

### 5.6 `caidaoli/kiro2api`

固定提交：
[`a2837e91d0f93d1f340ce43911c31b04c257c0d8`](https://github.com/caidaoli/kiro2api/tree/a2837e91d0f93d1f340ce43911c31b04c257c0d8)

它使用客户端 IP、User-Agent 和小时时间窗生成稳定 ID：

- [`conversation_id.go:25-61`](https://github.com/caidaoli/kiro2api/blob/a2837e91d0f93d1f340ce43911c31b04c257c0d8/utils/conversation_id.go#L25-L61)
- [`conversation_id.go:88-117`](https://github.com/caidaoli/kiro2api/blob/a2837e91d0f93d1f340ce43911c31b04c257c0d8/utils/conversation_id.go#L88-L117)

不建议照搬。多个用户经过同一 NAT、代理或统一 User-Agent 时可能被误并为一个会话；
小时边界也会在同一真实会话中突然换 ID。本插件已经有更准确的“一个入站请求/恢复组”边界。

### 5.7 派生仓库去重

`TsinHzl/kiro2cc-proxy` 在固定提交
[`74f6b234deae8d3eb67af52e22a706adef458a6c`](https://github.com/TsinHzl/kiro2cc-proxy/tree/74f6b234deae8d3eb67af52e22a706adef458a6c)
的 README 明确声明：

- [`README.md:812`](https://github.com/TsinHzl/kiro2cc-proxy/blob/74f6b234deae8d3eb67af52e22a706adef458a6c/README.md#L812)

> 本项目基于 kiro.rs 二次开发。

因此它不应被当作第二个独立实现来增加结论权重。

### 5.8 其他工具是否实现了 #79 等价签名回放

截至本次固定提交和 GitHub 代码检索范围：

- `kiro-gateway` 未找到与本插件 fingerprint correlation cache 等价的下一回合签名恢复。
- `kiro.rs` 未找到等价实现。
- `kiro2api` 未找到等价实现。
- Kiro-Go 的兼容类型中存在 signature 字段，但未找到把 Kiro 原生签名与下游持久化回合关联、
  再在下一用户回合回放的生产路径。

这个“未找到”是有边界的源码检索结果，不是对所有历史版本的存在性证明。

更重要的是，不能从“其他网关没实现”推出“本插件不需要实现”：

- 一些网关把 reasoning 当普通文本处理。
- 一些下游根本不把 reasoning 重新提交给 Kiro。
- 一些实现不承诺原生签名 round-trip。
- 本插件面向 OpenCode 工具循环，已经实测遇到 Kiro 的签名校验约束。

所以 #79 应保留。

## 6. 为什么 compaction 特别容易暴露该问题

### 6.1 OpenCode 当前逐 delta 持久化文本

固定 OpenCode 提交：
[`9f38562237f3ca4e41eb8a04fd776be3f944742e`](https://github.com/anomalyco/opencode/tree/9f38562237f3ca4e41eb8a04fd776be3f944742e)

`SessionProcessor` 对每个 `text-delta` 立即调用 `updatePartDelta`：

- [`processor.ts:499-509`](https://github.com/anomalyco/opencode/blob/9f38562237f3ca4e41eb8a04fd776be3f944742e/packages/opencode/src/session/processor.ts#L499-L509)

因此首个 attempt 一旦输出，1,487 字符就成为持久化状态。后续恢复不能简单整段替换，
只能逐字追平已发布前缀后继续。

### 6.2 Compaction 使用普通流式 SessionProcessor

compaction assistant 明确标记为 `agent:"compaction"`，随后由普通 `SessionProcessor` 处理：

- [`compaction.ts:328-388`](https://github.com/anomalyco/opencode/blob/9f38562237f3ca4e41eb8a04fd776be3f944742e/packages/opencode/src/session/compaction.ts#L328-L388)

AI SDK 路径使用 `streamText()`，默认 `maxRetries: 0`，并把准备后的 headers 传给 provider：

- [`llm.ts:276-324`](https://github.com/anomalyco/opencode/blob/9f38562237f3ca4e41eb8a04fd776be3f944742e/packages/opencode/src/session/llm.ts#L276-L324)

结果是：

```text
compaction 首次 attempt
  -> 摘要 delta 逐块持久化
  -> 上游中断
  -> 插件必须生成与已持久化 1,487 字符完全相同的前缀
  -> 新 attempt 很早分叉
  -> OpenCode 留下部分摘要和 provider error
```

这解释了为什么同一会话的 compaction 可能反复失败，而其他短请求正常。
长 reasoning 时间不是直接根因，但更长的流和更多输出会扩大中途断流概率，也扩大 exact replay
需要逐字追平的前缀长度。

### 6.3 可以只识别 compaction，而不影响所有流

OpenCode 的 `chat.headers` hook 输入包含 `agent`：

- [`llm/request.ts:134-146`](https://github.com/anomalyco/opencode/blob/9f38562237f3ca4e41eb8a04fd776be3f944742e/packages/opencode/src/session/llm/request.ts#L134-L146)

compaction assistant 又明确使用 `agent:"compaction"`。因此插件可以：

1. 在 `chat.headers` hook 中仅为 compaction 添加私有 header，例如
   `x-opencode-kiro-request-kind: compaction`。
2. 自定义 fetch 从 `RequestInit.headers` 读取并移除该 header，不把它发送给 AWS。
3. 对这一请求采用完整缓冲和整段 retry。
4. 其他普通聊天、工具调用和并行工作区继续实时流式输出。

这比全局 `stream_buffer_until_complete: true` 更符合现有并行使用约束。

## 7. 推荐设计

### 7.1 恢复组语义快照

建议将当前混合结构逻辑上拆成：

```ts
interface RecoverySemanticSnapshot {
  recoveryGroupId: string
  semanticFingerprint: string
  conversationState: CodeWhispererRequest['conversationState']
  conversationId: string
  effectiveModel: string
  effort?: Effort
  streaming: boolean
}

interface RecoveryAttemptEnvelope {
  attemptIndex: number
  accountAlias: string
  profileArn?: string
  region: string
  auth: KiroAuthDetails
  client: CodeWhispererClient
}
```

这是设计草图，不要求照抄命名。

生命周期：

```text
入站 OpenCode 请求
  -> 完整转换一次
  -> reasoning signature lookup 一次
  -> 生成一个 conversationId
  -> 深冻结语义快照
  -> attempt 1 绑定账号 A 信封
  -> 事件流中断
  -> attempt 2 继续使用相同语义快照，绑定账号 A 或 B 信封
  -> ExactReplayMatcher 仍负责逐字追平
```

必须每个 attempt 新建的状态：

- `StreamObserver`
- `EmittedOutputAccumulator`
- SDK stream iterator
- attempt ID
- account attempt epoch
- timeout/backoff 状态
- usage/health 回调归属

必须在恢复组内保持不变的状态：

- 转换后的 history/currentMessage/tools
- 已解析的 model variant 和 effort
- signature lookup 的最终结果
- wire `conversationId`
- semantic fingerprint

### 7.2 账号轮换时的安全规则

跨账号 attempt 不能复用：

- access/refresh token
- SDK client
- region endpoint
- `profileArn`
- usage 和 health 归属

跨账号可以复用：

- `conversationState`
- wire `conversationId`
- effective model / effort
- exact replay prefix

前提是 API A/B 证明 Kiro 接受“相同 conversation ID + 新账号 profileArn”。
在该验证完成前，建议放在实验配置或仅测试分支，不能直接宣称为协议保证。

### 7.3 语义指纹

建议对以下 canonical 数据计算 SHA-256：

```text
conversationState
effectiveModel
effort
streaming
disableReasoningReplay
```

明确排除：

```text
access token
refresh token
email
accountId
profileArn
region endpoint
SDK invocation ID
attempt ID
```

日志只记录截断后的 hash，例如前 16 个 hex 字符。指纹用于证明 attempts 的语义 body 是否相同，
不能记录 history、reasoning、工具参数或用户正文。

`conversationId` 应单独记录，因为实验需要区分：

- semantic fingerprint 相同但 wire ID 不同。
- semantic fingerprint 和 wire ID 都相同。
- 账号信封不同。

### 7.4 语义变化必须开启新恢复组

以下情况不是同一 replay group：

- 收到 `THINKING_SIGNATURE_INVALID` 后主动移除全部 reasoning signature。
- context overflow 后执行 compaction 并生成新消息。
- 模型或 effort 被 fallback 改写。
- 工具集合、history 或 currentMessage 被重新组装。
- 用户发送了新消息。

这些变化都应产生新的 `recoveryGroupId` 和 semantic fingerprint。

### 7.5 Compaction 原子缓冲

插件侧近期方案：

- 仅对私有 header 标识的 compaction 请求生效。
- 在向 OpenCode 发布第一个 SSE byte 前，完整消费 Kiro attempt。
- pre-delivery 失败时重发冻结的语义快照。
- 只有完整成功后才一次性向 OpenCode 暴露 SSE。
- 预算耗尽时返回结构化 503，OpenCode 不应获得部分摘要。

它不会消除真实配额消耗，但会把“必须逐字追平 1,487 字符”降为“任何一个 attempt 完整成功即可”。

长期 OpenCode 方案：

- compaction 输出写入 provisional part 或内存 buffer。
- 只有 processor 完整成功后才提交 summary assistant 和替换历史。
- provider error、abort 或 channel 提前关闭时丢弃 provisional summary。
- 这应是 compaction 专用提交语义，不改变普通聊天的实时持久化。

官方 Amazon Q CLI 已采用类似的“收到 `EndStream` 后再替换历史”边界。

## 8. 可观测性增强

### 8.1 必需字段

每个入站流式请求记录一次：

```text
recoveryGroupId
semanticFingerprint
wireConversationId
requestKind: normal | compaction | unknown
model
effectiveModel
effort
streamRecoveryMode
maxAttempts
processId
bunVersion
```

每个 attempt 记录：

```text
recoveryGroupId
attemptIndex
accountAliasHash
wireConversationId
semanticFingerprint
sameSemanticAsInitial
sameConversationIdAsInitial
region
upstreamEventCount
emittedReasoningChars
emittedVisibleChars
emittedToolCount
originalError.name
originalError.message
originalError.code
originalError.cause
replayOutcome
matchedReasoningChars
matchedVisibleChars
matchedToolCount
divergenceChannel
elapsedMs
```

终态记录一次：

```text
recoveryGroupId
terminalSource
attemptsUsed
accountsTried
initialFailure
finalFailure
recovered
publishedChars
quotaRelevant
```

### 8.2 隐私要求

日志不应包含：

- 邮箱
- 原始 accountId
- token
- `profileArn`
- 用户文本
- reasoning 文本
- 工具参数
- 完整请求 body

账号可使用进程内稳定 alias 或加盐 hash。最终摘要应保留原始异常链，而不是只留下
`Kiro upstream event stream failed unexpectedly`。

### 8.3 这组日志可以直接回答的问题

下次事故无需猜测即可判断：

- 是首个 attempt 失败，还是 recovery attempt 失败。
- attempts 是否真的使用同一转换后语义请求。
- 只改了 UUID，还是 history/tools/signature 也变化。
- 首次分叉发生在哪个通道和第几个字符。
- 账号切换前是否已经分叉。
- 最终是上游异常、replay divergence、early end、quota、abort 还是预算耗尽。
- compaction 是否处于原子缓冲模式。

## 9. 真实 API A/B 方案

### 9.1 实验原则

- 使用同一份脱敏会话快照和同一 compaction prompt。
- 不放宽 exact matcher。
- 不同时改 UUID、账号策略、buffering 和 attempt budget。
- 每个 arm 记录语义指纹、wire ID、账号 alias 和原始错误。
- 先小样本验证协议接受度，再决定是否扩大，避免无意义消耗配额。
- 随机交错 arm 顺序，避免把时段、账号健康或 Kiro 后端波动误当成策略效果。

### 9.2 实验矩阵

| Arm                   | 转换策略                     | Conversation ID | 账号             | 发布策略          | 要隔离的变量                       |
| --------------------- | ---------------------------- | --------------- | ---------------- | ----------------- | ---------------------------------- |
| A 当前基线            | 每 attempt 重新转换          | 每次随机        | 先同账号，后轮换 | live exact replay | 当前实际行为                       |
| B 冻结语义但换 ID     | 冻结除 ID 外的语义快照       | 每次随机        | 固定账号 A       | live exact replay | 排除转换过程漂移，只观察 ID 变化   |
| C 固定完整状态        | 冻结完整 `conversationState` | 固定            | 固定账号 A       | live exact replay | 固定 ID 对同账号确定性的影响       |
| D 固定状态并轮换账号  | 冻结完整语义快照             | 固定            | A -> B           | live exact replay | 跨账号重绑 `profileArn` 是否可接受 |
| E compaction 原子缓冲 | 同 C 或 D                    | 固定            | 按策略           | 成功前不发布      | 原子提交对任务连续性的改善         |

### 9.3 指标

主要指标：

- 完整追平率。
- 恢复成功率。
- 首次分叉位置，按 reasoning/text/tool 分开。
- 最终错误类型。

成本和安全指标：

- 每个逻辑请求消耗的 SDK calls。
- quota/rate-limit 错误数。
- 总延迟和首字节延迟。
- 重复或不一致工具调用数，目标必须为 0。
- 跨账号固定 ID 的 4xx/签名错误率。

### 9.4 判读

可能结果：

1. **C 显著优于 B/A**：支持固定 conversation ID 能提高重放确定性。
2. **B 优于 A，C 与 B 接近**：主要问题是重复转换中的其他状态变化，需要对比指纹和请求 diff。
3. **A/B/C 都很早分叉**：模型或后端本身不保证逐字确定性，固定 ID 价值有限。
4. **C 同账号可行，D 跨账号失败**：恢复组应固定账号；账号轮换只能开启新组或回退报错。
5. **D 可行但仍偶发分叉**：固定身份是缓解，不是确定性保证。
6. **E 成功率明显更高**：compaction 应优先原子化，即使普通聊天继续 live stream。

第一轮只需足以确认 200/4xx、是否有完整追平和分叉位置的少量配对运行。
没有信号时不应直接扩大样本或提高 attempt 数。

## 10. 分阶段实施建议

### P0：先补可观测性

目标：

- `recoveryGroupId`
- semantic fingerprint
- wire conversation ID
- request kind
- 每 attempt 原始异常和 replay 进度
- 一条完整终态摘要

价值：

- 风险最低。
- 不改变请求语义。
- 是后续 A/B 可解释性的前置条件。

### P1：冻结恢复组语义身份

目标：

- 首次完整转换一次。
- attempts 2-N 复用冻结后的 `conversationState` 和 `conversationId`。
- 账号切换只重绑信封。
- exact matcher 不变。

上线方式：

- 先通过内部实验开关执行 A/B。
- 同账号固定状态先于跨账号固定状态。
- 若 Kiro 拒绝跨账号复用，则保留同账号冻结并限制轮换策略。

### P2：Compaction 专用原子缓冲

目标：

- 用 `chat.headers` 的 `agent:"compaction"` 标记请求。
- 只对 compaction 成功后发布。
- 保持普通请求和多工作区并行流式体验。

这不是全局打开 `stream_buffer_until_complete`。

### P3：推动 OpenCode 原生原子提交

目标：

- 摘要在 provider 成功前不成为正式 session part。
- 失败时自动丢弃 provisional summary。
- provider 插件无需为不同持久化实现承担补偿逻辑。

这是最完整的长期方案。

## 11. 不建议的方案

### 11.1 增加 `stream_max_attempts`

本次 attempts 2-5 在 15-53 字符就稳定分叉。继续增加只会：

- 消耗更多真实配额。
- 增加账号压力。
- 延长最终失败时间。
- 不改变 exact replay 的追平概率结构。

### 11.2 放宽为模糊匹配或直接拼接

不可接受。它可能悄悄改写：

- compaction 摘要
- 代码补丁
- 工具名称和参数
- 用户可见结论

安全性优先于表面连续输出。

### 11.3 全局启用完整缓冲

不符合多个 OpenCode 工作区并行使用的延迟要求。应只对 compaction 或明确的原子请求启用。

### 11.4 把账号轮换当作主修复

Attempt 2 在同账号 A 上已经分叉。账号轮换可能影响结果，但不是必要根因。

### 11.5 用 OMO/Claude Code shell hook 修复

hook 可以观测 agent 或事件，但看不到插件内部的：

- raw Kiro iterator
- exact replay prefix
- reasoning signature envelope
- attempt/account 状态
- 已发布和未发布 chunk 边界

因此 hook 适合打标，不适合承担恢复状态机。

### 11.6 删除 #79 签名回放

这会重新暴露下一回合的 signature 缺失问题，而且不能改善同请求 replay 身份。

### 11.7 直接复制 IP + UA 稳定 ID

容易在 NAT、统一代理、多工作区和小时边界上产生错误会话关联。本插件应使用准确的入站请求边界。

### 11.8 把 marker 解析列为本次根因

目标日志已经排除 dialect path。可以继续完善 parser 测试和日志，但不能据此解释本次事故。

## 12. 验收标准

若后续实现，至少应覆盖：

### 单元测试

- attempt 2+ 不再次调用完整 message transform。
- 同恢复组的语义 fingerprint 恒定。
- 同账号 attempts 的 conversation ID 恒定。
- 跨账号时只有 `profileArn`、region、auth/client 和归属状态变化。
- signature lookup 的结果被冻结，不因 TTL/LRU 在 attempt 间变化。
- `THINKING_SIGNATURE_INVALID` 触发的降级会创建新语义组。
- exact matcher 的 text/reasoning/tool/early_end 测试保持原样通过。

### 集成测试

- attempt 1 部分输出后失败，attempt 2 完全追平并只发布一次 suffix。
- attempt 2 分叉时不发布任何 replay chunk。
- 跨账号固定语义 body 时请求指纹不变，账号信封正确变化。
- compaction 失败时 OpenCode 不得到 partial summary。
- compaction 成功时结果只提交一次。
- 普通聊天仍保持实时流。

### 日志测试

- 一个 start 对应且仅对应一个 terminal summary。
- 每个 attempt 都带相同 `recoveryGroupId`。
- cause chain、replay outcome 和 matched progress 都存在。
- 日志中不存在邮箱、accountId、token、profileArn 和正文。

## 13. 根因排序

按当前证据强度排序：

1. **已证实的触发原因**：首个 Kiro 事件流在部分输出后以
   `InternalServerException` 中断。
2. **已证实的恢复失败原因**：后续 attempts 无法逐字追平已持久化的 1,487 字符，
   exact matcher 正确拒绝拼接。
3. **最强的可修复放大因素**：恢复 attempts 重新转换请求并生成新 `conversationId`，
   因而不是严格原请求重发。
4. **仍可能存在的因素**：Kiro 模型采样、后端路由或隐藏状态本身不保证逐字确定性。
5. **较弱因素**：账号轮换可能进一步降低一致性，但同账号 attempt 已证明不需要轮换也会分叉。
6. **本次已排除**：`TEXT_TOOL_CALL_OPENING_MARKERS` / dialect tool intent。

最终工程判断：

- **保留 #79。**
- **保留 exact matcher。**
- **不增加重试预算。**
- **先补日志和语义指纹，再做固定请求身份 A/B。**
- **将 compaction 原子化作为连续性收益最大的独立改进。**
- **在 A/B 前，不把随机 UUID 宣称为唯一根因，也不承诺固定 UUID 会保证恢复成功。**

## 14. 实施状态（2026-08-05）

本报告的 P0-P2 已在 `v0.18.0` 基线后的功能分支实现：

- **P0 可观测性**：新增 `recoveryGroupId`、截断后的 semantic fingerprint、
  `wireConversationId`、`requestKind`、`sameSemanticAsInitial`、
  `sameConversationIdAsInitial`、进程内账号别名、逐 attempt 原因和统一终态摘要。
- **P1 同账号稳定身份**：同账号恢复 attempts 复用首次转换后的
  `conversationState`、`conversationId` 和 reasoning signature 解析结果，不再每次
  调用完整消息转换。
- **P1 跨账号策略**：默认仍重新转换并生成新 wire ID；只有显式开启
  `stream_recovery_reuse_conversation_id_across_accounts` 才跨账号重绑原语义快照。
  该选项仍是实验项，真实 Kiro API A/B 尚未把它提升为协议保证。
- **P2 compaction 原子缓冲**：OpenCode `chat.headers` 钩子只为
  `agent:"compaction"` 且 provider 为 `kiro-auth` 的请求添加私有标记；插件在进入
  AWS SDK 前消费该标记，并在完整 drain 成功后才向 OpenCode 发布 SSE。

同时保留以下安全边界：

- exact replay 继续对 reasoning、可见文本和工具调用做 byte-exact 匹配；
- #79 的 reasoning signature 回放继续保留；
- 不提高 `stream_max_attempts`；
- 不把 missing completion metadata 当成截断；
- 普通聊天仍默认实时流式；
- 日常日志只记录账号别名，不记录邮箱或 raw account ID；显式开启 API request
  debug 时仍可能记录 prompt、工具参数和邮箱。

P3 “OpenCode 原生 provisional summary + 原子提交”不属于本插件仓库，仍是上游
长期项。本次实现降低 compaction 半成品持久化和恢复身份漂移的风险，但不承诺 Kiro
在固定请求身份下生成逐字确定的输出，也不把 UUID 变化重新定义为唯一根因。
