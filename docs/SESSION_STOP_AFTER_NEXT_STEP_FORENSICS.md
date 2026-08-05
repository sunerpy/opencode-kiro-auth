# OpenCode/OMO “宣布下一步后停住”会话取证与修复方案

> 研究日期：2026-08-05
> 时区：本文时间均为 UTC
> OpenCode 运行基线：`1.18.12`
> 实际安装 OMO：`@sunerpy/oh-my-openagent@4.21.0`
> OMO 可读源码基线：`44c95e976dfd13b911de7988872fc2302f2b1092`
> Kiro 插件基线：`opencode-kiro-auth` `7f3955098e156768bc31a74c2cd61f9dc7bea7b7` (`0.18.0`)
> 范围：只取证和提出方案；未修改运行代码、OMO 配置或正在运行的进程

关联报告：
[`KIRO_REPLAY_REQUEST_IDENTITY_RESEARCH.md`](./KIRO_REPLAY_REQUEST_IDENTITY_RESEARCH.md)
分析 Kiro 事件流失败、exact replay 和 compaction 原子性。本文分析的是正常终态、
后台唤醒和跨进程并发，两者不能使用同一个根因解释。

## 1. 最终结论

这次新增的两个样本不是同一种“停止”，也都不能归因于
`Kiro upstream event stream failed unexpectedly`。

1. **Godot 样本没有停止。**被引用的文字位于一个
   `finish:"tool-calls"` assistant message 中；同一消息已经成功调用 `task` 并创建
   `bg_b538b23a`。后台任务结束后，05:27:28 写入完成通知，同一秒启动后续
   assistant 工具回合。
2. **Rust 样本的原回复是正常 `finish:"stop"`。**Kiro 只执行了一次 attempt，
   输出 1,720 个可见字符后正常 EOF，`cause:null`，没有 tool intent。模型文字
   “继续推进”不是机器可执行状态。
3. **Rust 样本随后并非没有恢复，而是恢复到了错误的 OpenCode 进程。**
   06:23:36 的全部后台任务完成通知写入后，`run=5dfa9291` 立即启动 assistant
   回合；该 run 属于 cwd 为 `/config/.config/opencode` 的 `opencode acp`
   进程，而不是用户正在看的 Rust TUI。
4. **用户在看不到隐藏回合时于 06:25:32 输入“继续”，启动了第二条 run。**
   从此 `run=5dfa9291` 与 TUI 的 `run=dbf6e26b` 在同一个 session 上并发执行，
   最终分别创建了两条同名 Hermes memory 子任务。
5. **直接根因是 OMO 把“某 HTTP listener 能读取共享 SQLite 中的 session”
   错当成“该 listener 拥有这个 session 的 UI 和执行循环”。**当前
   `probeSessionAffinity()` 对 `GET /session/<id>` 的任意 2xx 都记录
   affinity。实测 ACP 的 `127.0.0.1:4096` 对 Rust session 返回 200，而用户
   TUI listener 返回 404；两个进程同时打开同一个 `opencode.db`。
6. **放大后果的是 OpenCode 缺少跨进程 session single-flight/lease。**
   错误路由的自动 prompt 与用户 prompt 可以同时驱动同一个 session，没有 fencing
   token 阻止旧 owner 继续调用工具。

因此：

- 当前样本的首要修复所有权在 **OMO 的 parent-wake instance routing**。
- OpenCode 需要提供 **跨进程 session lease、prompt admission 和 assistant-start
  ACK**，才能从根上消除双循环。
- `opencode-kiro-auth` 不应伪造 `tool-calls`、`length` 或自动续写，也不应根据
  assistant 文本猜测“承诺了下一步”。
- `exact_replay`、reasoning signature 回放、`TEXT_TOOL_CALL_OPENING_MARKERS`、
  增加 stream attempt 次数都不是本次修复点。

## 2. 证据等级与边界

本文使用以下标签：

| 标签   | 含义                                                                           |
| ------ | ------------------------------------------------------------------------------ |
| **L1** | `/config/.local/share/opencode/opencode.db` 中的 session/message/part 直接证据 |
| **L2** | `opencode.log` 与 `kiro-auth-plugin/logs/plugin.log` 直接证据                  |
| **L3** | 活进程、`/proc`、监听端口和本地 HTTP A/B 探针                                  |
| **S1** | 实际安装包与固定 Git SHA 的 OMO 源码                                           |
| **U1** | 2026-08-05 重新查询的公开 issue/PR                                             |
| **H1** | 与证据一致、但仍需最小复现验证的设计判断                                       |

必须保持以下边界：

- assistant 文字中的“接下来”“我会派发”“继续推进”不等于工具调用或 continuation
  debt。OpenCode 只认识持久化 message、part、finish、tool 和调度状态。
- `finish:"stop"`、`finish:"tool-calls"`、持久化 `error` 必须分开诊断。
- `clean_eof_without_completion_metadata` 在当前 Kiro endpoint 上是常见的正常终态，
  不能仅因缺少 completion metadata 判定截断。
- 本次 Rust 事故的 wake **成功持久化且确实启动了 assistant**；它不同于
  “prompt 已持久化但完全没有 loop”的 OpenCode #32010。
- 本文证明当前 HTTP affinity 判定在这套多进程拓扑中产生了 false ownership；
  不声称所有 OMO 用户都会命中。
- OMO 源码仓库本轮 CodeGraph 状态为 `missing`，因此 OMO 部分使用固定 SHA
  的精确文件/行读取；`opencode-kiro-auth` 自身 CodeGraph 索引为 current。

## 3. 先建立正确的症状分类

“AI 说下一步要做什么，然后停住”至少有四种不同路径：

| 类型           | 持久化特征                                             | 典型根因域                                   | 本文样本       |
| -------------- | ------------------------------------------------------ | -------------------------------------------- | -------------- |
| 流错误         | assistant `error`，可能已有部分 text                   | provider/transport/recovery                  | 两个样本都不是 |
| 真正正常停     | `finish:"stop"`，没有 tool part                        | 模型决策、机器状态缺失、编排策略             | Rust 原回复    |
| 后台检查点     | `finish:"tool-calls"`，已有 background task            | 等待 child 完成及 parent wake                | Godot          |
| 隐藏或错误恢复 | wake 已写入且 assistant 已启动，但属于错误 process/run | OMO route ownership、OpenCode 并发 admission | Rust 后续      |

诊断顺序应固定为：

1. 查目标 assistant message 的 `finish` 和 `error`。
2. 查同一 message 的 part 类型，确认是否真的存在 `tool`。
3. 若存在后台任务，查 completion wake 是否持久化。
4. 查 wake 后是否存在 `assistant.parentID == wakeMessageID`。
5. 查该 assistant 属于哪个 OpenCode run、PID、cwd 和 listener。
6. 最后才讨论模型、Kiro、代理、超时或 OMO prompt。

## 4. 样本 A：Godot 是后台任务检查点，不是停止

### 4.1 目标对象

- 会话：`ses_03d48279fffeooB3ZWeWmSFiv8`
- 标题：`Godot MCP 服务器 Todo 37 与 F1–F5 门禁`
- 被引用 assistant：`msg_fd053f1ac0016dWL1436367b13`
- 创建时间：05:09:50
- 持久化 finish：`tool-calls`
- error：无

该消息的 part 结构是：

| Part                             | 类型          | 结果                              |
| -------------------------------- | ------------- | --------------------------------- |
| `prt_fd0540efd001eiL7CwAtr0KSjX` | `step-start`  | 正常                              |
| `prt_fd0540eff001u1Ml2lSjfZkEQP` | `reasoning`   | 794 字符，即用户引用的方案文字    |
| `prt_fd054edb2001fvarIrXtkETlhs` | `tool:task`   | tool 调用完成，创建 `bg_b538b23a` |
| `prt_fd054f6e1001AOHDiJ73dCrKpY` | `step-finish` | 正常                              |

这里 tool part 的 `state.status:"completed"` 表示“启动后台任务的 tool call 已返回”，
不是说后台工作瞬间完成。tool output 明确写的是：

```text
Background Task ID: bg_b538b23a
Description: Make Godot output load-bearing in Todo 19 QA
Status: pending
```

### 4.2 后续时间线

| 时间          | 事件                                                             |
| ------------- | ---------------------------------------------------------------- |
| 05:09:50      | assistant 输出 reasoning，并调用 `task` 创建 `bg_b538b23a`       |
| 05:27:28      | user-role system reminder 写入：`ALL BACKGROUND TASKS COMPLETE`  |
| 05:27:28      | assistant `msg_fd064193f001Q7S6wJU2IJ65lM` 立即以 tool call 开始 |
| 05:27:51 以后 | 同一 wake parent 下继续出现多个 assistant 工具回合               |

结论：用户截取的是一个异步边界上的 checkpoint。该样本没有证明模型、Kiro 或 OMO
在那一点终止任务；持久化状态反而证明它正确派发并正确恢复。

## 5. 样本 B：Rust 原回复正常结束，wake 被错误进程消费

### 5.1 原回复没有 Kiro 流错误

- 会话：`ses_0331a40bbffexyIVIYfVG9KYpw`
- 标题：`opencode 的 Rust 兼容实现设计`
- 被引用 assistant：`msg_fd07a5d5d001asgwHmHTHFBGCZ`
- 创建时间：05:51:48
- 持久化 finish：`stop`
- part：`step-start`、1,720 字符 text、`step-finish`
- tool part：0
- error：无

对应 Kiro conversation：

```text
bafeba33-449c-4cc8-888f-7c60c91ad458
```

脱敏后的 terminal 事实：

| 字段             | 值                                      |
| ---------------- | --------------------------------------- |
| stream attempts  | 1                                       |
| upstream events  | 392                                     |
| visible chars    | 1,720                                   |
| emitted tools    | 0                                       |
| saw tool intent  | false                                   |
| open tool intent | false                                   |
| terminal source  | `clean_eof_without_completion_metadata` |
| cause            | `null`                                  |
| process ID       | `2218970`                               |

因此这条回复不是 ECONNRESET、quota、timeout、replay divergence 或 parser 截断。
模型生成了一段“继续推进”的文字，然后正常结束。没有 tool call，OpenCode 没有理由
仅凭自然语言自动开启下一步。

### 5.2 后台完成通知确实到达

该 session 中已有更早启动的后台任务。关键时间线：

| 时间         | 事件                                                     |
| ------------ | -------------------------------------------------------- |
| 06:23:33     | `bg_05c6e93b` 完成通知写入；仍有一个 task 运行           |
| 06:23:36     | `ALL BACKGROUND TASKS COMPLETE` wake 写入                |
| 06:23:36.977 | `run=5dfa9291` 对目标 session 启动 `loop step=0`         |
| 06:23:37.077 | 同一 run 创建 assistant `msg_fd0977e2a0014jt8GAeI3QbGD9` |
| 06:25:31.397 | 同一 run 继续 `loop step=1`                              |
| 06:25:32     | 用户在 TUI 输入“继续”                                    |
| 06:25:32.972 | `run=dbf6e26b` 对同一 session 启动另一条 `loop step=0`   |
| 06:26:21.600 | 隐藏的 `run=5dfa9291` 仍在同一 session 执行 `step=2`     |

这不是“通知没有持久化”，也不是“OpenCode 没有调度 loop”。两件事都发生了；问题是
loop 归属于用户看不到的 ACP 进程。

### 5.3 两条 run 的进程归属

`opencode.log` 的 run 首次启动记录与活进程启动时间、cwd 一一对应：

| 项目                   | 隐藏 run                   | 用户 TUI run                                 |
| ---------------------- | -------------------------- | -------------------------------------------- |
| run                    | `5dfa9291`                 | `dbf6e26b`                                   |
| 首次 creating instance | 2026-08-04 07:06:46        | 2026-08-04 13:01:29                          |
| directory              | `/config/.config/opencode` | `/config/workspace/ProdDir/AI/opencode-rust` |
| PID                    | `24941`                    | `2218970`                                    |
| 命令                   | `opencode acp`             | `opencode`                                   |
| `OMO_PROFILE`          | 未设置                     | `kiro`                                       |
| 关键 listener          | `127.0.0.1:4096`           | `127.0.0.1:42153`                            |

两个进程都打开：

```text
/config/.local/share/opencode/opencode.db
/config/.local/share/opencode/opencode.db-wal
/config/.local/share/opencode/opencode.db-shm
```

所以“能从 DB 读到 session”天然不具备进程所有权含义。

### 5.4 本地 listener A/B

对同一个 Rust session 执行只读 GET：

| Listener              | HTTP | Body bytes |
| --------------------- | ---- | ---------- |
| ACP `127.0.0.1:4096`  | 200  | 572        |
| TUI `127.0.0.1:42153` | 404  | 9          |

用户实际可见并持续操作该 session 的是 TUI，HTTP 200 却来自 ACP。这个 A/B 直接否定
了“`GET /session/<id>` 成功等于 listener 拥有 UI/loop”的假设。

### 5.5 并发执行已经产生真实重复工作

两条 run 后来分别创建同名子任务：

| 时间     | Run        | Background task | Child session                    | Provider/model                        |
| -------- | ---------- | --------------- | -------------------------------- | ------------------------------------- |
| 06:31:23 | `5dfa9291` | `bg_78bb32f9`   | `ses_02f6163e7ffeXsee7bHHUPz2wr` | `myopenai/us.anthropic.claude-opus-5` |
| 06:31:45 | `dbf6e26b` | `bg_27045257`   | `ses_02f610c51ffeZD8cV85DuHQAqw` | `kiro-auth/claude-opus-5-medium`      |

两个 child title 都是：

```text
Research hermes agent memory (@librarian subagent)
```

这不是 UI 显示错觉。两个不同 run、两个 child session、两个 background task 和两次
真实模型调用都已持久化。后续日志还显示两条 run 在同一 parent session 上继续交错，
所以该缺陷会消耗额度并可能造成重复编辑、重复提交或互相覆盖。

## 6. OMO 4.21.0 中的直接根因

### 6.1 当前 affinity 探针验证的是可读性，不是所有权

[`live-server-route.ts:148-174`](https://github.com/sunerpy/oh-my-openagent/blob/44c95e976dfd13b911de7988872fc2302f2b1092/packages/omo-opencode/src/shared/live-server-route.ts#L148-L174)
构造：

```typescript
const probeUrl = new URL(`/session/${sessionID}`, registration.serverUrl)
```

只要 `response.ok` 就执行：

```typescript
setSessionAffinity(registration, sessionID, true)
return true
```

随后
[`live-server-route.ts:252-294`](https://github.com/sunerpy/oh-my-openagent/blob/44c95e976dfd13b911de7988872fc2302f2b1092/packages/omo-opencode/src/shared/live-server-route.ts#L252-L294)
把缓存 affinity 为 true 的 listener 作为 `route:"live"` 返回。

该实现已经意识到 global health 不代表 session ownership，但新增的 session GET 仍然
只证明 listener 可以查数据库。在多 OpenCode 进程共享 SQLite 时，这个判据仍不足。

### 6.2 当前系统缺少稳定 instance identity

`RouteRegistration` 保存 server URL、client、availability 和 session affinity，
但没有一个随 OpenCode 进程启动生成并贯穿 background task 生命周期的
`instanceId`。background task 也没有持久化“父 session 当时由哪个 instance 创建和
展示”。

因此 child 完成时只能重新猜测 route。只要另一个 listener 能返回 session 数据，
就可能把 wake 交给错误实例。

### 6.3 OpenCode 没有跨进程 session single-flight

错误实例已经启动 loop 后，用户实例仍能接受新 prompt。当前没有共享 lease 或 fencing
epoch 阻止：

- 第二个进程开始同一 session 的新 loop；
- 旧进程继续执行后续 step；
- 两个进程同时创建 child session；
- 两个进程同时写工作区。

OpenCode #35399 和 PR #28488 处理的是相邻的 same-parent sibling/turn binding 问题，
但当前事故包含不同 parent prompt、不同进程和持续多 step，不能在没有实测前宣称该 PR
能完整修复。

## 7. 相邻缺口：会放大问题，但不是本次直接触发器

### 7.1 Wake debt 清理早于 assistant-start 证明

[`parent-wake-notifier.ts:364-372`](https://github.com/sunerpy/oh-my-openagent/blob/44c95e976dfd13b911de7988872fc2302f2b1092/packages/omo-opencode/src/features/background-agent/parent-wake-notifier.ts#L364-L372)
在 history 状态为 `persisted` 或 `acknowledged` 时清除 dispatched wake：

```typescript
if (observed.state === 'persisted' || observed.state === 'acknowledged') {
  this.dispatchedTracker.clearWake(sessionID)
  return
}
```

这不能证明目标 instance 已经创建
`assistant.parentID == wakeMessageID`。本次确实创建了 assistant，只是实例错误；在
OpenCode #32010 那类事故中，则可能只持久化 user wake 而完全没有 assistant。

### 7.2 `settleMs: 0`

[`parent-wake-prompt-dispatch.ts:38-48`](https://github.com/sunerpy/oh-my-openagent/blob/44c95e976dfd13b911de7988872fc2302f2b1092/packages/omo-opencode/src/features/background-agent/parent-wake-prompt-dispatch.ts#L38-L48)
对 parent wake 使用 `settleMs:0`。这会放大 busy/idle 边界竞态，也是 OMO #5804
报告的因素之一。

本次 wake 已成功启动 loop，所以它不是本次 false ownership 的必要原因。

### 7.3 已有 timer 时静默忽略新 schedule

[`parent-wake-pending-queue.ts:123-136`](https://github.com/sunerpy/oh-my-openagent/blob/44c95e976dfd13b911de7988872fc2302f2b1092/packages/omo-opencode/src/features/background-agent/parent-wake-pending-queue.ts#L123-L136)
当前逻辑：

```typescript
if (this.pendingParentWakeTimers.has(sessionID)) {
  return
}
```

后来的更早 deadline 或更高优先级 flush 不会更新已有 timer。该缺口适合单独修复，
但不能解释本次已经成功派发到错误进程的 wake。

### 7.4 Todo continuation 在 pending wake 期间主动让路

[`idle-event.ts:86-93`](https://github.com/sunerpy/oh-my-openagent/blob/44c95e976dfd13b911de7988872fc2302f2b1092/packages/omo-opencode/src/hooks/todo-continuation-enforcer/idle-event.ts#L86-L93)
把 running background task 或 pending parent wake 都视为“不应再注入 continuation”。

这个策略本身合理，可避免双重续写；但如果 wake ownership 或 ACK 错了，secondary
safety net 也被关闭。因此 pending wake 必须有可靠 lease、超时和 assistant-start ACK。

## 8. 为什么不是 Kiro 插件问题

### 8.1 Rust 原回复正常终止

日志没有 `SdkEventStreamIterationError`、`UpstreamUnexpectedError`、
`ReplayDivergenceError` 或 quota error。一次 attempt 已完整输出并以 `cause:null` 结束。

### 8.2 Godot 已有真实 tool call

如果 `TEXT_TOOL_CALL_OPENING_MARKERS` 或 dialect parser 吞掉工具，SQLite 不会出现完整
`tool:task` part 和 `bg_b538b23a`。该样本已经排除此路径。

### 8.3 错误恢复发生在 provider 请求之后

06:23:36 wake 写入、OpenCode run 选择、assistant loop 所属进程和后续双 writer 都在
OMO/OpenCode 调度层。Kiro 插件只处理每条已经开始的模型请求，不决定哪个 OpenCode
进程拥有 parent session。

### 8.4 不应在 provider 层猜测自然语言意图

根据“我会”“接下来”“继续推进”等文字伪造 `finish_reason:"tool-calls"` 会造成：

- 普通解释文字被误判为未完成任务；
- 重复工具调用；
- compaction 或总结文本触发续写；
- 多语言、否定句和引用内容误判；
- provider 层越权修改 OpenCode session 语义。

正确状态源是 native todo、goal、background task、wake 和 session lease，不是文本正则。

## 9. 立即可用的缓解方案

### 9.1 OMO 4.21.0 回退开关

实际安装的 `@sunerpy/oh-my-openagent@4.21.0` 已包含：

```jsonc
{
  "[opencode]": {
    "experimental": {
      "disable_live_parent_wake_routing": true
    }
  }
}
```

Schema 定义见
[`experimental.ts:24-25`](https://github.com/sunerpy/oh-my-openagent/blob/44c95e976dfd13b911de7988872fc2302f2b1092/packages/omo-opencode/src/config/schema/experimental.ts#L24-L25)，
初始化接线见
[`create-plugin-module.ts:263-265`](https://github.com/sunerpy/oh-my-openagent/blob/44c95e976dfd13b911de7988872fc2302f2b1092/packages/omo-opencode/src/testing/create-plugin-module.ts#L263-L265)。
启用后
[`live-server-route.ts:258-260`](https://github.com/sunerpy/oh-my-openagent/blob/44c95e976dfd13b911de7988872fc2302f2b1092/packages/omo-opencode/src/shared/live-server-route.ts#L258-L260)
强制返回 in-process client。

当前 `/config/.omo/omo.jsonc` 同时有：

- 基础 `"[opencode]"`；
- `profiles.kiro["[opencode]"]`。

应把开关放在**基础** `"[opencode]"` 下，而不是只放 `profiles.kiro`：

- profile-less ACP 才是本次错误 route 的进程；
- TUI 使用 `OMO_PROFILE=kiro`；
- 放在 base 才能让两者继承同一策略。

如果 base 中已经有 `experimental`，应合并字段，不要创建重复键。

启用后必须重启**所有** OpenCode/TUI/ACP 进程；只重启 TUI 会留下旧 ACP 继续使用
live routing。

### 9.2 适用边界

该开关能缓解：

- parent wake 被另一个可读共享 DB 的 listener 抢走；
- wake 在错误前端中隐形执行；
- 由此触发的同 session 双循环。

它不能修复：

- 模型 `finish:"stop"` 且根本没有 tool/background task；
- OpenCode 已持久化 prompt 但没有调度 loop；
- 合法的跨进程 runner split；
- 已经存在的双 writer；
- Kiro SSE/ECONNRESET。

源码注释表明 live routing 原本用于保护 serve-topology runner split。因此该开关是针对
当前拓扑的回退，不是长期协议。启用后应执行第 13 节的双进程 A/B。

### 9.3 不改配置的操作性缓解

按风险从低到高：

1. 长任务期间停止与当前 TUI 无关的长期 `opencode acp`。
2. 确保一个 session 同时只由一个 OpenCode 前端打开和写入。
3. ACP 与 TUI 使用不同 OpenCode data root/SQLite，避免全局 session 可见性。
4. 用户准备手动输入“继续”前，先检查该 session 最近 30 秒是否已有其他 run 的
   `loop`/`process`；若有，不要再启动第二条 prompt。

这些是运维规避，不替代 ownership 协议。

## 10. 长期修复设计

### P0：把 wake 绑定到创建 background task 的实例

每个 OpenCode 实例启动时生成稳定到进程生命周期结束的：

```text
instanceId
processId
processRole
serverUrl
directory
profile
startedAt
```

创建 background task 时，把 parent 的 `instanceId`、server URL 和 routing epoch
写入 task record。完成时只投递到该实例；不能再扫描 listener 并用 session GET 猜 owner。

若原实例消失，进入显式 failover：

1. 确认 owner lease 已过期；
2. 新实例 CAS 获取 lease epoch；
3. 记录 takeover；
4. 再恢复 wake。

### P0：跨进程 session lease 与 fencing

共享 SQLite 中增加逻辑等价于：

```text
session_id
owner_instance_id
lease_epoch
lease_expires_at
active_prompt_id
updated_at
```

要求：

- 开始 prompt/loop 前原子获取或续租；
- tool execution 前验证 fencing epoch；
- 失去 lease 的旧 loop 不能继续调用工具或创建 child；
- 用户 prompt 到来时，如果另一个 owner 正在执行，返回 queued/conflict，而不是开第二条 loop；
- 进程崩溃后 lease 有界过期，允许恢复。

仅使用进程内 mutex 不够；本次就是两个独立进程。

### P0：Wake 只有在 assistant-start 后才算恢复

推荐状态机：

```text
queued
  -> route_admitted
  -> prompt_persisted
  -> assistant_started
  -> assistant_terminal
```

清除 wake debt 的最低条件应是观察到：

```text
assistant.parentID == wakeMessageID
assistant.runInstanceId == targetInstanceId
```

`persisted` 只证明 user message 入库，`acknowledged` 只证明 API/历史观察成功，都不能作为
任务恢复完成。

### P0：同 session prompt admission

`prompt_async`、用户 prompt、todo continuation、parent wake 和 compaction continuation
必须经过同一个 session admission 层。并发策略只能是：

- join 已有 turn；
- 有序排队；
- 明确拒绝并返回 conflict；
- 经 lease takeover 后替换。

不能让不同 caller 各自启动独立 loop。

### P1：修复 flush deadline 合并

`pendingParentWakeTimers` 应保存 deadline 和 generation。新 schedule 到来时：

- 新 deadline 更早：取消旧 timer 并重排；
- 新 deadline 更晚：保留旧 timer；
- payload 更新：递增 generation，timer 读取最新 wake；
- shutdown/clear：使旧 generation 失效。

不能在 `has(timer)` 时无条件 return。

### P1：明确 `prompt_async` 的成功语义

建议区分：

| 状态                    | 含义                              |
| ----------------------- | --------------------------------- |
| `202 persisted`         | message 已入库，尚未保证执行      |
| `202 admitted`          | 已获得 session lease 并进入队列   |
| `200 assistant_started` | 已观察到对应 assistant            |
| `409 owner_conflict`    | 另一实例持有 lease                |
| `503 schedule_failed`   | 无法调度，caller 应保留 wake debt |

当前把 HTTP 204/成功响应当作 end-to-end 成功，会隐藏 persistence 与 scheduling 之间的
失败窗口。

### P1：把“未完成”建立在机器状态上

对于真正的 verbal-next-step 正常 stop，OMO 应依赖：

- incomplete native todos；
- active goal/plan execution record；
- pending background tasks；
- continuation debt；
- explicit blocked/user-input state。

不要解析 assistant prose。若 agent 声称要派发但同一 turn 没有 tool call，只有在上述
机器状态仍未完成时才注入新 turn。

## 11. 可观测性要求

### 11.1 每次 wake 的稳定关联字段

建议所有 parent-wake 日志至少包含：

```text
recoveryGroupId
wakeId
effectId
sessionId
wakeMessageId
assistantMessageId
parentMessageId
backgroundTaskIds
sourceInstanceId
targetInstanceId
selectedInstanceId
processId
processRole
runId
serverUrl
directoryHash
profile
leaseEpoch
route
routeReason
queueWaitMs
settleMs
promptPersisted
assistantStarted
terminalOutcome
cause
```

### 11.2 事件序列

推荐稳定事件名：

```text
parent_wake_queued
parent_wake_route_candidate
parent_wake_route_probe
parent_wake_route_selected
session_lease_acquired
session_lease_conflict
parent_wake_prompt_persisted
parent_wake_assistant_started
parent_wake_terminal
duplicate_session_loop_rejected
session_lease_takeover
```

每个 `wakeId` 必须有且只有一个 terminal summary。terminal summary 应同时记录原始异常、
最终 route、是否出现 assistant 和是否仍欠 delivery debt。

### 11.3 Route probe 日志必须回答的问题

不能只写 `response.ok=true`，还应写：

- 被探测 listener 的 `instanceId` 和 role；
- listener 声称的 data root；
- session lease owner；
- session directory；
- 当前 active prompt/run；
- HTTP 可读与 owner match 两个独立布尔值。

### 11.4 隐私

不要记录：

- prompt/response 正文；
- token、cookie、Authorization；
- account email、account ID、profile ARN；
- 未脱敏的用户路径。

可以记录 session/message/wake ID、PID、本地端口、哈希目录和枚举状态。本文没有把
Kiro 日志中的账号字段复制进报告。

## 12. 下次事故的只读取证手册

### 12.1 定位持久化终态

```bash
sqlite3 -readonly /config/.local/share/opencode/opencode.db <<'SQL'
SELECT
  id,
  datetime(time_created/1000, 'unixepoch'),
  json_extract(data, '$.role'),
  json_extract(data, '$.parentID'),
  json_extract(data, '$.finish'),
  json_extract(data, '$.error.name')
FROM message
WHERE session_id = '<session_id>'
ORDER BY time_created DESC
LIMIT 30;
SQL
```

### 12.2 检查 tool 与文本

```bash
sqlite3 -readonly /config/.local/share/opencode/opencode.db <<'SQL'
SELECT
  message_id,
  id,
  json_extract(data, '$.type'),
  json_extract(data, '$.tool'),
  json_extract(data, '$.state.status')
FROM part
WHERE message_id = '<message_id>'
ORDER BY time_created;
SQL
```

### 12.3 关联 OpenCode run

```bash
rg -n "session.id=<session_id>" \
  /config/.local/share/opencode/log/opencode.log
```

重点检查同一时间窗是否出现多个 `run=`，以及每条 run 的首次
`creating instance directory=...`。

### 12.4 关联进程和 listener

```bash
ps -eo pid,lstart,args | rg 'opencode( acp)?'
PID=12345
readlink "/proc/$PID/cwd"
ss -ltnp | rg "pid=$PID"
```

只筛选需要的环境字段，不要整段输出 `/proc/<pid>/environ`。

### 12.5 检查 Kiro 是否真的失败

按 conversation ID 或事故时间查：

```bash
rg -n "Kiro stream request (started|terminal)|SDK event stream iteration failed" \
  /config/.config/opencode/kiro-auth-plugin/logs/plugin.log
```

必须同时看 `outcome`、`cause`、`emitted*`、`sawToolIntent` 和 attempt 数，不能只看
`missing completion metadata` WARN。

## 13. 最小复现与验收标准

### 13.1 双进程复现

1. 启动一个 profile-less `opencode acp` 和一个 `OMO_PROFILE=kiro` TUI。
2. 让二者共享同一个 `opencode.db`。
3. 在 TUI 创建 parent session 并启动 background task。
4. 验证 ACP 的 session GET 也能返回 200。
5. 等 child 完成并触发 parent wake。
6. 在 wake admission 窗口从 TUI 再发一个用户 prompt。

### 13.2 Workaround 验收

启用 `disable_live_parent_wake_routing` 后必须满足：

- wake 后只有 TUI run 创建对应 assistant；
- ACP run 不出现该 session 的新 `loop`；
- `assistant.parentID == wakeMessageID`；
- 一个 background completion 只产生一个 parent continuation；
- 不再创建重复同名 child task；
- 普通 background notification 和 TUI 实时流仍工作。

### 13.3 长期修复验收

- 两个进程同时请求同一 session 时，只有一个取得 lease。
- loser 得到明确 queued/conflict，不启动模型请求。
- owner 在 tool call 前丢失 lease 时停止，不能继续写工作区。
- owner 崩溃后，新实例只能在 lease 过期/CAS takeover 后恢复。
- prompt persisted 但 assistant 未开始时 wake debt 不清除。
- assistant 已开始但 UI 断连时，可通过 instance/run 日志定位实际 owner。
- 所有 wake 都有唯一 terminal summary。

## 14. 公开 issue/PR 对照

状态于 2026-08-05 重新查询：

| 项目                                                                     | 状态                          | 与本次关系                                                                                                        |
| ------------------------------------------------------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [OMO #5804](https://github.com/code-yeongyu/oh-my-openagent/issues/5804) | OPEN                          | 相关症状族；明确指出 `settleMs:0`、timer 丢 schedule 和缺少 end-to-end ACK，但不是本次 false ownership 的直接证明 |
| [OMO #5790](https://github.com/code-yeongyu/oh-my-openagent/issues/5790) | OPEN                          | 后台结果直到人工 follow-up 才出现；症状相近                                                                       |
| [OMO #5573](https://github.com/code-yeongyu/oh-my-openagent/issues/5573) | OPEN                          | todo/background completion hang；相邻但不同                                                                       |
| [OpenCode #38092](https://github.com/anomalyco/opencode/issues/38092)    | OPEN                          | `prompt_async` 在 persistence 完成前返回 204；说明成功语义过早                                                    |
| [OpenCode #32010](https://github.com/anomalyco/opencode/issues/32010)    | OPEN                          | prompt 已持久化但 loop 未调度；是最接近的 bridge failure，但本次 loop 实际在错误实例启动                          |
| [OpenCode #35399](https://github.com/anomalyco/opencode/issues/35399)    | OPEN                          | same-parent assistant sibling race；与双 loop 后果相关                                                            |
| [OpenCode PR #28488](https://github.com/anomalyco/opencode/pull/28488)   | OPEN，mergeable=true，blocked | turn binding/per-turn lock；值得验证，但不能预设覆盖跨实例、不同 parent prompt 的本次事故                         |

目前没有一个公开 issue 精确描述：

```text
shared SQLite
  + GET /session returns 200 on non-owner ACP
  + OMO records false affinity
  + wake starts in hidden ACP run
  + user prompt starts second TUI run
```

因此应单独向 OMO 报告该最小复现，并把 OpenCode 的跨进程 lease 作为独立上游需求。

## 15. 推荐实施顺序

1. **立即运维缓解**：停止无关 ACP，或在 base `[opencode]` 启用
   `disable_live_parent_wake_routing`，重启所有进程并执行双进程 A/B。
2. **先补日志**：在改 routing 前加入 `wakeId + instanceId + runId + assistantStarted`
   关联，否则下一次只能再次人工拼 SQLite、日志和 `/proc`。
3. **修 OMO route ownership**：task 创建时绑定 instance，不再以 session GET 猜 owner。
4. **修 assistant-start ACK**：persisted/acknowledged 不再清 wake debt。
5. **修 OpenCode admission**：共享 session lease、fencing 和明确 conflict。
6. **修 timer 合并与 settle**：作为独立可靠性项，不和 ownership 修复混为一个补丁。
7. **最后处理 verbal-next-step**：用 todo/goal/continuation debt 驱动，不解析 prose。

## 16. 最终工程判断

- Godot 样本是健康的异步 checkpoint。
- Rust 原回复是正常模型 stop，不是 Kiro 流故障。
- Rust 后续“没继续”是 UI 视角；机器实际上在 ACP 中继续。
- 当前最直接的 bug 是 OMO 的跨进程 false session affinity。
- 当前最危险的后果是 OpenCode 允许两个 run 长时间并发驱动同一 session。
- `disable_live_parent_wake_routing` 是可用的短期回退，但需要全进程重启和 A/B。
- 长期方案必须是 instance-bound wake + session lease + assistant-start ACK。
- 不需要、也不应该为此修改 `opencode-kiro-auth` 的 finish reason 或工具解析。

## 17. 本次插件发版的适用边界

基于相邻的 Kiro replay 研究，本次 `opencode-kiro-auth` 发版只处理插件确实拥有的
两类状态：

1. HTTP 200 之后 SDK event stream 迭代失败时，恢复 attempt 的转换后请求身份；
2. OpenCode compaction 摘要在完整成功前不发布 partial bytes。

它不会修改以下行为：

- 不根据“我接下来会……”等 assistant prose 猜测是否应继续；
- 不伪造 `finish_reason:"tool-calls"` 或补造工具调用；
- 不改变 OMO background task 的 owner、wake routing、assistant-start ACK；
- 不为 OpenCode 增加跨进程 session lease 或 fencing；
- 不把正常 `finish:"stop"` 重新分类为流错误。

因此，发布后的判读仍必须先分型：

- 若日志出现同一 `recoveryGroupId` 的 stream failure/recovery 记录，使用本次新增的
  semantic fingerprint、wire ID、attempt cause 和 terminal summary 诊断；
- 若 assistant 正常 stop，随后任务只在隐藏 ACP 中继续或出现双 run，仍按本文的
  OMO/OpenCode ownership 路径处理；
- 若只是模型写了下一步计划但没有 tool part、todo/goal debt 或 background task，插件
  不会也不应自动续写。

这一区分避免把 provider 可靠性修复误报成 OMO 调度修复，也避免为修复 ACP owner
问题而破坏 Kiro 的工具、finish reason 或签名语义。
