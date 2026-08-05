# “宣布下一步后正常结束”诊断日志与发布计划

> 制定日期：2026-08-05
> 目标版本：`v0.20.0`
> 实现基线：`v0.19.0`
> 关联取证：
> [`SESSION_STOP_AFTER_NEXT_STEP_FORENSICS.md`](./SESSION_STOP_AFTER_NEXT_STEP_FORENSICS.md)
> 和
> [`KIRO_REPLAY_REQUEST_IDENTITY_RESEARCH.md`](./KIRO_REPLAY_REQUEST_IDENTITY_RESEARCH.md)

## 1. 目标与边界

目标是在下一次复现时，用一组可关联、可判读且不记录正文的日志回答：

1. OpenCode 入站请求是否真的暴露了工具。
2. 插件转换后的 Kiro 请求是否仍携带同一组工具和正确的续接结构。
3. 是否真的发起了 SDK attempt，而不是 assistant 只在正文里说“接下来会执行”。
4. 上游是 clean EOF、带 completion metadata、流错误、语义截断、取消，还是恢复耗尽。
5. 下游 `finish_reason:"stop"` 是上游事实，还是插件按零工具数合成的兼容终止块。

本次不做以下行为变更：

- 不从自然语言推断工具意图，不伪造 `tool_calls` 或自动续写。
- 不修改 `exact_replay`、reasoning signature 回放、attempt 上限或账号轮换。
- 不启用全局 `stream_buffer_until_complete`，不降低多工作区并发。
- 不把缺少 completion metadata 当作截断。
- 不修改 OMO parent-wake 路由或 OpenCode 的跨进程 session 所有权。

## 2. 日志级别

新增配置：

```json
{
  "diagnostic_log_level": "verbose",
  "enable_log_api_request": false
}
```

环境变量等价项为 `KIRO_DIAGNOSTIC_LOG_LEVEL`。

| 级别      | 用途                                                                             |
| --------- | -------------------------------------------------------------------------------- |
| `off`     | 默认值；保持既有日志行为。                                                       |
| `basic`   | 记录 trace、脱敏身份、输入/转换后计数、当前回合类型和终止来源。                  |
| `verbose` | 增加有界角色序列、工具集合哈希、marker、空 assistant、orphan repair 等结构证据。 |

三个级别都不记录 prompt、reasoning、工具名、参数、结果、签名、账号、邮箱、ARN
或原始 session/message ID。`verbose` 是结构遥测，不是请求正文日志。

## 3. 关联标识

OpenCode `chat.headers` hook 为每个 Kiro 请求附加：

- 随机 UUID `diagnosticTraceId`；
- session、agent、message 原始身份的 SHA-256 前 16 个十六进制字符。

这些私有头只用于把 OpenCode hook 与插件 fetch 边界关联。插件会校验格式并消费它们，
不会把它们复制到 AWS SDK command。若 hook 上下文缺失，处理器仍生成 trace UUID，
对应身份哈希写为 `null`。

## 4. 稳定日志事件

### `Kiro request shape diagnostics`

每个入站请求最多一条，在 `transformToSdkRequest` 完成后写入。关键字段：

- 输入：消息数、角色计数、最后角色、当前回合类型、工具数、tool choice、历史
  tool use/result 数。
- wire：history 长度和角色计数、当前 content 类型/长度、当前工具与 tool result 数、
  空 assistant 和 orphan repair 数。
- verbose：输入/wire 角色序列、交替性、marker 命中、reasoning envelope、
  flattened orphan、推断工具数、输入/wire 工具集合哈希和图片数。

### `Kiro stream attempt started`

每个真实 SDK stream attempt 一条。它是“是否确实重试/恢复/再次调用模型”的直接证据。
同一入站请求的记录共享 `diagnosticTraceId` 和 `recoveryGroupId`。

### `Kiro stream request terminal`

每个已开始的流请求恰好一条。新增字段：

| 字段                               | 解释                                                  |
| ---------------------------------- | ----------------------------------------------------- |
| `terminalProvenance`               | clean EOF、metadata、截断、取消、耗尽、上游或处理错误 |
| `downstreamFinishReason`           | clean end 时为 `stop`/`tool-calls`，失败时为 `null`   |
| `downstreamFinishReasonProvenance` | clean end 时明确为 `synthesized_from_tool_count`      |

这能证明 `stop` 的协议来源，但不能证明“模型本来应该调用工具”。

## 5. 下一次事故的判读矩阵

| 证据组合                                                            | 结论优先级                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 无目标 trace                                                        | 先查实际加载版本、配置层、是否重启以及 provider 是否为 `kiro-auth` |
| `inputToolCount > 0` 且 `wireCurrentToolCount == 0`                 | 插件请求转换/当前消息组装缺陷                                      |
| 输入与 wire 工具数相同但工具集合哈希不同                            | 工具定义被替换、错误推断或丢失                                     |
| tool result 输入存在，但 wire current/history 均为 0                | 续接回合转换缺陷                                                   |
| `terminalProvenance:"clean_eof"`、`sawToolIntent:false`、工具数为 0 | 上游正常结束且未观察到工具意图；下游 `stop` 为插件合成             |
| `sawToolIntent:true`、`emittedToolCount:0`、终止为截断/上游错误     | 工具流在完成或发布前中断                                           |
| `terminalProvenance:"upstream_error"`                               | transport/Kiro 事件流故障，不是正常 stop                           |
| 多条 `attempt started` 后 `recovery_exhausted`                      | 恢复真实执行但耗尽；再看每次原始错误和 exact replay 结果           |
| 插件 clean EOF，但 DB 中没有对应 assistant terminal                 | OpenCode 持久化/消费层问题                                         |
| 插件与 DB 均正常 stop，随后 wake 路由到其他 PID/run                 | OMO/OpenCode 跨进程 ownership 问题                                 |

## 6. 复现与取证流程

1. 固定发布版本，不使用浮动缓存版本。
2. 设置 `diagnostic_log_level:"verbose"`，保持
   `enable_log_api_request:false`。
3. 关闭并重新启动所有相关 OpenCode/ACP 进程，确认新配置由新进程加载。
4. 记录会话标题、原始 session ID、问题消息时间和可见最后一句。
5. 等待异常自然发生，不手动增加重试次数。
6. 从 `~/.config/opencode/kiro-auth-plugin/logs/plugin.log*` 提取同一
   `sessionHash`/`diagnosticTraceId` 的 shape、attempt、warning、failure 和 terminal
   记录。
7. 从 `opencode.db` 核对对应 assistant 的 `finish`、`error` 与 part 类型。
8. 若涉及后台任务，再关联 OMO wake、run、PID、cwd 和 listener。
9. 取证完成后将 `diagnostic_log_level` 恢复为 `off` 并重启。

已知原始 session ID 时，可在本机计算相同哈希：

```bash
printf '%s' 'ses_...' | sha256sum | cut -c1-16
```

建议提取命令：

```bash
rg -n \
  'Kiro request shape diagnostics|Kiro stream attempt started|Kiro stream request terminal|Kiro SDK event stream iteration failed' \
  ~/.config/opencode/kiro-auth-plugin/logs/plugin.log*
```

## 7. 发布门禁

发布前必须全部满足：

- 配置 schema、默认回填、文件与环境变量测试通过。
- 私有头仅对 `kiro-auth` 注入，格式非法时丢弃，并在处理器边界消费。
- `off` 不产生新增 shape/attempt/correlation 字段。
- `basic` 与 `verbose` 的序列化结果不含测试中的 prompt、工具名、参数或原始身份。
- clean EOF、metadata、iterator failure、semantic truncation、abort 和恢复耗尽的来源可区分。
- 定向测试、全量 `bun test`、`bun run typecheck`、Prettier、build、
  `git diff --check` 全部通过。
- CodeGraph 刷新后无 pending changes。

## 8. 灰度、成功标准与回滚

首轮只在本机将 `diagnostic_log_level` 设为 `verbose`。成功标准：

- 普通请求行为、首 token 延迟和并发方式无变化。
- 每个目标请求可以从 trace 串起 request shape、真实 attempts 和唯一 terminal。
- 下一次事故可落入第 5 节某一证据组合，不再只依赖 UI 的
  “finish stop”或 assistant 自述。
- 日志抽查不含正文或原始身份。

出现以下任一情况立即回滚到 `off`：

- 日志出现任何敏感正文或原始身份。
- 私有头进入 SDK request/API 明细。
- 诊断开启改变工具解析、恢复次数、流输出或请求成功率。
- 日志量异常增长影响磁盘或 OpenCode 响应。

回滚只需修改配置并重启，不需要降级插件；诊断开关默认关闭，代码路径保留用于下次短期取证。
