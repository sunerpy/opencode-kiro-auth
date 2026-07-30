# kiro-auth 回合提前结束（premature stop）根因调查

> 本文可独立阅读。所有数字都能由本目录里提交的原始产物重算，重算命令见
> [§8 复现命令](#8-复现命令)。**本次调查没有改动任何生产代码**，也没有改动任何既有测试。
>
> **唯一不在仓库里的产物是 `captured-inbound*.json`**（已加入 `.gitignore`）。它内嵌 OpenCode
> 的 system prompt，而那段文本携带本机的工作目录、当天日期和本机已安装 skill 的完整清单，
> 不适合公开。它可以用一条**零额度**命令重新生成（见 §8），本文的每一个数字都不依赖它——
> 依赖它的只有「重新跑一次探针」这件事。

---

## 0. 一句话结论

**根因已定位并证明：不是模型问题，也不是推理签名问题，而是本插件把「工具结果」翻译成
一条内容为字面量 `'Tool results provided.'` 的新用户消息（`history-builder.ts:155` /
`request.ts:184`）。在工具循环的第一次续跑（turn 2）上，这条填充文本使模型以
16.0%（23/144）的概率只输出一段总结文本就结束回合；把这条填充文本换成空串、机器标签
或显式续跑指令，停止率都变成 0/120（Fisher 精确检验双侧 p < 1e-5）。**

> ⚠️ **§7.1 推荐的那个取值（`'[tool results]'`）在一次独立复现里没能复现出 0%，因此修复没有
> 实施。** 详见新增的 [§11 复现验证](#11-复现验证与修复未实施的原因)：同一批次内 V0 = 19.6%
> （复现成功）、`''` = 0/128（复现成功）、显式续跑指令 = 0/128（复现成功），而
> `'[tool results]'` = **24/256 = 9.4%**（对自己先前的 0/120，Fisher p = 0.00013，**复现失败**）。
> 本文 §4/§5 的机制结论不受影响；受影响的只有 §7.1 的**取值选择**。
>
> ✅ **答案在第三批 [§12 官方值调研](#12-官方值调研userinputmessagecontent-该填什么) 与
> [§13 候选筛选](#13-两阶段候选筛选唯一存活者是所有填充点都置空)：官方客户端发的是空串 `""`，
> 而唯一在两个位置都干净的取值是「**当前消息和 history 里每一个工具结果填充点都置空**」
> （C5：turn 2 = 0/256、turn 5 = 0/256，各 2×128 两个独立批次）。**§11 说「`''` 是陷阱」并没有
> 错，但它测的是一个没有任何客户端会发出的中间态** —— 只清空当前消息、history 里还留着整句
> 英文。把一致性补上，turn 5 的 7.8% 就消失了（C5 vs V1：p < 1e-4）。和解过程见 §13.6。
> 生产代码本批仍然一行未改。**
> 📎 **官方客户端行为的一手证据补录见
> [§15](#15-官方客户端行为的一手证据补录)**：Kiro CLI 2.12.0 的实时 trace 与 Kiro IDE 的连续请求体
> 证实 `content` 在当前回合和沉入历史后都保持 `""`，Smithy 模型本身也不要求非空。该节同时说明
> 它**只**独立佐证官方行为，因果数字仍来自本文自己的测量。

同时有两个同样重要的否证结论：

- **`collapseAgenticLoops` 不是原因。** 在长任务的真实形态下（turn 5，历史里已有 2 个被
  占位符替换的助手回合），生产基线 0/120，撤销折叠后同样 0/120（p = 1.0）。
- **这个缺陷只发生在 turn 2。** turn 3 / 4 / 5 的生产基线分别是 0/114、0/120、0/120。
  一旦循环里有 ≥2 个已完成的「助手调工具 → 工具结果」对，停止率就落到统计上测不出的水平。

---

## 1. 用户报告与本次调查的关系

用户的报告是：_长任务里 agent 说完「接下来我要做什么」就停了，不再发出工具调用_，并且
**「我当前使用 myopenai 的 provider 就没有问题，所以问题还是在插件里」**。

先前已完成的工作（提交在 `scripts/probes/ab-opencode/`，24 次真机 OpenCode 运行）确认：

- 症状真实存在，24 次里复现 3 次（12.5%），三次**全部停在 turn 2**；
- 最终助手文本是 `hop 1: step01 -> seed 7 -> 7\n\nNext: step07`，`step_finish reason='stop'`；
- 上游确实返回了 `finish_reason=stop`，插件没有吞掉工具调用；
- **推理签名回放这个修复并不能减少提前停止**（2/8 vs 1/8，Fisher p = 1.0）。

所以本次任务的问题是：既然不是签名，那到底是什么。

---

## 2. 方法：为什么不用整跑 10 跳来做二分

三次失败**全部**发生在 turn 1 → turn 2 的过渡上，所以没必要为二分去跑完整的 10 跳会话。
本调查把这一次过渡单独隔离出来：**一次试验 = 一次真实 API 调用、约 2.7 秒**。同样的额度
下，样本量从「24 次运行」变成「每个变体 120 次试验」，这是本次能给出 p < 1e-5 而不是
p = 1.0 的唯一原因。

隔离靠三个零成本的构件：

1. **`capture-inbound.ts` —— 零额度捕获插件的入参。**
   插件自己的 `api-*.ndjson` 日志**故意**把 `conversationState.history` 换成
   `historyLength`（`src/core/request/sdk-log-payload.ts`），所以生产日志永远看不到发出去的
   history。诚实的做法是反过来捕获**输入**：用一个隔离的 `XDG_CONFIG_HOME` 声明
   **provider id `kiro-auth`、model id `claude-opus-5-high`**（与生产完全相同的两个 id，
   因此 OpenCode 会选同一套 system prompt、同一个 `@ai-sdk/openai-compatible` 序列化器），
   但把 `baseURL` 指向本地 mock。**插件本身不加载**，mock 站在插件自定义 `fetch` 的位置上。
   0 次 API 调用、0 额度、不写 `kiro.db`、不动真实配置。

2. **`turn2-variant-probe.ts` —— V0 由真实 `transformToSdkRequest` 生成。**
   V0 不是手写近似，而是把捕获到的入参交给真实的 `transformToSdkRequest`。每个变体只在
   V0 的输出上**改动恰好一个元素**。

3. **`verify-v0.ts` —— 证明 V0 等于生产请求。**
   把 V0 与真实 `api-*.ndjson` 里的 turn-2 请求逐字段比对，**包括 10 个工具 schema 的
   sha256 字节相等**。

### 2.1 V0 = 生产请求（逐字段）

对 `results/phase1-providers/kiro-01/api-filtered.ndjson`（本次新跑）和
`../ab-opencode/results/baseline/old-03/api-filtered.ndjson`（**先前真实发生提前停止的那一次
运行**）都跑过，两次结论一致：

| 字段                                     | V0                                                           | 生产                        | 一致   |
| ---------------------------------------- | ------------------------------------------------------------ | --------------------------- | ------ |
| chatTriggerType                          | MANUAL                                                       | MANUAL                      | 是     |
| history 长度                             | 2                                                            | 2                           | 是     |
| history 角色顺序                         | user,assistant                                               | user,assistant              | 是     |
| currentMessage.content                   | `"Tool results provided."`                                   | `"Tool results provided."`  | 是     |
| currentMessage.modelId                   | claude-opus-5                                                | claude-opus-5               | 是     |
| currentMessage.origin                    | AI_EDITOR                                                    | AI_EDITOR                   | 是     |
| 工具数量                                 | 10                                                           | 10                          | 是     |
| 工具名                                   | bash,edit,glob,grep,read,skill,task,todowrite,webfetch,write | 同上                        | 是     |
| **工具 schema sha256/16**                | **d833f0d870b9087f**                                         | **d833f0d870b9087f**        | **是** |
| toolResults 数量 / status / content 形状 | 1 / success / 1 block(text)                                  | 1 / success / 1 block(text) | 是     |
| conversationState 键集合                 | chatTriggerType,conversationId,currentMessage,history        | 同上                        | 是     |

**声明为预期差异、未作等值比较的四项：** `conversationId`（每请求 `crypto.randomUUID()`）、
`toolUseId`（上游每请求新生成）、工具结果文本与 system prompt 里内嵌的工作目录路径、
第一个助手回合的可见文本（捕获用的是从 `old-03` 抄来的同一句
`"I'll start by reading the first ledger file."`，生产是模型自己那一句）。

> 注：`api-filtered.ndjson` 里出现 `toolCount` 而不是 `tools` 是 `sanitize-runs.ts:89
stripToolSchemas` 的产物，**不是** bug。原始（未脱敏）日志里工具 schema 是完整的，上表
> 的 sha256 就是与原始日志比出来的。

### 2.2 捕获文件不可字节复现，以及这对结论意味着什么

OpenCode 的 system prompt 里含有 `Today's date: ...`、`Working directory: ...`、`Platform: ...`
以及本机 `<available_skills>` 清单，所以它的 sha256 **每天、每个目录、每台机器都不一样**
（本次两个捕获都是 `len=21554 sha256=0fca0c0f332e9ddd…`；几分钟前的一次捕获同样是 21554
字符，哈希却不同）。因此：

- **不要**把这个 sha256 当成复现的前置条件，它只是本次的溯源信息；
- 换一台机器重跑，V0 的 system prompt 会不同，**基础率可能不同**——这正是 §7.3 要求
  「候选修复必须与自己的基线同批次对比」的原因；
- 反过来说，本次捕获与先前真机观察到症状的那次运行**来自同一台机器、同一个 agent**
  （工具 schema 的 sha256 与 `old-03` 字节相同即为证），而实测 16.0% 与真机 12.5% 相符，
  所以它忠实于用户实际遇到问题的那个环境。

---

## 3. Phase 1：先量化用户的前提（42 次真机运行）

同一个已提交的 fixture、同一个 OpenCode 二进制、同一个 `--dir`、三条臂严格交错：

| 臂       | 模型                                                                        | 运行数 | completed_correct | announced_then_stopped | silent_stop | other_failure | 提前停止率  | 95% CI    |
| -------- | --------------------------------------------------------------------------- | ------ | ----------------- | ---------------------- | ----------- | ------------- | ----------- | --------- |
| kiro     | kiro-auth/claude-opus-5-high                                                | 14     | 14                | 0                      | 0           | 0             | 0/14 (0.0%) | 0.0–21.5% |
| myopenai | myopenai/us.anthropic.claude-opus-5（`reasoningEffort: max`，用户实际配置） | 14     | 14                | 0                      | 0           | 0             | 0/14 (0.0%) | 0.0–21.5% |
| myohigh  | myopenai/us.anthropic.claude-opus-5（`reasoningEffort: high`，effort 对照） | 14     | 14                | 0                      | 0           | 0             | 0/14 (0.0%) | 0.0–21.5% |

两两 Fisher 精确检验全部 p = 1.0000。

**必须说清楚的话：Phase 1 什么都没证明，因为 kiro 臂自己也是 0/14。** 在 12.5% 的基础率下
`P(14 次全不中) = 0.875^14 = 0.15`，所以 0/14 与 12.5% 完全相容——这是功效不足，不是
反证。用户的前提在这一层**既没有被证实也没有被推翻**。

- 加了 `myohigh` 臂是因为用户的 `myopenai` 配置是 `reasoningEffort: max`，而 kiro 臂是
  `-high`；两个 effort 都跑了，都是 0/14，所以 effort 不是混淆项。
- 把这 14 次与先前提交的 24 次 kiro 路径运行合并（那 24 次两条臂都走 kiro 插件），
  kiro 路径合计 **3/38 = 7.9%**，myopenai 合计 **0/28 = 0%**，Fisher p = 0.26。方向与用户的
  说法一致，但仍然不显著。合并时的保留意见：那 24 次用的是 `sticky` 账号策略、其中一半是
  已发布的 0.15.4 构建。
- 结论：**要回答这个问题，整跑是错误的仪器。** Phase 2 用同样的额度把功效提高了两个数量级。

---

## 4. Phase 2：turn-2 变体二分（每变体 n=120）

模型 `claude-opus-5-high`（wire `claude-opus-5`，effort `high`、us-east-1）。
判定口径故意分开，因为它们是不同的故障：

- `continued` —— 发出了工具调用，循环会继续；
- `stopped` —— HTTP 200、没有工具调用、但有真实助手文本（**就是用户报告的症状**）；
- `empty200` —— HTTP 200 但既无文本也无推理也无工具调用（**另一个已知的、不同的缺陷**）；
- `error` —— 非 200 或网络失败，从速率分母中剔除。

### 4.1 turn 2（工具循环的第一次续跑）

| 变体   | 只改了什么                                                            | n   | stopped | 速率      | 95% CI     | vs V0 的 Fisher p  |
| ------ | --------------------------------------------------------------------- | --- | ------- | --------- | ---------- | ------------------ |
| **V0** | 基线：与插件今天发出的完全一致                                        | 144 | 23      | **16.0%** | 10.9–22.8% | —                  |
| **V1** | `content` 改成空串                                                    | 120 | 0       | **0.0%**  | 0.0–3.1%   | **0.0000**         |
| **V2** | `content` 改成机器标签 `[tool results]`                               | 120 | 0       | **0.0%**  | 0.0–3.1%   | **0.0000**         |
| **V3** | `content` 改成显式续跑指令                                            | 120 | 0       | **0.0%**  | 0.0–3.1%   | **0.0000**         |
| **V4** | 补上本 fork 从不发送的 `<thinking_mode>` system 前缀                  | 120 | 0       | **0.0%**  | 0.0–3.1%   | **0.0000**         |
| **V5** | 把助手回合的可见文本换成 `[system: tool calling continues]`           | 120 | 114     | **95.0%** | 89.5–97.7% | **0.0000**         |
| V6     | 补上 SDK 暴露但插件从不设置的 `agentTaskType` / `agentContinuationId` | 120 | 22      | 18.3%     | 12.4–26.2% | 0.6257             |
| V7     | 用与真实前一回合共享的 `conversationId`（含一次预热调用）             | 119 | 18      | 15.1%     | 9.8–22.6%  | 0.8664             |
| V8     | system prompt 单独成一个 history 回合（turn-1 的形状）                | 120 | 41      | **34.2%** | 26.3–43.0% | **0.0008（更差）** |

`empty200` 在全部 1223 次 turn-2 试验里是 **0**。

**V0 停止时的最终文本与已提交的真机失败逐字一致**，例如
`"hop 1: step01 -> seed 7 -> 7\n\nNext: step07."`——而**成功的试验输出的是同一段文本，只是
后面多了一个工具调用**。所以差别从来不在文本内容上，只在于那一次采样有没有在总结之后再
追加 `tool_use`。

### 4.2 turn 3 / 4 / 5（生产基线）

| 位置   | history 长度 | 被折叠的助手回合数 | n   | stopped         |
| ------ | ------------ | ------------------ | --- | --------------- |
| turn 2 | 2            | 0                  | 144 | **23（16.0%）** |
| turn 3 | 4            | 0                  | 114 | 0（0.0%）       |
| turn 4 | 6            | 1                  | 120 | 0（0.0%）       |
| turn 5 | 8            | 2                  | 120 | 0（0.0%）       |

### 4.3 turn 5：长任务形态下的变体（候选修复的安全性）

| 变体                                                             | n   | stopped | 速率     | vs turn-5 V0 的 Fisher p |
| ---------------------------------------------------------------- | --- | ------- | -------- | ------------------------ |
| V0 生产基线                                                      | 120 | 0       | 0.0%     | —                        |
| **V9 撤销 `collapseAgenticLoops`**（把每个占位符还原成真实文本） | 120 | 0       | 0.0%     | 1.0000                   |
| V5 把**全部**助手文本换成占位符                                  | 120 | 0       | 0.0%     | 1.0000                   |
| **V1 `content` 空串**                                            | 120 | **8**   | **6.7%** | **0.0069（更差）**       |
| V2 `content` = `[tool results]`                                  | 120 | 0       | 0.0%     | 1.0000                   |
| V3 `content` = 显式续跑指令                                      | 119 | 0       | 0.0%     | 1.0000                   |
| V4 `<thinking_mode>` 前缀                                        | 117 | 0       | 0.0%     | 1.0000                   |
| V6 `agentTaskType`                                               | 120 | 0       | 0.0%     | 1.0000                   |

**这一张表决定了该选哪个修复：V1（清空 `content`）在 turn 2 有效但在 turn 5 反而引入了
6.7% 的停止率（p = 0.0069）。V2 与 V3 在两个位置都是 0。**

### 4.4 功效声明（这个 N 能测到什么、测不到什么）

- turn 2：V0 = 23/144。在 n=144 的变体里，**最多 11 次停止**才能对 V0 达到 p < 0.05。
  也就是说本 N 能可靠分辨「16% → ≤7.6%」，但分辨不出「16% → 12%」这种小幅下降。
  V1–V4 的 0/120 远在这条线以下，不是噪声。
- turn 3/4/5：V0 = 0/120。**在 0 基线上，任何数量的停止（包括 0）都不可能对 V0 达到
  p < 0.05 的「下降」**——这些格子只能证明「没有变差」，不能证明「变好」。turn-5 的 V2/V3/V4
  因此只能读作**安全性证据**，不能读作有效性证据。
- turn 3 的 6 次 error 与 turn-5 的 3 次 error 全是 `ThrottlingException` 429（并发 6 的代价），
  另有 2 次是 HTTP 200 之后事件流报 `Encountered an unexpected error`。三类都从分母剔除。

---

## 5. 结论与机制解释

### 5.1 单一因素成立，效应量已量化

**`'Tool results provided.'` 这条填充文本是 turn-2 提前停止的必要条件。**
把它换掉（V1/V2/V3 三种互不相同的换法）都把 16.0% 打到 0.0%，p < 1e-5。

机制上最自洽的解释：CodeWhisperer 的 `userInputMessage.content` 是必填的字符串，而工具结果
在 Kiro 协议里只能挂在一条 `userInputMessage` 上（这一点与 Anthropic 原生的
`{"role":"user","content":[{"type":"tool_result"}]}` 是同构的，**不是**本插件的发明）。但
Anthropic 原生形态下那条用户消息**只有** tool_result 块、没有文本块；本插件为了填满必填的
`content`，额外插入了一句**完整的英文陈述句**。在 turn 2，上下文里只有一个助手回合作为
「我会调用工具」的示范，这句由「用户」说出的陈述句足以把模型推向「用户在跟我说话，我该
汇报一下」——于是它输出那段 fold 总结就收尾了。到了 turn 3 及以后，上下文里已经有多个
「助手调工具 → 工具结果」对作为更强的行为示范，这句填充文本就压不动模型了（0/114、
0/120、0/120）。

V4（补 `<thinking_mode>`）也能把 turn 2 打到 0，说明**存在第二条独立的抑制通道**：让模型先
思考再动作也能盖住这个倾向。但这条路要动 `think` 的取值，属于另一个决策（见 §7 的取舍）。

V5 是同一机制的反面确认，效应更大：**把发出工具调用的那个助手回合的可见文本换成合成占位符，
turn 2 的停止率飙到 95.0%。** 助手自己那句话是「我正在执行一个多步计划」的关键上下文证据。

### 5.2 明确被否证的四条假设

| 假设                                                                   | 结论                       | 证据                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `collapseAgenticLoops` 破坏中间助手文本导致长任务提前停止（怀疑点 #3） | **否证**                   | turn 5 生产基线 0/120；撤销折叠（V9）同样 0/120，p = 1.0。而且**折叠在 turn 2 根本不生效**（`pairCount > 1` 才触发），所以它不可能是那三次真机失败的原因。                                                                                 |
| `[system: ...]` 合成占位符（怀疑点 #2）                                | **在失败点上不存在**       | turn-2 的 history 是 `[user, assistant]`，没有任何占位符——这一点由 V0 与生产日志的逐字段比对直接读出。V5 只说明「**如果**把最后一个助手回合的文本换成占位符会怎样」，而 `collapseAgenticLoops` 永远保留最后一个助手回合的原文（见 §5.3）。 |
| 每请求新建 `conversationId`（怀疑点 #5）                               | **否证**                   | V7 15.1% vs V0 16.0%，p = 0.8664（且做了真实的前一回合预热）。                                                                                                                                                                             |
| Kiro 的「HTTP 200 空响应」是同一个故障                                 | **否证：是两个不同的故障** | 2423 次探针试验里 `empty200` 恒为 **0**；停止的试验都有 43–57 个字符的真实文本（真机 `tokens_out` 是 11–15）。空 200 在先前的 `cross-account-replay-probe` 里独立观察到过，与本缺陷无关。                                                  |

另有两个**新增**的、之前没人提出的候选也被否证/证否：

- **V6：SDK 里有 `conversationState.agentTaskType`（枚举 `spectask|vibe`）和
  `agentContinuationId`，插件从不设置，只设置了同名的 HTTP 头
  `x-amzn-kiro-agent-mode: vibe`。** 补上它们没有任何效果（18.3%，p = 0.63）。这条值得记下来，
  免得以后有人再猜一次。
- **V8：把 system prompt 单独放成一个 history 回合（也就是 turn 1 的形状），而不是像
  `injectSystemPrompt` 那样拼进第一条用户消息** —— 让情况**更糟**（34.2%，p = 0.0008）。
  当前的拼接行为是更好的那一个，不要去动它。

### 5.3 一处必须精确表述的细节（否则会被误读）

`collapseAgenticLoops`（`history-builder.ts:50-73`）在 `pairCount > 1` 时，会把**除第一个之外**的
中间助手回合的 `content` 换成 `[system: tool calling continues]`，但**保留** `toolUses`；而序列
末尾那个「后面没有跟着工具结果」的助手回合走的是 `i = seqEnd` 之后的普通分支，**原文被完整保留**。
本次实测（`captured-inbound-hop5.json`，turn 3/4/5/6）验证了这一点：

```
turn 5, historyLength=8:
  h[1] ASST "I'll start by reading the first ledger file."   toolUses=1   <- 保留
  h[3] ASST "[system: tool calling continues]"               toolUses=1   <- 被折叠
  h[5] ASST "[system: tool calling continues]"               toolUses=1   <- 被折叠
  h[7] ASST "hop 3 folded. Reading the next ledger file."    toolUses=1   <- 保留（紧邻当前工具结果）
```

所以 V5 那个 95% 的条件（**紧邻当前工具结果的那个助手回合**被占位符化）在生产里**从未发生**。
V5 是机制实验，不是生产复现。任何把「V5 = 95%」直接说成「折叠导致长任务失败」的转述都是过度解读。

---

## 6. 关于「myopenai 没问题」这句话，能说到什么程度

- **不能**说 Phase 1 证实了它：kiro 臂自己 0/14。
- **可以**说：本插件在 turn 2 发出的那条请求，把其中**一个** Kiro 协议特有的字段
  （`userInputMessage.content = 'Tool results provided.'`）换掉，16.0% 的停止率就归零。
  这个字段在 OpenAI/Anthropic 协议下**根本不存在**——那边工具结果是 `tool` 角色消息或纯
  `tool_result` 块，不需要也不允许附带一句人话。**所以用户「问题在插件的翻译里」这个判断是
  对的，而且现在有了具体的字段和 p 值**，只是支持它的证据来自 Phase 2，不是 Phase 1。
- 用户提示词里的 `"` 包裹（`"You are auditing…"`）**不是**插件双重编码：在完全不加载插件的
  捕获里（`captured-inbound.json` 的 `messages[1].content`）它就已经存在了，所以是 OpenCode CLI
  对位置参数的处理，两条臂都一样，不构成混淆项。这一条本次顺手证伪掉了。

---

## 7. 修复提案（本次任务**不实现**）

> ⚠️ 本节写于调查当时。**其推荐取值已被 §11 的复现推翻，且整节已被 §13.7 取代 —— 请连同
> §11 与 §13 一起读，不要单独按本节决策。**

### 7.1 建议方案：把工具结果的填充文本改成非陈述句的机器标签

**唯一改动点：** `src/infrastructure/transformers/history-builder.ts:155` 与
`src/plugin/request.ts:184` 里的字面量 `'Tool results provided.'`。

候选取值与实测：

| 取值                                                                               | turn 2 | turn 5           | 评价                                                       |
| ---------------------------------------------------------------------------------- | ------ | ---------------- | ---------------------------------------------------------- |
| `'Tool results provided.'`（现状）                                                 | 16.0%  | 0.0%             | 现状                                                       |
| `''`                                                                               | 0.0%   | **6.7%（更差）** | **不要用**：长任务上引入了新的停止                         |
| `'[tool results]'`                                                                 | 0.0%   | 0.0%             | ~~建议~~ **§11 复现失败：turn 2 实测 9.4%，不要按本行决策** |
| `'Tool results provided. Continue with the next tool call now; do not summarize.'` | 0.0%   | 0.0%             | 有效，但插件在向模型注入指令（见下）；§11 复现成功         |

推荐 `'[tool results]'`：它在两个位置都是 0，而且不向模型注入任何行为指令。V3 那种显式指令
同样有效，但让插件替用户往对话里塞「不要总结」这类命令，会和 OpenCode 自己的 system prompt
以及用户的 agent 设定产生不可控的叠加，属于产品决策而不是纯翻译修复——如果要走这条路，应该
放在配置项后面，默认关闭。

### 7.2 不能破坏的不变量（改动前必读）

- 计划 §5：**不得**改动 provider id `kiro-auth`、模型 id、effort 映射、AWS 端点、请求头、
  user-agent 字符串。本提案一个都不碰。
- `AGENTS.md` 冻结的 AWS wire 字面量：`x-amzn-kiro-agent-mode: 'vibe'`、`KiroIDE` /
  `Kiro IDE` user-agent、`auth.desktop.kiro.dev`、`q.{region}.amazonaws.com`、
  `ORIGIN_AI_EDITOR: 'AI_EDITOR'`。**`'Tool results provided.'` 不在这份清单里**——它不是 AWS
  期望的字面值，而是本插件为填满必填 `content` 自己造的填充文本（上游 `tickernelz` 与
  `AIClient-2-API` 同源实现里也是自造的）。这是这个改动可以做的前提。
- `request.ts:184` 那一行是 `curContent = curTrs.length ? '<填充文本>' : '[system: conversation
continues]'`，两个分支语义不同：**只改有工具结果的那一支**，另一支（无工具结果的助手续跑）
  未被本次实验覆盖，不要一起改。
- 计划 §6.7 的折叠约束（保留每个回合的 `reasoningContent`、不跨工具结果边界搬运推理、保留
  现有 `toolUses` id 与顺序、保留占位符行为）在本提案下全部无影响：不动 `collapseAgenticLoops`。
- 现有测试里对这个字面量有断言的地方需要同步更新——**这是唯一允许改测试的理由**，且必须是
  「跟随实现改期望值」，不得删除或弱化任何测试。

### 7.3 该怎么验证这个修复

1. **单元层：** 在 `src/__tests__/` 新增用例，断言两条路径（`history-builder.buildHistory` 的
   `role === 'tool'` 分支、`request.ts` 的当前回合分支）产出的 `content` 是新字面量，且
   `toolResults` / `tools` / `toolUseId` / history 角色顺序完全不变。
2. **翻译层（零额度）：** 重跑 `verify-v0.ts`，除 `currentMessage.content` 一项外所有字段
   仍与生产日志一致——这一步用来证明改动的作用面**只有**这一个字段。
3. **真机层（有效性）：** 用本目录的探针，`--turn 2 --n 120` 跑「现状 vs 新字面量」两个变体，
   要求新字面量对现状的 Fisher p < 0.05。**必须与基线同批次跑**，不要拿本文的 23/144 当对照
   （基础率会随上游模型快照漂移）。
4. **真机层（安全性）：** 同样的两个变体在 `--turn 5 --n 120` 上跑，要求新字面量不显著变差。
5. **端到端：** `run-ab.ts --mode provider --runs 14` 只是补充证据；如 §3 所述，它的功效不足以
   独立支撑结论，**不要**把它当验收门槛。

---

## 8. 复现命令

`captured-inbound*.json` 不在仓库里（见文首说明），所以**任何要真实发请求的步骤都必须先跑一次
捕获**。捕获本身零额度。

```bash
bun install

# ── 零额度：捕获插件的入参（不加载插件、不写 kiro.db、不动真实配置）
#    这是后面所有步骤的前置；产物已被 .gitignore 忽略，请勿提交
bun run scripts/probes/premature-stop/capture-inbound.ts \
  --out scripts/probes/premature-stop/captured-inbound.json            # turn 1..2
bun run scripts/probes/premature-stop/capture-inbound.ts --hops 5 \
  --out scripts/probes/premature-stop/captured-inbound-hop5.json       # turn 1..6

# ── 零额度：证明 V0 等于生产请求
bun run scripts/probes/premature-stop/verify-v0.ts \
  --capture scripts/probes/premature-stop/captured-inbound.json \
  --api scripts/probes/premature-stop/results/phase1-providers/kiro-01/api-filtered.ndjson
bun run scripts/probes/premature-stop/verify-v0.ts \
  --capture scripts/probes/premature-stop/captured-inbound.json \
  --api scripts/probes/ab-opencode/results/baseline/old-03/api-filtered.ndjson   # 真机失败的那一次

# ── 零额度：查看每个变体会发出什么
DRY=1 bun run scripts/probes/premature-stop/turn2-variant-probe.ts \
  --capture scripts/probes/premature-stop/captured-inbound.json

# ── 零额度：从已提交的原始产物重算本文所有表格
bun run scripts/probes/premature-stop/analyze-premature-stop.ts \
  --phase1 scripts/probes/premature-stop/results/phase1-providers
for t in turn2 turn3 turn4 turn5; do
  bun run scripts/probes/premature-stop/analyze-premature-stop.ts \
    --phase2 "scripts/probes/premature-stop/results/$t"
done

# ── 花真实额度（CONFIRM=1 是强制的；不加会拒绝执行）
#    turn 2 全套变体：1199 次真实请求
KIRO_PROBE_ACCOUNT='you@example.com' CONFIRM=1 \
  bun run scripts/probes/premature-stop/turn2-variant-probe.ts \
  --capture scripts/probes/premature-stop/captured-inbound.json --n 120 --concurrency 6
#    turn 5 长任务形态：600 次
KIRO_PROBE_ACCOUNT='you@example.com' CONFIRM=1 \
  bun run scripts/probes/premature-stop/turn2-variant-probe.ts \
  --capture scripts/probes/premature-stop/captured-inbound-hop5.json --turn 5 \
  --variants V0,V9,V5,V1,V3 --n 120 --concurrency 6

# ── Phase 1 端到端 provider 对比（42 次运行；--dry 是零额度的臂身份控制）
bun run scripts/probes/ab-opencode/run-ab.ts --mode provider --dry
CONFIRM=1 KIRO_ACCOUNT_SELECTION_STRATEGY=lowest-usage \
  bun run scripts/probes/ab-opencode/run-ab.ts --mode provider --runs 14 --out /tmp/opencode/pstop/phase1
bun run scripts/probes/ab-opencode/sanitize-runs.ts --in <runsDir> --out <resultsDir>
```

`--concurrency` > 1 会遇到 `ThrottlingException` 429；探针把它们记成 `error` 并从速率分母里
剔除，不会污染速率。

---

## 9. 额度与卫生

### 真实调用量

| 批次                            | 真实 Kiro 调用 | 说明                                                   |
| ------------------------------- | -------------- | ------------------------------------------------------ |
| Phase 1 kiro 臂                 | 154            | 由 14 个 `api-*.ndjson` 里的 `type=request` 条数点出来 |
| Phase 1 myopenai + myohigh 臂   | 0              | 走 Bedrock 网关，不消耗 Kiro 额度                      |
| turn-2 pilot（n=24）            | 24             |                                                        |
| turn-2 全套变体（9 变体 × 120） | 1199           | V7 每试验 2 次调用                                     |
| turn-5 变体（5 × 120）          | 600            |                                                        |
| turn-3 / turn-4 基线            | 240            |                                                        |
| turn-5 安全性（3 × 120）        | 360            |                                                        |
| `capture-inbound.ts` × 3        | **0**          | 全程只打本地 mock                                      |
| **合计**                        | **2577**       |                                                        |

### `used_count` 的滞后，再一次确认

探针自己按每批次读了 Kiro 的 usage 接口：`68→68`（24 次调用，delta 0）、`71→201`
（1199 次，delta 130）、`205→291`（600 次，delta 86）、`294→309`（120 次，delta 15）、
`309→329`（120 次，delta 20）、`329→385`（360 次，delta 56）。**2423 次调用只让计数器涨了
约 307。** `kiro.db` 里被选中账号的 `used_count` 从 0 走到 1、另一个账号到 53。
**绝对不要拿 `used_count` 的差值当计费证据**；本表的调用数来自探针自己的计数器和 api 日志。

调查结束后额度状况：两个账号 headroom 9999 / 9947，另有 500 / 293。

### 卫生

- `kiro.db` 全程只读（`Database(..., { readonly: true })` / `mode=ro`），从未写入。
- 未改动 `~/.config/opencode/opencode.json`、`~/.omo/omo.jsonc`、`auth.json`。三条臂各自用
  独立的 `XDG_CONFIG_HOME`，并把 `kiro.db{,-wal,-shm}` 和 `kiro-auth-plugin` **软链**回真实
  目录（**不是复制**——刷新令牌是一次性的，复制会让真实库拿着已被消耗的令牌）。
  provider 对比臂里不加载插件的那两条**连账号库都不链接**。
- `myopenai` 的 API key 存放在 `XDG_DATA_HOME` 下的 `auth.json`，本次从未重定位、从未写入；
  臂配置里只复制了 provider 的非机密形状（`npm` / `baseURL` / 单个模型的 options）。
- 脱敏：Phase 1 产物经 `sanitize-runs.ts` 处理（邮箱→稳定假名 `acctN@redacted.invalid`、
  `profileArn` 保形去 id、≥100 字符的 base64url 串→`<redacted:len=N>`；本批
  `emails=154 arns=154 tokens=34`）。探针在写结果 JSON 前会自检并在发现未脱敏邮箱、
  access/refresh token、`profileArn` 时**抛异常拒绝落盘**。
- 已提交的 Phase 1 产物**刻意不包含 `stream.jsonl` / `stderr`**：42 次运行的 `stream.jsonl` 里
  `type=error` 事件数经核验全部为 **0**，且退出码都在 `meta.json` 里，因此本文每一个数字都不
  依赖它们。这是一个**声明过的裁剪衍生品**，与 `api-filtered.ndjson` 同一性质。

---

## 10. 已知局限（不要越读）

1. **只在一个 fixture 上测过。** 这个 10 跳链式账本提示词明确要求「每次读完重述整段 fold」，
   本身就在鼓励模型产出一段文本作为交付物。填充文本的效应量在别的任务上可能不同；
   **效应的存在**已经在 p < 1e-5 上确立，**16% 这个数值**不要外推。
2. **turn 2 之外没有可检出的基础率。** turn 3/4/5 都是 0/120，所以本调查只能说
   「在这个 fixture 上 turn 2 是唯一可测的失败位置」，不能说「更深的位置永远不会失败」。
   用户报告的是「长任务」，而本文测到的失败位置是第一次续跑——两者能对上的解释是：一次长
   会话里 OpenCode 会因压缩/新提示反复重建出「history 只有一对」的形态，每次都重新掷一次这
   16% 的骰子。**这一条没有直接测过，属于假设。**
3. **上游模型快照会漂移。** turn-2 的 V0 在两个独立批次里是 3/24 和 20/120（合计 16.0%），
   与先前 24 次真机的 12.5% 相符；但任何后续验证都必须**同批次跑对照**。
4. **V4（`<thinking_mode>`）虽然也把 turn 2 打到 0，但本次没有评估它的副作用**（额度、延迟、
   与 effort 映射的交互，以及 notepad Wave 0 Q4 里当初决定不加 reasoning 标志的那些理由）。
   把它当修复之前需要单独立项。
5. **捕获文件里的 system prompt 是环境依赖的。** 它含有本机的已安装 skill 清单、工作目录和
   当天日期，也就是说这段上下文本身可能影响模型行为。本次的忠实性来自「它与真机观察到症状
   的那次运行同源」（工具 schema sha256 字节相同），**不来自**它是某种中立的标准输入。
6. **`empty200` 与本缺陷无关，但它是真实存在的另一个故障**（先前的
   `cross-account-replay-probe` 里独立观察到 HTTP 200、0 帧、0 字符）。本次 2423 次试验里
   一次都没出现，所以本文对它没有任何新证据。

---

## 11. 复现验证，与修复未实施的原因

本节是**后续任务**的记录，与 §1–§10 的调查是两个批次。任务的目标是实施 §7.1 推荐的
`'[tool results]'`，并且首次测量「history 与当前消息**两处都改**」这一从未被测过的配置。
结论是：**这个取值没能复现，所以生产代码一行未改。**

### 11.1 这一批测了什么

代码侧只做了一件事：给 `turn2-variant-probe.ts` 加了一个变体 **V10 = as-implemented**——
把 `[tool results]` 同时写进**当前消息**和**history 里每一条带 `toolResults` 的用户回合**，
也就是修复落地后插件真正会发出的形状。零额度的 `DRY=1` 直接读出这个变体的作用面：

| 位置   | history 里带 toolResults 的回合数 | V10 相对 V2 |
| ------ | --------------------------------- | ----------- |
| turn 2 | **0**                             | **完全相同**（turn-2 的 history 是 `[user, assistant]`，根本没有 history 填充点） |
| turn 5 | **3**                             | 多改 3 条 history 回合（这才是新配置） |

**这一点很重要：turn 2 上 V10 与 V2 是同一个 payload。** 所以下面 turn-2 的数字既是「两处
都改」的测量，也是对 §4.1 里 V2 = 0/120 的**直接复现尝试**。

模型 / effort / region / 判定口径与 §4 完全一致（`claude-opus-5-high`、wire `claude-opus-5`、
effort `high`、us-east-1）。捕获文件当天重新生成（`systemChars=21554`，与调查当时同长度）。

### 11.2 turn 2：V0 复现了，`''` 和显式指令复现了，`'[tool results]'` 没有

同一会话、两个账号并行、误差全部从分母剔除：

| 变体                             | 本次 n | stopped | 速率      | 95% CI     | vs 本批 V0 的 Fisher p | 与 §4.1 是否复现              |
| -------------------------------- | ------ | ------- | --------- | ---------- | ---------------------- | ----------------------------- |
| **V0** 生产基线                  | 255    | 50      | **19.6%** | 15.2–24.9% | —                      | **是**（16.0% → p = 0.42）    |
| **V10** = `'[tool results]'` 两处 | 256    | **24**  | **9.4%**  | 6.4–13.6%  | **0.0011**             | **否**（0/120 → p = 0.00013） |
| V1 `content` 空串                | 128    | 0       | 0.0%      | 0.0–2.9%   | 0.0000                 | **是**（0/120）               |
| V3 显式续跑指令                  | 128    | 0       | 0.0%      | 0.0–2.9%   | 0.0000                 | **是**（0/120）               |

V10 的 24/256 来自**两个各自独立的 n=128 批次，各自恰好 12/128**（两批之间 p = 1.0）。
这不是单批噪声。

`empty200` 在全部 768 次 turn-2 试验里仍然是 **0**。

### 11.3 turn 5：两处都改是安全的，`''` 的陷阱也复现了

| 变体                              | 本次 n | stopped | 速率     | vs 本批 V0 的 Fisher p | 与 §4.3 是否复现            |
| --------------------------------- | ------ | ------- | -------- | ---------------------- | --------------------------- |
| V0 生产基线                       | 128    | 0       | 0.0%     | —                      | **是**（0/120）             |
| **V10** = `'[tool results]'` 两处 | 128    | **0**   | **0.0%** | **1.0000**             | 首次测量：**不比基线差**    |
| V1 `content` 空串                 | 128    | 10      | **7.8%** | **0.0016（更差）**     | **是**（6.7% → p = 0.81）   |
| V3 显式续跑指令                   | 128    | 0       | 0.0%     | 1.0000                 | **是**（0/119）             |

所以「两处都改」这个从未被测过的配置在长任务形态下是**安全**的——这一条如实回答了任务提出
的问题。但它在 turn 5 无法证明有效性：基线本身是 0/128，本 N 下**任何**结果（包括 0）都达不到
p < 0.05 的「下降」（analyzer 自己会打印这句话）。

### 11.4 为什么这构成「停下来」的理由，而不是「照旧发布」

四个变体里三个复现、唯独被推荐的那个不复现，这个模式排除了最省事的解释：

- **不是上游整体漂移。** 如果是模型快照整体变了，V1 与 V3 也该失效；它们都还是 0/128。
- **不是基线漂移。** V0 19.6% vs 16.0%，p = 0.42。
- **不是环境/捕获差异掩盖了效应。** 同一台机器、同一 fixture、同一批次内做对照，正是 §7.3
  第 3 步与 §10.3 要求的做法。
- **不是功效不足。** 24/256 的 CI 上界 13.6%，与 0 不相容；对自己先前的 0/120 是 p = 0.00013。

按 §7.3 第 3 步定的验收线（新字面量对**同批次**基线 p < 0.05），V10 是过线的（p = 0.0011）：
它把 19.6% 降到 9.4%，**大约减半，效应真实**。但它**没有消除**这个缺陷，而 §7.1 之所以在
`''` 和显式指令之间选它，靠的正是「turn 2 = 0%、turn 5 = 0%」这个双 0 的理由——这个理由现在
只剩一半。把 9.4% 的行为当成「已修复」发布出去，会让用户以为问题解决了。

因此：**生产代码未改动，既有测试未改动，`verify-v0.ts` 依然与生产逐字段一致**（它的
`FILLER = 'Tool results provided.'` 仍是生产值，不需要加任何「pre-fix 基线」说明）。

### 11.5 现在需要决策的是什么

| 选项                                                | turn 2       | turn 5       | 代价                                                              |
| --------------------------------------------------- | ------------ | ------------ | ----------------------------------------------------------------- |
| 保持现状                                            | 19.6%        | 0.0%         | 缺陷仍在                                                          |
| `'[tool results]'`                                  | 9.4%         | 0.0%         | 只减半，不消除；宣称「已修复」会误导                              |
| `''`                                                | 0.0%         | **7.8%**     | 两次独立批次都在长任务上引入新停止，**仍然不能用**                |
| 显式续跑指令（§4.1 V3）                             | **0.0%**     | **0.0%**     | 插件替用户向模型注入行为指令——**产品决策**，用户此前明确未要求    |
| 再找新取值                                          | 未测         | 未测         | 需要新一轮 n≥120 的二分；本批已证明「机器标签」这条思路并非必然为 0 |

`V4`（补 `<thinking_mode>` 前缀）本批未重测，其副作用仍未评估（见 §10.4）。

> ✅ **这张表在第三批里有了答案：见 §13。** 「再找新取值」那一行成立了 —— 官方值是空串，而且
> 必须**在每一个填充点上都置空**（C5），两个位置各 2×128 全 0。`''` 那一行的「仍然不能用」是对
> **只清空当前消息**这个中间态的正确判断，不是对官方形态的判断（§13.6）。

### 11.6 这一批的额度与卫生

| 批次                          | 真实 Kiro 调用 |
| ----------------------------- | -------------- |
| turn 2：V0+V10（两轮）        | 512            |
| turn 2：V3+V1                 | 256            |
| turn 5：V0+V10                | 256            |
| turn 5：V1 / V3               | 256            |
| `capture-inbound.ts` × 2      | **0**          |
| **合计**                      | **1280**       |

- 两个账号各自 pin 死（`KIRO_PROBE_ACCOUNT`），headroom 9999 / 9947，从不自动选号。
- `kiro.db` 全程只读；本批结束后库里 `used_count` 仍是 **1 / 53**，而 usage 接口读到的是
  **465 / 136**（每账号各 640 次调用，接口只涨了 78 / 83）。**`used_count` 的滞后第四次被确认，
  它不是计费证据。**
- 原始产物落在 `results/turn2-fix/`（3 个文件）与 `results/turn5-fix/`（3 个文件），刻意与
  `results/turn2..turn5/` 分开，好让 §4 那几张表的重算命令结果不变。
- 探针写盘前的自检（未脱敏邮箱 / access / refresh token / `profileArn`）全部通过。

重算本节两张表：

```bash
bun run scripts/probes/premature-stop/analyze-premature-stop.ts \
  --phase2 scripts/probes/premature-stop/results/turn2-fix
bun run scripts/probes/premature-stop/analyze-premature-stop.ts \
  --phase2 scripts/probes/premature-stop/results/turn5-fix
```

重跑（先按 §8 生成两个捕获文件；`CONFIRM=1` 强制）：

```bash
DRY=1 bun run scripts/probes/premature-stop/turn2-variant-probe.ts \
  --capture scripts/probes/premature-stop/captured-inbound.json --variants V0,V2,V10
KIRO_PROBE_ACCOUNT='you@example.com' CONFIRM=1 \
  bun run scripts/probes/premature-stop/turn2-variant-probe.ts \
  --capture scripts/probes/premature-stop/captured-inbound.json \
  --variants V0,V10 --n 128 --concurrency 6 --out <dir>
KIRO_PROBE_ACCOUNT='you@example.com' CONFIRM=1 \
  bun run scripts/probes/premature-stop/turn2-variant-probe.ts \
  --capture scripts/probes/premature-stop/captured-inbound-hop5.json --turn 5 \
  --variants V0,V10 --n 128 --concurrency 6 --out <dir>
```

### 11.7 本节不要越读

1. **没有证明 `'[tool results]'` 无效。** 它是真实的约 2 倍下降（p = 0.0011）。被推翻的是
   「它把停止率打到 0」这个更强的断言。
2. **没有解释 V2 为什么衰减。** 只知道同批次里 V1/V3 没衰减。可能的方向（上游对短标签类
   输入的处理变化、`[tool results]` 恰好落在某个模板边界上）本批都没有测。
3. **turn 5 无法回答「history 填充文本重不重要」。** 那里基线是 0，没有可下降的空间。要单独
   回答这个问题，需要先找到一个 history 填充点存在、基线又非 0 的位置。
4. **仍然只在一个 fixture 上测过**（§10.1 原样适用）。


---

## 12. 官方值调研：`userInputMessage.content` 该填什么

本节与 §13 是**第三个批次**，与 §1–§10（调查）、§11（复现）都是独立批次。这一批先做文献/源码
调研，再据此设计候选并实测。**生产代码依然一行未改**（`git diff cf4c55f..HEAD -- src/` 为空）。

### 12.1 结论先说：官方值是空串 `""`

三层一手证据，互相独立：

1. **抓取到的真实 Kiro IDE 请求体** ——
   [`caidaoli/kiro2api` `doc/req2.json` @ `f794fdb`](https://github.com/caidaoli/kiro2api/blob/f794fdb/doc/req2.json)。
   它的工具结果续跑消息就是 `currentMessage.userInputMessage.content === ""`，
   `origin: AI_EDITOR`、`chatTriggerType: MANUAL`。
   **溯源可由它自己的字节验证**：文件里有 `tooluse_fileTree`、Kiro 独有的工具名
   `listDirectory` / `fsWrite` / `openFolders`、`# Identity\nYou are Kiro` 系统提示词，以及
   `"I will follow these instructions."` —— 这些都不出现在那个代理自己的源码里，所以代理不可能
   凭空合成它。
2. **官方 `aws/amazon-q-developer-cli`（Rust），两条互不相干的代码路径** ——
   `chat-cli` 的 `UserMessage::new_tool_use_results`（`prompt()` → `None`，无时间戳、无附加
   上下文 ⇒ `content == ""`）；以及更新的 `rts` 后端里 `Message::text()` 只过 `ContentBlock::Text`，
   于是一条只带工具结果的消息序列化出来就是 `""`。
3. **八个互相独立的三方实现都收敛到 `""`**（kiro2api、kirocc、kiro.rs、Kiro-account-manager、
   kiro-anthropic、Kiro-Go 等，fork 血缘已去重）。三方 9router PR #2183 还跑过一次单变量
   A/B：`""` 回答正确，`"continue"` 退化，`"."` 被当成用户提示词读。

**本插件的 `'Tool results provided.'` 在整个生态里是独一份 —— 没有别人用一个句子。**

### 12.2 官方客户端有、而本插件没有的两条结构性规则

- **Kiro IDE 会在真实对话前面插一对合成的「预热」回合**（`req2.json` 的 `history[0..3]`）：

  ```
  [0] user      "# Identity\nYou are Kiro…"                       (14143 字符，Kiro 自己的系统提示词)
  [1] assistant content=""  + toolUses=[listDirectory, id=tooluse_fileTree]
  [2] user      "You are operating in a workspace…<fileTree>…"     (1112 字符)
                + toolResults=[{tooluse_fileTree, success, "I will list the files in current directory."}]
  [3] assistant "I will follow these instructions."
  ```

  `d-kuro/kirocc` 复刻了这个形态。注意一个常见误读：这对回合里带 `toolResults` 的那条用户
  消息**内容并不短**（1112 字符的工作区上下文）；真正为空的是**助手**回合的 `content` 和
  **当前**消息的 `content`。
- **Q CLI 有一条条件规则**：当工具结果回合会成为历史里的第一条、或前一条助手回合不是
  `tool_use` 时，它把工具结果**文本搬进 `content`**（`replace_content_with_tool_use_results`，
  注释写的是 _"This is required to avoid validation errors."_），该路径的空内容兜底值是
  `"<tool result redacted>"`。
- **Q CLI 在「工具结果 + 图片」这条路上会发一个真正非空的 content**：一个时间戳上下文块

  ```
  --- CONTEXT ENTRY BEGIN ---
  Current time: <RFC3339 本地时间>
  --- CONTEXT ENTRY END ---
  ```

### 12.3 顺手结掉的一处生态争议（不要再测）

`TsinHzl/kiro2cc-proxy` 断言后端拒绝空内容。**我们自己的数据已经否证它**：§4.1 与 §11.2 的
`V1` 合计 248 次 turn-2 空内容续跑全部成功（本批又加了 30 次 + C5 的 512 次）。空内容**是**被
接受的。这条记录在案，不要重测。

---

## 13. 两阶段候选筛选：唯一存活者是「所有填充点都置空」

### 13.1 候选与设计

每个变体都由**真实** `transformToSdkRequest` 生成 V0，再只改预期的那一个元素（`verify-v0.ts`
立下的规矩；本批当天重跑 `verify-v0.ts`，V0 在每个可比字段上仍与生产一致）。

| 候选    | 改了什么                                                                   | 相对谁只差一处 |
| ------- | -------------------------------------------------------------------------- | -------------- |
| **C1**  | `''`（当前消息）**+** Kiro 预热回合前插到 history                          | V1             |
| **C1b** | `''` **+** 预热回合，且按真实客户端的**完整回合布局**（系统提示词单独成 history[0]，用户提示词跟在预热之后） | V1 |
| **C2**  | `''` **+** 撤销 `collapseAgenticLoops`                                     | V1             |
| **C3**  | Q CLI 时间戳上下文块（真实本地 RFC3339），当前消息与 history 填充点都用    | V0             |
| **C4**  | `'(tool result above)'`（TsinHzl），两处都用                                | V0             |
| **C5**  | **`''`，每一个工具结果填充点都置空**（当前消息 + history）                  | V1             |
| V0 / V1 | 同批次对照：生产基线 / 只把**当前消息**置空                                | —              |

**C5 是本批新增的候选，不在任务列的四个里，但它是必须加的**：`V1` 只清空当前消息，而一个
原生发送官方值的客户端在历史里也是 `""`（今天的当前消息就是明天的历史条目）。不测 C5 就无法
判断 §11 那个「turn 5 空串陷阱」到底是空串的性质，还是「当前消息空 + 历史里还在说整句英文」
这个**混搭**的性质。C1b 同理，是解释 C1 所必需的对照（C1 只前插预热对、不动 `history[0]`；
C1b 复刻真实布局但因此带上了 §5.2 已知更差的「系统提示词单独成回合」这个混淆项）。

**两处刻意声明的偏离**（免得被当成逐字复刻）：

1. 预热回合 `[0]` 的内容截断成 identity 首行。原文那 14143 字符是 Kiro **自己的**系统提示词，
   而且它指示模型去调 `listDirectory` / `fsWrite` / `openFolders` —— 本请求根本没暴露这些
   工具。逐字回放等于注入第二份互相竞争的 agent 规范（混淆项），还要给**每一个**请求加约 14 kB
   （成本）。`[1]`–`[3]` 除 `<fileTree>` 内容换成本探针真实的 fixture 工作区外都是逐字转写。
2. C3 的时间戳是每次试验取一次真实本地时间，所以该变体的 content 逐试验不同（与官方客户端
   一致）。

**C1 的额外成本**（`DRY=1` 直接读出）：turn 2 的 `conversationState` 从 51353 字节涨到 52582
字节，**+1229 字节 ≈ +307 token**；C1b 是 +1148 字节 ≈ +287 token。这是**每个请求**都要付的。
C3 在 turn 5 是 +308 字节（三个 history 填充点 + 当前消息各一份时间戳块），C4/C5 分别是
−12 / −88 字节。

**degenerate 关系，由 `DRY=1` 的字节数直接证明，因此不重复花额度**：turn 2 上 C5 与 V1 的
payload **字节相同**（都是 51331 字节、content `""`、history 里 0 个工具结果填充点），C2 在
turn 2 也退化成 V1（`pairCount > 1` 才折叠）。所以 Stage 1 的 turn 2 不跑 C2/C5，用同批次的
V1 代表；Stage 2 仍然给 C5 单独跑满 turn 2 的 2×128，不靠这条等价性省事。

### 13.2 判定规则与功效（先声明，再看数）

- **Stage 1 筛选：n = 30 / 候选 / 位置，出现任何一次提前停止即淘汰。** 真实率为 0 时期望计数
  为 0；真实率 9.4% 时被抓到的概率 `1 − 0.906^30 = 94.7%`，16% 时 `1 − 0.84^30 = 99.5%`。
- **同批次对照**：V0 n=64（turn 2 必须落在既有的 10–25% 区间，turn 5 必须≈0），turn 5 再加
  V1 n=64（必须复现约 7–8% 的陷阱）。**任一对照失灵则该批次作废。**
  > 对照的 N 相对任务书的 n=30 上调过：turn-5 的 V1 若只跑 30 次，在真实率 7.8% 下有
  > `0.922^30 = 9%` 的概率一次都不中，那这个「灵敏度对照」就形同虚设；n=64 时漏检概率降到
  > 0.6%。为此给探针加了 `--n-for NAME=N`，让对照能带着更大的 N **留在同一批次里**。
- **Stage 2 确认：存活者 n = 128 × 两个互相独立的批次 / 位置，两批都必须是 0。** 这正是当初
  抓出 `'[tool results]'` 假阳性的那道纪律，没有缩水。两批之间同时换了账号与时间窗。

### 13.3 Stage 1 —— 四个候选里三个当场淘汰

turn 2（`results/screen-turn2/`，对照 **V0 = 12/64 = 18.8%，落在既有区间内 → 批次有效**）：

| 变体      | n   | stopped | 速率      | 95% CI     | vs 本批 V0 的 Fisher p | 判定                        |
| --------- | --- | ------- | --------- | ---------- | ---------------------- | --------------------------- |
| V0 基线   | 64  | 12      | 18.8%     | 11.1–30.0% | —                      | 对照有效                    |
| V1 对照   | 30  | 0       | 0.0%      | 0.0–11.4%  | 0.0083                 | 复现                        |
| **C1**    | 30  | 0       | 0.0%      | 0.0–11.4%  | 0.0083                 | 过筛                        |
| **C1b**   | 30  | 0       | 0.0%      | 0.0–11.4%  | 0.0083                 | 过筛                        |
| **C3**    | 30  | **11**  | **36.7%** | 21.9–54.5% | 0.0742                 | **淘汰（比生产基线还差）**  |
| **C4**    | 30  | 0       | 0.0%      | 0.0–11.4%  | 0.0083                 | 过筛（但见 §13.5 的冒烟记录） |

turn 5（`results/screen-turn5/`，两批合并；对照 **V0 = 0/128、V1 = 7/128 = 5.5%（p = 0.0144）
→ 批次能测到陷阱，有效**）：

| 变体    | n   | stopped | 速率      | 95% CI    | vs 本批 V0 的 Fisher p | 判定                |
| ------- | --- | ------- | --------- | --------- | ---------------------- | ------------------- |
| V0 基线 | 128 | 0       | 0.0%      | 0.0–2.9%  | —                      | 对照有效            |
| V1 对照 | 128 | 7       | 5.5%      | 2.7–10.9% | 0.0144（更差）         | **陷阱第三次复现**  |
| **C1**  | 30  | **1**   | 3.3%      | 0.6–16.7% | 0.1899                 | **淘汰**            |
| **C1b** | 30  | **3**   | **10.0%** | 3.5–25.6% | 0.0063                 | **淘汰**            |
| **C2**  | 53  | **4**   | **7.5%**  | 3.0–17.9% | 0.0068                 | **淘汰**            |
| **C3**  | 30  | **1**   | 3.3%      | 0.6–16.7% | 0.1899                 | **淘汰**（turn 2 已淘汰） |
| **C4**  | 30  | 0       | 0.0%      | 0.0–11.4% | 1.0000                 | 过筛                |
| **C5**  | 30  | 0       | 0.0%      | 0.0–11.4% | 1.0000                 | 过筛                |

**所以「预热回合」这条最被看好的假设被否证了**：C1 与 C1b 都在 turn 5 掉了。前插一对示范
性的工具结果回合**不能**救回空串在长任务上的不稳定。C2 也否证了「空串 × 撤销折叠」这个
从未被测过的交互 —— 撤销折叠在 turn 5 单独看是 0/120（§4.3 的 V9），配上空串仍然是 7.5%。

### 13.4 Stage 2 —— 唯一存活者 C5，两个位置各 2×128 全 0

turn 2（`results/confirm-turn2/`，两批：账号 A 然后账号 B）：

| 变体   | 批 1     | 批 2     | 合计    | 速率     | 95% CI    | vs 本批 V0 的 Fisher p |
| ------ | -------- | -------- | ------- | -------- | --------- | ---------------------- |
| V0     | 16/64    | 13/64    | 29/128  | 22.7%    | 16.3–30.6% | —                     |
| **C5** | **0/128** | **0/128** | **0/256** | **0.0%** | 0.0–1.5% | **0.0000**            |
| C4     | 2/128    | —        | 2/128   | 1.6%     | 0.4–5.5%  | 0.0000                |

**C4 在这里死掉**：2/128。它确实是一个真实的大幅下降（22.7% → 1.6%，p < 1e-4），但按预先声明
的「出现任何一次停止即淘汰」它不过关 —— 而这正是 §11 的教训：只减半的东西不能叫修好。

turn 5（`results/confirm-turn5/`，两批：账号 B 然后账号 A）：

| 变体   | 批 1     | 批 2     | 合计    | 速率     | 95% CI    | vs V0 的 p | vs V1 的 p |
| ------ | -------- | -------- | ------- | -------- | --------- | ---------- | ---------- |
| V0     | 0/64     | **1/64** | 1/128   | 0.8%     | 0.1–4.3%  | —          | 0.0027     |
| V1     | 3/64     | 9/64     | 12/128  | **9.4%** | 5.4–15.7% | 0.0027（更差） | —      |
| **C5** | **0/128** | **0/128** | **0/256** | **0.0%** | 0.0–1.5% | 0.3333（不更差） | **0.0000** |
| C4     | 0/128    | —        | 0/128   | 0.0%     | 0.0–2.9%  | 1.0000     | 0.0004     |

`empty200` 在本批全部 1922 次试验里仍然是 **0**。全部批次错误数为 0，唯一的例外是 §13.5 记的
那个令牌过期批次。

**顺手记一条以前没见过的观察：turn-5 的生产基线不是严格的 0。** 本批 4 个 V0 格子合计
1/256（另加历史 248 次全 0，即累计 1/504）。这不改变任何结论（它让「C5 在 turn 5 不更差」这句话
更弱而不是更强），但以后不要再把「turn 5 = 0%」当成硬事实来引用。

### 13.5 必须如实记下的两件事

1. **C4 在正式批次之前的冒烟里停过一次。** 为了在花掉整批额度之前排掉 400
   ValidationException，先给每个新变体在两个位置各跑了 n=2（共 16 次真实调用，产物写在
   `/tmp`，未提交）。那一轮 turn 2 上 C4 是 **1/2**、C3 是 1/2。冒烟没有同批次对照、N=2，
   按预先声明的规则它不参与判定；但 C4 用自己的 payload 造成过一次提前停止这个**观察是真实
   的**，而且与它后来 Stage 2 的 2/128 一致。合并起来 C4 的 turn-2 记录是 **3/160**。
   **C4 不干净。**
2. **turn-5 Stage 1 的第一批中途令牌过期。** 该批 C3/C4/C5 三格各 30 次全部返回
   `403 AccessDeniedException: The bearer token included in the request is invalid.`，C2 有 7 次
   命中同样错误。探针把 403 记为 `error` 并从速率分母里剔除（这正是分母口径的用途），所以
   该批 V0/V1/C1/C1b 的数字有效、C2 的 23 次有效，而 C3/C4/C5 在 turn 5 是**未测**。补跑成第二
   批（`results/screen-turn5/` 里的第二个文件），带上自己整套 V0 n=64 + V1 n=64 对照。探针只在
   启动时检查过期时间，长批次会撞上这个坑 —— 记下来。

### 13.6 与「官方用 `""`，我们却测到 7.8%」这个矛盾的正面和解

这是本批最重要的一句话，必须写清楚：

> **矛盾是假的，因为 `V1` 从来不是官方形态。** `V1` 只清空**当前消息**，把 history 里那三条
> 带工具结果的用户回合留成 `'Tool results provided.'` 这句完整的英文陈述句。一个原生发送官方值的
> 客户端在 history 里也是 `""` —— 今天的当前消息就是明天的历史条目。**turn 5 那个陷阱不是空串
> 的性质，而是「混搭」的性质**：当前回合一言不发，紧挨着的同类历史回合却在说人话，这种自相
> 矛盾的上下文才是不稳定的来源。

同批次数据直接支持这个解释，而且是本批里最干净的一组对比：

| turn 5，同两个批次内 | 当前消息 | history 填充点          | stopped   |
| -------------------- | -------- | ----------------------- | --------- |
| V0                   | 句子     | 句子                    | 1/128     |
| **V1**               | **空**   | **句子（不一致）**      | **12/128 = 9.4%** |
| **C5**               | **空**   | **空（一致，= 官方形态）** | **0/256** |

`C5` vs `V1`：**p < 1e-4**（`--baseline V1` 可重算）。也就是说 §11 那条「`''` 是陷阱、不能用」的
结论**在它自己的测量范围内仍然正确**，但它测的是一个**没有任何客户端会发出的中间态**。把
一致性补上，陷阱就消失了。

这同时解释了另外三个此前无法解释的现象，因此这不是一个只为救结论而编的说法：

- **C3 在 turn 2 反而更差（36.7%）**：时间戳上下文块是一段结构化的机器文本，出现在「用户」
  这一侧。它与 §5.1 的机制、与 V8（系统提示词单独成回合，34.2%）、与 V5（把助手可见文本换成
  合成占位符，95.0%）同向 —— 在用户回合里塞一段不像自然对话的内容会让 turn 2 更不稳。
  Q CLI 能用它，是因为 Q CLI 的整段上下文都是自洽的；抄一个片段过来不是。
- **`'[tool results]'`（§11）只减半**：短机器标签是「说了点什么但不像话」的中间态，正好落在
  「一致的句子」和「一致的空」之间。
- **C1/C1b 失败**：光靠前面示范一次，压不过后面每一条历史回合都在说整句英文这个更近、更强的
  反例。

### 13.7 修复提案（本任务**不实现**）

**唯一改动点：把两个填充点都改成空串**，也就是 C5。

| 文件                                                     | 行  | 现状                                                                        | 改成                                                     |
| -------------------------------------------------------- | --- | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| `src/infrastructure/transformers/history-builder.ts`     | 155 | `content: 'Tool results provided.',`                                        | `content: '',`                                           |
| `src/plugin/request.ts`                                  | 184 | `curContent = curTrs.length ? 'Tool results provided.' : '[system: conversation continues]'` | `if (!curContent && !curTrs.length) curContent = '[system: conversation continues]'` |

`request.ts` 那一行的写法要注意：现在是 `if (!curContent) curContent = curTrs.length ? A : B`。
正确的改法是**把有工具结果的那一支整个去掉**（让 content 保持空），而不是给它赋一个 `''`——
两者行为相同，但前者读起来就是「有工具结果时不填任何东西」。**`else` 分支
（`'[system: conversation continues]'`，无工具结果的助手续跑）本次实验完全没有覆盖，不要一起改**
（§7.2 的同一条约束依然成立）。

**关于 `AGENTS.md` §6「AWS 字面量集中到 `src/constants.ts`」：建议这次不要加常量。** 空串不是
AWS 期望的 wire 值，它是「不放填充文本」这件事本身；给它起个名字（`TOOL_RESULT_FILLER = ''`）
只会让人以为存在一个可替换的取值。两处各加一行注释指向本文 §13 更诚实。同理，
`'Tool results provided.'` 从来不在 `AGENTS.md` 的冻结清单里（它是本插件为填满必填字段自造的），
所以这个改动是允许的 —— 这一点 §7.2 已经论证过，不变。

**需要有意更新的既有测试（唯一允许改测试的理由，且必须是「跟随实现改期望值」）：**

| 位置                                       | 性质                                                          | 处理                              |
| ------------------------------------------ | ------------------------------------------------------------- | --------------------------------- |
| `src/__tests__/history-builder.test.ts:100` | **真断言**：`expect(toolTurn?.content).toBe('Tool results provided.')` | 改成 `toBe('')`                   |
| `src/__tests__/history-builder.test.ts:152` | 输入 fixture（`collapseAgenticLoops` 的入参），不断言填充文本  | 可不改；若为保持真实性一并改，属纯 cosmetic |
| `src/__tests__/message-transformer.test.ts:202` | 输入 fixture（`sanitizeHistory` 的入参），不断言填充文本   | 同上                              |

**已经查过、可以放心的一点**：没有任何清洗逻辑会因为 `content` 为空而丢掉一条
`userInputMessage`。`history-builder.ts:165` 与 `request.ts:123/138` 的真值判断都只作用在
`assistantResponseMessage` 上，`sanitizeHistory`（`message-transformer.ts:15/18/30`）只看
`userInputMessageContext.toolResults`。所以 history 里的 `content: ''` 是安全的。

**验证顺序**（沿用 §7.3，加一条）：

1. 单元层：断言两条路径产出的 `content` 都是 `''`，且 `toolResults` / `tools` / `toolUseId` /
   history 角色顺序完全不变；
2. 翻译层（零额度）：重跑 `verify-v0.ts`。**注意它的 `FILLER` 常量必须继续保持生产值
   `'Tool results provided.'`** —— 它记录的是修复前基线；修复落地后这一步会显示
   `currentMessage.content` 一项不一致，**那正是预期结果**，用来证明改动的作用面只有这一个字段；
3. 真机层：`--turn 2 --variants V0,C5 --n 128` **两个独立批次**，要求两批都是 0 且对同批次 V0
   有 p < 0.05；
4. 真机层安全性：`--turn 5 --variants V0,V1,C5 --n 128` 两个独立批次，要求 C5 不显著差于 V0，
   且**同批次的 V1 仍能测出约 5–14% 的陷阱**（这是灵敏度对照，不能省）;
5. 端到端 `run-ab.ts` 仅作补充证据，功效不足以当验收门槛（§3）。

### 13.8 重算与重跑命令

```bash
# ── 零额度：从已提交的原始产物重算 §13 的四张表
for d in screen-turn2 screen-turn5 confirm-turn2 confirm-turn5; do
  bun run scripts/probes/premature-stop/analyze-premature-stop.ts \
    --phase2 "scripts/probes/premature-stop/results/$d"
done
# §13.6 那张对比表里的 C5-vs-V1 需要换基线
bun run scripts/probes/premature-stop/analyze-premature-stop.ts \
  --phase2 scripts/probes/premature-stop/results/confirm-turn5 --baseline V1

# ── 零额度：看每个候选到底改了什么、以及各自的字节成本
DRY=1 bun run scripts/probes/premature-stop/turn2-variant-probe.ts \
  --capture scripts/probes/premature-stop/captured-inbound.json \
  --variants V0,V1,C1,C1b,C3,C4,C5
DRY=1 bun run scripts/probes/premature-stop/turn2-variant-probe.ts \
  --capture scripts/probes/premature-stop/captured-inbound-hop5.json --turn 5 \
  --variants V0,V1,C1,C1b,C2,C3,C4,C5

# ── 花真实额度（先按 §8 生成两个捕获文件；CONFIRM=1 强制）
#    Stage 1 筛选：候选 n=30，对照带更大的 N 留在同批次里
KIRO_PROBE_ACCOUNT='you@example.com' CONFIRM=1 \
  bun run scripts/probes/premature-stop/turn2-variant-probe.ts \
  --capture scripts/probes/premature-stop/captured-inbound.json \
  --variants V0,V1,C1,C1b,C3,C4 --n 30 --n-for V0=64 --concurrency 6 --out <dir>
KIRO_PROBE_ACCOUNT='you@example.com' CONFIRM=1 \
  bun run scripts/probes/premature-stop/turn2-variant-probe.ts \
  --capture scripts/probes/premature-stop/captured-inbound-hop5.json --turn 5 \
  --variants V0,V1,C2,C3,C4,C5 --n 30 --n-for V0=64,V1=64 --concurrency 6 --out <dir>
#    Stage 2 确认：每个位置跑两遍下面这条，换账号、换时间窗
KIRO_PROBE_ACCOUNT='you@example.com' CONFIRM=1 \
  bun run scripts/probes/premature-stop/turn2-variant-probe.ts \
  --capture scripts/probes/premature-stop/captured-inbound.json \
  --variants V0,C5 --n 128 --n-for V0=64 --concurrency 6 --out <dir>
KIRO_PROBE_ACCOUNT='you@example.com' CONFIRM=1 \
  bun run scripts/probes/premature-stop/turn2-variant-probe.ts \
  --capture scripts/probes/premature-stop/captured-inbound-hop5.json --turn 5 \
  --variants V0,V1,C5 --n 128 --n-for V0=64,V1=64 --concurrency 6 --out <dir>
```

### 13.9 本批的额度与卫生

| 批次                                          | 真实 Kiro 调用 |
| --------------------------------------------- | -------------- |
| Stage 1 turn 2（`screen-turn2/`）             | 214            |
| Stage 1 turn 5 第一批（令牌中途过期）         | 308            |
| Stage 1 turn 5 补跑（`screen-turn5/` 第二个文件） | 248         |
| Stage 2 turn 2 批 1 / 批 2                    | 320 / 192      |
| Stage 2 turn 5 批 1 / 批 2                    | 384 / 256      |
| 已提交批次小计                                | **1922**       |
| 冒烟（n=2 × 8 格，产物在 `/tmp`，未提交）     | 16             |
| 一次参数写错后立刻掐掉的启动（未落盘）        | 约 26（估计值，日志已被覆盖，无法精确点数） |
| `capture-inbound.ts` × 2、`verify-v0.ts` × 1  | **0**          |
| **合计**                                      | **约 1964**    |

- 四个有余量的账号（headroom 9999 / 9947 / 500 / 293）全部**显式 pin 死**
  （`KIRO_PROBE_ACCOUNT`），从不自动选号；探针的 headroom 拒绝与 `CONFIRM=1` 守卫都保留。
  实际只用了 headroom 最大的两个。
- `kiro.db` 全程只读（`Database(..., { readonly: true })`）。本批结束后库里 `used_count`
  仍是 **1 / 53**，而 usage 接口在同期涨了约 214（约 1738 次已计数的调用）。
  **`used_count` 滞后第五次确认，它不是计费证据**；本表的调用数来自探针自己的计数器。
- 令牌刷新由正常的 OpenCode/插件路径完成，探针从不写 `kiro.db`、从不调刷新端点
  （刷新令牌是一次性的）。
- 探针写盘前的自检（未脱敏邮箱 / access token / refresh token / `profileArn`）在全部 7 个
  结果文件上通过。
- 原始产物刻意落在**新的**四个子目录（`screen-turn2/`、`screen-turn5/`、`confirm-turn2/`、
  `confirm-turn5/`），好让 §4 与 §11 那几张表的重算命令结果一个字都不变。

### 13.10 本节不要越读

1. **没有证明 C5 是 0%。** 证明的是「在 turn 2 与 turn 5 各 2×128 次里一次都没出现」，
   turn 2 的 95% 上界是 **1.5%**。turn 5 的 V0 自己是 1/128，所以那一侧只能读作**安全性**证据，
   不是有效性证据（analyzer 自己会打印这句话）。
2. **`C4` 没有被证明无效。** 它是真实的 22.7% → 1.6%。被否掉的是「它能清零」这个更强的断言。
3. **`C1`/`C1b` 的失败不等于「预热回合无用」。** 它只说明：在**只改这一处**、且 history 里
   仍留着不一致的句子填充文本时，预热回合救不回来。预热回合 + C5 的组合本批**没测**。
4. **§13.6 的机制解释是解释，不是被单独实验过的命题。** 直接被测到的是那张三行表和
   `C5` vs `V1` 的 p 值；「不一致的上下文才是病根」是对它、以及对 C3/V5/V8/`[tool results]`
   四个已有观察的**最简自洽解释**，不是一条独立结论。
5. **仍然只在一个 fixture 上测过**（§10.1 原样适用），而且 C1 的成本数字（+1229 字节）是这个
   fixture 的，别外推。

---

## 14. 已实施的修复

修复已按 §13.7 的 C5 方案落地：`src/infrastructure/transformers/history-builder.ts` 生成历史
工具结果回合时把 `userInputMessage.content` 设为 `''`；`src/plugin/request.ts` 仅在当前消息既没有
文本、也没有工具结果时才保留原有的 `'[system: conversation continues]'`。因此当前工具结果消息
保持 `''`，历史与当前两个位置始终一致。没有增加可配置常量，也没有改动
`'[system: tool calling continues]'`、回合结构、`collapseAgenticLoops` 或任何 reasoning-signature 路径。

实施依据仍是同批次 C5 结果：turn 2 从 V0 的 **29/128 = 22.7%** 降到 **0/256**
（95% CI 0.0–1.5%，p < 1e-4），turn 5 为 **0/256**，相对 V0 的 1/128 只能表述为
「不更差」（p = 0.33）。合并两个位置，C5 是 **0/512**，但这不等价于证明真实率为零。

§11 的 V1 结果也据此完成和解：V1 从来不是官方形态，它只清空当前消息，却让历史里的同类回合
继续携带英文句子，形成 turn 5 的混合状态（12/128 = 9.4%）；C5 同时清空两处后是 0/256，
C5 vs V1 p < 1e-4。真实 Kiro IDE、官方 `aws/amazon-q-developer-cli` 以及去重后的八个三方实现
发送的都是一致的空内容。

回归覆盖同时锁定了历史位置、当前位置、两处一致性、无工具结果时原占位符不变，以及
`sanitizeHistory` 不会按 `content` 真值删除有效工具结果。`injectSystemPrompt` 的系统提示词仍附加到
工具循环之前的首个真实用户回合；空工具结果回合保持不变。现存另外两处旧句子
（`history-builder.test.ts` 的折叠入参、`message-transformer.test.ts` 的清洗入参）是入站 fixture，
不是插件输出，因此有意保留。

C5 调研、原始产物与实施方案的真实证据提交是 **`0fd3c1e`**；本节所在提交是实际修复提交，
其 SHA 由提交对象创建后确定，可用 `git log -1 --format=%H` 读取。

本修复的精确边界是：移除工具循环续跑时由填充句子诱发的提前停止。它不声称消除所有提前停止，
不处理独立的「HTTP 200 但 0 frame / 0 char」失败，也不属于 reasoning-signature 修复。

---

## 15. 官方客户端行为的一手证据补录

本节记录一批**新获得的一手证据**：一次独立的并行调查抓到了真实官方客户端（Kiro CLI 2.12.0
与 Kiro IDE）的实时报文，本文作者已逐条亲自复核后才收录。本节**不改动任何生产代码、测试或
探针脚本**，也不消耗任何真实额度。

原始捕获产物位于 `/tmp/kiro-content-capture-20260730/`（CLI `tracing` 日志，约 15 MB）与
`/tmp/kiro-ide-request-capture-20260730/`（IDE 请求体）。**这两个目录刻意不入库**：其中含有
可识别组织的 SSO start URL、会话与会话轮次 UUID、用户的真实提问、绝对工作目录路径，以及本仓库
`AGENTS.md` 被作为上下文内联的全文。下文引用一律只给路径与描述，摘录也只取短片段并对
SSO start URL、所有 session/conversation UUID、tool-use id、绝对路径与账号标识做 `<redacted>` 脱敏。

### 15.1 Smithy 模型本身允许空串——这不是「传输层必须填点什么」

`node_modules/@aws/codewhisperer-streaming-client/dist-types/models/models_0.d.ts` 的
`interface UserInputMessage`：

```ts
export interface UserInputMessage {
    /**
     * The content of the chat message.
     */
    content: string | undefined;
    userInputMessageContext?: UserInputMessageContext | undefined;
    ...
}
```

`content` 是**必填字段**（没有 `?`），类型是 `string`，**没有非空约束**。所以 `""` 是一个
类型合法、模型合法的取值。这直接否掉了旧表述赖以成立的「我们必须往里放点东西」的前提，
同时说明：`toolResults` 才是工具输出的正式通道，`content` 是用户**话语**通道。往话语通道里塞
一句英文陈述句，等于给了模型可以真实回应的用户语义——这正是 §4/§5 测到的机制。

### 15.2 Kiro CLI 2.12.0 实时 trace：工具结果续跑发的是 `content: ""`

一次真实 `chat_cli_v2` 会话的 15 MB `tracing` 日志。在续跑处，trace 摘录：

```
chat_cli_v2::api_client: Sending conversation: ConversationState {
    conversation_id: Some("<redacted>"),
    user_input_message: UserInputMessage {
        content: "",
```

它紧跟在
`AgentLoopEvent { kind: LoopStateChange { from: PendingToolUseResults, to: SendingRequest } }` 之后。

**本条证据最强的形态（由本文作者自行建立）：** 整份 trace 里 `content: "",` 出现 **2** 次，
`from: PendingToolUseResults, to: SendingRequest` 出现 **2** 次——**1:1 对应**，即该会话中
*每一次*工具结果续跑都发了空串。而字符串 `Tool results provided` 在整个 15 MB 里出现 **0** 次。
这两个计数才是把单点观察变成规律的关键。

### 15.3 Kiro IDE：`""` 会随回合沉入历史并保持为空

同一次 IDE 会话中相隔 16 秒的两份捕获请求体，均由本文作者亲自解析：

| 捕获 | history 中携带 `toolResults` 的回合 | 当前消息 |
| --- | --- | --- |
| 第一份 | 无 | `content=''`，1 个 toolResult，29 个工具 |
| 第二份（+16s） | **1 个，且其 `content` 仍为 `''`** | `content=''`，1 个 toolResult，29 个工具 |

这是决定性的一条：它证明真实客户端在该回合**沉入历史之后**依然保持空值，而不只是在当前回合
为空。这就是对本项目两处修复（§13.7 / §14）所依据推理的一手确认——*今天的当前消息就是明天的
历史条目*——此前我们只是推断。另外注意 IDE 每次续跑都会重发完整的 29 个工具列表。

### 15.4 这解释了为什么 C3 候选反而比基线更差

§13.3 里把 Q CLI 的时间戳 `--- CONTEXT ENTRY BEGIN/END ---` 块当作工具结果填充值来测，得到
**36.7%（11/30）**，比生产基线更差，当时无法解释。

CLI 捕获给出了答案：那个块是 CLI 的**用户回合**格式。其开场请求的 `content` 是：

```
--- CONTEXT ENTRY BEGIN ---
Current time: <RFC3339 local time>
--- CONTEXT ENTRY END ---

--- USER MESSAGE BEGIN ---
<the user's actual prompt>
--- USER MESSAGE END ---
```

我们把一个*用户话语包装器*放进了*工具结果*槽位——模型当然会读成「用户在说话」。记下这一点，
整套结果就自洽了，而不是留着一个 36.7% 的离群值无法解释。

### 15.5 V6 的零结果与真实客户端相容

真实 CLI 请求**确实**携带 `agent_continuation_id`。而我们测过加上
`agentTaskType` / `agentContinuationId`（V6）没有效应（p = 0.63）。所以「官方客户端会用这些字段」
与「这些字段不是本症状的驱动因素」两件事同时为真，互不矛盾。

### 15.6 上游迁移信号——仅备案，当前不做任何动作

同一份 trace 里：`runtime.us-east-1.kiro.dev` 出现 **29** 次，`q.us-east-1.amazonaws.com` 出现
**24** 次；操作名仍是 `GenerateAssistantResponse`（**334** 次），`SendMessage` 从未出现（**0** 次）。
即官方 CLI 正在迁往新主机，但操作不变。这对今天没有任何影响——本插件冻结的
`q.{region}.amazonaws.com` 仍然可用——但值得留档。

### 15.7 必须如实声明的局限

并行调查给出的**因果**数字（22.7% / 9.4% / 0/256）**就是本文自己的测量结果**——它引用的是本文
`PREMATURE-STOP-INVESTIGATION.md`。所以这**不是对因果性的独立复现**；因果结论仍然只建立在本项目
那一轮测量之上（该轮确有同批次对照，且每个格子做了两批次复现）。真正独立、真正新增的贡献是
§15.1–§15.6 的**官方行为**证据。这两本账必须分开记，并且明确说出来——不要让本文读起来像是
因果发现被独立复现过。

同时记录：两次调查**各自独立地收敛到了同一个根因、同一个取值、同一对责任点**
（`src/plugin/request.ts` 的当前消息构造与
`src/infrastructure/transformers/history-builder.ts` 的历史重建）；并行调查也独立地指出
「只改一处会造成更危险的跨回合协议不一致」——这与本文测到的 9.4% 混合状态结果一致。

### 15.8 仍然敞开的问题

深层回合的混合状态效应究竟主要由**新近性（recency）**、**累积剂量（cumulative dose）**还是
**一致性（consistency）**驱动，两次调查都没有解决。这不阻塞任何事情，因为已落地的修复直接消除了
混合状态本身。记作**敞开的问题**，而不是修复的缺口。
