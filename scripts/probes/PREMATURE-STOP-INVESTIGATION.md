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

> ⚠️ 本节写于调查当时。**其推荐取值已被 §11 的复现推翻，请连同 §11 一起读。**

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

