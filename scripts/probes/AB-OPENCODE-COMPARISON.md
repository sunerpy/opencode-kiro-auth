# OpenCode 端到端 A/B 对比：推理签名回放到底改变了什么

> 这份文档可以独立阅读。它不假设你读过 `plan`、`learnings.md` 或任何 wave 记录。
> **本实验不涉及发版**，也没有修改任何插件生产代码。

---

## 0. 一句话结论（先看这个）

| 问题                                                         | 答案                                                                                                                                                                                            | 置信度 |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 你报告的症状（"说了下一步就停住、不发工具调用"）真实存在吗？ | **是。** 24 次真机运行（10 跳条件 16 次 + 20 跳条件 8 次）里复现了 **3 次**，全部落在 10 跳条件里；末条消息字面写着 `hop 1: step01 -> seed 7 -> 7` / `Next: step07` 然后 `finish_reason=stop`。 | 高     |
| 修复后的插件在真机上确实把带签名的推理回放到了线上吗？       | **是。** NEW 臂的出站请求里有 `historyReasoning` 条目（20 跳条件下最多 18/21 个请求、66 个签名信封）；OLD 臂**结构上不可能**有（那段代码不存在）。                                              | 高     |
| 修复把"提前停止"的发生率降下来了吗？                         | **在本任务规模下：没有可测量的改善。** 10 跳条件 OLD 2/8 停止、NEW 1/8 停止，双侧 Fisher 精确检验 **p = 1.0**。20 跳条件两臂各 4/4 全部完成，**0 次**停止。这是噪声，不是效应。                 | 高     |
| "提前停止"是推理坍缩（attention drift）造成的吗？            | **本实验的证据不支持这个解释。** 3 次停止全部发生在**第 2 轮**，而此时上一轮的推理量是 0（一次是 162 字符），也就是说**根本还没有推理可以丢**，签名回放没有任何东西可以保护。                   | 中高   |
| 那修复到底带来了什么可见的好处？                             | **一个探索性信号**：20 跳条件下 NEW 臂在正确率同为 4/4 的前提下，新产生的推理少 62%（p=0.029）、端到端快 10%（p=0.057）。**n=4、非预先假设、未做多重比较校正——不能当结论。**                    | 低     |

**所以：修复是对的、机制在真机上被证实生效了，但它不是你这个症状的解药。** 详见 §10、§11。

---

## 1. 两个臂是什么

|                    | OLD 臂                                                             | NEW 臂                                                                                                                                                                                           |
| ------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 插件               | 已发布的 `@sunerpy/opencode-kiro-auth@0.15.4`                      | 本地工作树 `/config/workspace/ProdDir/AI/opencode-kiro-auth`                                                                                                                                     |
| 对应提交           | `80782f9`（`chore: release 0.15.4`，即修复前）                     | `f18a2ab`（Wave 1–6：文本恢复、信封捕获、关联缓存、原生签名回放、恢复管线、日志脱敏）                                                                                                            |
| `dist/*.js` 文件数 | 63                                                                 | 70                                                                                                                                                                                               |
| `dist` 树 SHA-256  | `6059dd40c7013b1f4b9ef87159720052fe8b730c1b8e0670eb7e643171fc8515` | `b3272925c9b4c539aec43322a9d1d20d3e3d4365446df32e7772a51686c99215`                                                                                                                               |
| NEW 独有文件       | —                                                                  | `plugin/reasoning/{correlation-cache,emitted-output,request-replay,turn-identity}.js`、`plugin/streaming/reasoning-accumulator.js`、`plugin/log-redaction.js`、`core/request/sdk-log-payload.js` |

两臂共享：同一个 OpenCode 二进制（`1.18.5`）、同一个模型（`kiro-auth/claude-opus-5-high`，线上 `modelId=claude-opus-5`）、同一个 agent（内置 `build`）、同一份 fixture（逐字节相同）、同一个 `kiro.db` 与同一份插件 `kiro.json`。**唯一的差别就是加载了哪个 kiro-auth 构建。**

> ⚠️ 两个构建的 `package.json` 版本号**都是 `0.15.4`**（本地工作树还没 bump），
> `dist/index.js` 的 SHA-256 也**完全相同**（它只是个 re-export 壳）。
> 所以"看版本号"或"哈希入口文件"都会给出假的一致结论——必须用 §3 的办法。

### 复现命令

```bash
# 0) 前置：本地构建必须是最新的
cd /config/workspace/ProdDir/AI/opencode-kiro-auth
bun install && bun run build

# 1) 生成 fixture（幂等，两臂共用同一份字节）
bun run scripts/probes/ab-opencode/build-fixture.ts --variant all

# 2) 跑 A/B（真机调用！每个臂 3 次，交替执行）
CONFIRM=1 bun run scripts/probes/ab-opencode/run-ab.ts \
  --runs 3 --variant baseline \
  --model kiro-auth/claude-opus-5-high \
  --out /tmp/opencode/ab-real2

# 追加更多次（避免与已有下标冲突）
CONFIRM=1 bun run scripts/probes/ab-opencode/run-ab.ts \
  --runs 5 --start 4 --variant baseline \
  --model kiro-auth/claude-opus-5-high \
  --out /tmp/opencode/ab-real2

# 3) 出表（下文所有数字都由这一条命令产生）
bun run scripts/probes/ab-opencode/analyze-ab.ts --in /tmp/opencode/ab-real2

# 3b) 更难的条件（20 跳 + 每轮模数校验和），每臂 4 次
CONFIRM=1 bun run scripts/probes/ab-opencode/run-ab.ts \
  --runs 4 --variant stress \
  --model kiro-auth/claude-opus-5-high \
  --out /tmp/opencode/ab-stress
bun run scripts/probes/ab-opencode/analyze-ab.ts --in /tmp/opencode/ab-stress

# 4) 脱敏后落盘为可提交证据
bun run scripts/probes/ab-opencode/sanitize-runs.ts \
  --in /tmp/opencode/ab-real2 \
  --out scripts/probes/ab-opencode/results/baseline
bun run scripts/probes/ab-opencode/sanitize-runs.ts \
  --in /tmp/opencode/ab-stress \
  --out scripts/probes/ab-opencode/results/stress

# 5) 从已提交的脱敏证据重算同一张表（必须完全一致）
bun run scripts/probes/ab-opencode/analyze-ab.ts \
  --in scripts/probes/ab-opencode/results/baseline
bun run scripts/probes/ab-opencode/analyze-ab.ts \
  --in scripts/probes/ab-opencode/results/stress
```

`run-ab.ts` 没有 `CONFIRM=1` 会直接拒绝执行。

---

## 2. `OPENCODE_CONFIG` 到底是替换还是合并（你问的那个问题）

**实测结论（OpenCode 1.18.5）：**

| 机制                        | 行为                                                         | 能否用来隔离插件                    |
| --------------------------- | ------------------------------------------------------------ | ----------------------------------- |
| `OPENCODE_CONFIG=<file>`    | **被读取，但与全局 `~/.config/opencode/opencode.json` 合并** | ❌ **不能**。它只能"加"，不能"减"。 |
| `OPENCODE_CONFIG_DIR=<dir>` | 在 1.18.5 上**没有观察到任何效果**                           | ❌ 不能                             |
| `XDG_CONFIG_HOME=<dir>`     | **整体重定位配置解析**                                       | ✅ **可以**，这是本实验用的机制     |

实测方法（全部零 API 开销，用 `opencode models` / `opencode agent list` 就够）：

```bash
OC=/config/.local/share/mise/installs/opencode/1.18.5/opencode

# 基线：全局配置声明了 myopenai / awsopenai / google / nwcdai 四个 provider
$OC models | sed 's|/.*||' | sort -u
# -> amazon-bedrock awsopenai google kiro-auth myopenai nwcdai openai opencode zhipuai zhipuai-coding-plan

# 只声明一个 kiro-auth 插件的极小配置
cat > /tmp/min.json <<'EOF'
{"$schema":"https://opencode.ai/config.json","plugin":["@sunerpy/opencode-kiro-auth@0.15.4"]}
EOF

OPENCODE_CONFIG=/tmp/min.json $OC models | sed 's|/.*||' | sort -u
# -> 与基线【完全一致】：myopenai/awsopenai/google/nwcdai 都还在 => 是合并，不是替换

OPENCODE_CONFIG_DIR=/tmp/cfgdir $OC models | sed 's|/.*||' | sort -u
# -> 同样与基线一致 => 该变量在 1.18.5 上不影响配置解析

mkdir -p /tmp/xdg/opencode && cp /tmp/min.json /tmp/xdg/opencode/opencode.json
XDG_CONFIG_HOME=/tmp/xdg $OC models | sed 's|/.*||' | sort -u
# -> amazon-bedrock kiro-auth openai opencode zhipuai zhipuai-coding-plan
#    myopenai/awsopenai/google/nwcdai 全部消失 => 隔离成功
XDG_CONFIG_HOME=/tmp/xdg $OC agent list
# -> 只剩内置 build/plan/explore/general/... ；oh-my-openagent 的 Sisyphus/Hephaestus/... 全部消失
```

**顺带确认 `OPENCODE_CONFIG` 确实被读到了**（不是被忽略）：在 `/tmp/min.json` 里加一个假 provider `abtestmarker`，`$OC models` 就会列出 `abtestmarker/marker-model`。所以它是"读到了并合并"，而不是"没读"。

### 隔离带来的连带问题，以及怎么处理

插件自己的所有路径都挂在同一个 `XDG_CONFIG_HOME` 下
（`src/plugin/paths.ts` / `src/plugin/storage/sqlite.ts:42-49`）：

```
$XDG_CONFIG_HOME/opencode/kiro.db
$XDG_CONFIG_HOME/opencode/kiro-auth-plugin/kiro.json
$XDG_CONFIG_HOME/opencode/kiro-auth-plugin/logs/
$XDG_CONFIG_HOME/opencode/kiro-auth-plugin/.kiro-refresh-<id>.lock
```

也就是说，天真地设 `XDG_CONFIG_HOME` 会让插件看到一个**空的账号库**，直接没法认证。
本实验的处理方式是把这些条目**符号链接回真实目录**：

```bash
ROOT=/tmp/opencode/ab-arms; REAL=$HOME/.config/opencode
for arm in old new; do
  d=$ROOT/$arm/opencode; mkdir -p "$d"
  ln -s "$REAL/kiro.db"          "$d/kiro.db"
  ln -s "$REAL/kiro.db-wal"      "$d/kiro.db-wal"
  ln -s "$REAL/kiro.db-shm"      "$d/kiro.db-shm"
  ln -s "$REAL/kiro-auth-plugin" "$d/kiro-auth-plugin"   # 关键：刷新锁必须共享
done
```

**为什么必须是符号链接而不是拷贝**：refresh token 是**一次性**的。如果拷一份库，
臂内发生 token 轮换时新 token 只落在副本里，真实库里那个已被消费的 token 就永久失效了。
同理，`kiro-auth-plugin` 目录必须共享，否则 `withRefreshLock` 的**跨进程互斥失效**
（机器上确实同时有其他 opencode 进程在跑），两边同时刷新同一个账号就会把账号刷坏。

### 还有一个坑：`opencode run` 不认 spawn 的 cwd

这是本实验中途发现并**导致第一批数据作废**的问题（详见 §13）：

- `opencode models` **会**尊重子进程的 `cwd`（`creating instance directory=<cwd>`）；
- `opencode run` **不会**——它把项目目录解析成了别的地方（实测落到了仓库根），
  于是 agent 在仓库里到处找 `ledger/`，还顺手把仓库的 `AGENTS.md` 吃进了上下文。

**必须显式传 `--dir <runDir>`。** 实测传了之后 `directory=<runDir>`，相对路径也正确落在 run 目录里。

---

## 3. 怎么**证明**每个臂真的加载了它该加载的构建

这是整个实验最重要的对照。因为版本号和入口文件哈希都相同（见 §1 警告），
这里用了一个 **4 格置换对照**：把某个构建的 `dist` 临时改名，看另一个臂是否还活着。
探针是 `opencode models | grep -c '^kiro-auth/'`——插件加载失败时 kiro-auth 的模型会全部消失，
而这条命令**不花任何 API 配额**。

```bash
LOCAL=/config/workspace/ProdDir/AI/opencode-kiro-auth
OLDPKG='/config/.cache/opencode/packages/@sunerpy/opencode-kiro-auth@0.15.4/node_modules/@sunerpy/opencode-kiro-auth'
probe() { XDG_CONFIG_HOME=$1 opencode models 2>/dev/null | grep -c '^kiro-auth/'; }
```

| 条件                       | OLD 臂 kiro 模型数 | NEW 臂 kiro 模型数 | 结论                                     |
| -------------------------- | ------------------ | ------------------ | ---------------------------------------- |
| 基线（都在）               | 59                 | 59                 | 两臂都能加载                             |
| **隐藏本地 `dist`**        | **59**             | **0**              | OLD 不依赖本地构建；NEW **依赖**本地构建 |
| **隐藏缓存 0.15.4 `dist`** | **0**              | **59**             | OLD **依赖** 0.15.4；NEW 不依赖 0.15.4   |

四格全部符合预期，方向互斥。**两臂各自加载的就是它声明的那个构建，且不含另一个构建的任何代码。**
（两次改名后都已复原，`ls -d` 已确认。）

三条互相独立的辅助证据：

1. **文件清单**：OLD 的 `dist` 是 NEW 的**严格子集**（63 vs 70），完全没有 `plugin/reasoning/` 目录。
2. **符号级**：字符串 `historyReasoning` 在 NEW 的 `dist/core/request/sdk-log-payload.js` 里出现 2 次，
   在 OLD 的整个 `dist` 里出现 **0 次**。
3. **运行时**：NEW 臂的出站 api 日志里真的出现了 `historyReasoning` 条目（§7），
   OLD 臂全部为 0。**注意方向性**：`historyReasoning` 出现 ⇒ 一定是 NEW；
   但它**不出现不能证明是 OLD**（NEW 在缓存未命中时也是 0）。所以运行时证据只能加固，不能替代 4 格对照。

---

## 4. Fixture 与正确答案

`scripts/probes/ab-opencode/fixture/`（由 `build-fixture.ts` 幂等生成，两臂逐字节相同）：

- `ledger/step01.json` … `step10.json`，每个形如 `{"value": <int>, "op": "...", "next": "<stepNN|null>"}`。
- **遍历顺序刻意非顺序**，模型无法预测下一个文件名，必须真的把文件读出来才知道下一跳：

```
step01 -> step07 -> step03 -> step09 -> step05 -> step02 -> step10 -> step04 -> step08 -> step06(next=null)
```

- 折叠过程（生成器强制每一步都是整数，否则直接抛错）：

| hop | 文件   | op       | value | running total |
| --- | ------ | -------- | ----- | ------------- |
| 1   | step01 | seed     | 7     | 7             |
| 2   | step07 | multiply | 6     | 42            |
| 3   | step03 | add      | 58    | 100           |
| 4   | step09 | divide   | 4     | 25            |
| 5   | step05 | multiply | 13    | 325           |
| 6   | step02 | subtract | 25    | 300           |
| 7   | step10 | divide   | 12    | 25            |
| 8   | step04 | add      | 143   | 168           |
| 9   | step08 | divide   | 8     | 21            |
| 10  | step06 | multiply | 11    | **231**       |

**正确答案 `FINAL_TOTAL=231`**，已用一段独立的 Python 脚本单独验算过一遍（不复用生成器的代码）。

提示词要求：每轮只读一个文件、每轮从头重算整条折叠、`next` 为 `null` 时停止，
并且最后一条消息必须以 `FINAL_TOTAL=<整数>` 结尾——这样判分是客观的。
run 目录里**只有 `ledger/`**，`expected.json` 不在其中，模型没法抄答案。

---

## 5. 每次运行的结果（baseline，每臂 8 次，交替执行）

模型 `kiro-auth/claude-opus-5-high`；OLD/NEW 严格交替（old-01, new-01, old-02, new-02, …），
所以上游模型行为的漂移不会被误读成臂效应。

| run    | arm | 工具调用 | 唯一 ledger 读取 | 走完链 | FINAL_TOTAL | 正确   | 轮数 | 有推理的轮 | 推理字符 | 首个 0 推理轮 | 结果                       | 耗时  |
| ------ | --- | -------- | ---------------- | ------ | ----------- | ------ | ---- | ---------- | -------- | ------------- | -------------------------- | ----- |
| old-01 | old | 1        | 1/10             | **否** | -           | **否** | 2    | 1/2        | 162      | 2             | **announced_then_stopped** | 18.7s |
| new-01 | new | 10       | 10/10            | 是     | 231         | 是     | 11   | 1/11       | 71       | 1             | completed_correct          | 41.7s |
| old-02 | old | 10       | 10/10            | 是     | 231         | 是     | 11   | 3/11       | 749      | 1             | completed_correct          | 43.5s |
| new-02 | new | 10       | 10/10            | 是     | 231         | 是     | 11   | 2/11       | 371      | 1             | completed_correct          | 42.4s |
| old-03 | old | 1        | 1/10             | **否** | -           | **否** | 2    | 0/2        | 0        | 1             | **announced_then_stopped** | 7.8s  |
| new-03 | new | 10       | 10/10            | 是     | 231         | 是     | 11   | 1/11       | 214      | 1             | completed_correct          | 45.8s |
| old-04 | old | 10       | 10/10            | 是     | 231         | 是     | 11   | 0/11       | 0        | 1             | completed_correct          | 40.6s |
| new-04 | new | 10       | 10/10            | 是     | 231         | 是     | 11   | 2/11       | 244      | 1             | completed_correct          | 50.2s |
| old-05 | old | 10       | 10/10            | 是     | 231         | 是     | 11   | 2/11       | 241      | 1             | completed_correct          | 45.1s |
| new-05 | new | 10       | 10/10            | 是     | 231         | 是     | 11   | 2/11       | 372      | 1             | completed_correct          | 44.6s |
| old-06 | old | 10       | 10/10            | 是     | 231         | 是     | 11   | 3/11       | 492      | 1             | completed_correct          | 45.4s |
| new-06 | new | 1        | 1/10             | **否** | -           | **否** | 2    | 0/2        | 0        | 1             | **announced_then_stopped** | 7.9s  |
| old-07 | old | 10       | 10/10            | 是     | 231         | 是     | 11   | 1/11       | 160      | 1             | completed_correct          | 56.4s |
| new-07 | new | 10       | 10/10            | 是     | 231         | 是     | 11   | 1/11       | 156      | 1             | completed_correct          | 44.1s |
| old-08 | old | 10       | 10/10            | 是     | 231         | 是     | 11   | 0/11       | 0        | 1             | completed_correct          | 41.3s |
| new-08 | new | 10       | 10/10            | 是     | 231         | 是     | 11   | 3/11       | 670      | 1             | completed_correct          | 49.2s |

**没有任何一次是网络/429/空 200 之类的技术性失败**（`exitCode` 全为 0，`stderr` 全为空，
事件流里没有 `type:"error"`），所以 16 次全部计入。

**三次提前停止的原始末条消息**（脱敏后的 `export.json` 原文）：

```
old-01  最后一轮 text: "hop 1: step01 -> seed 7 -> 7\n\nNext: step07"          finish_reason=stop
old-03  最后一轮 text: "hop 1: step01 -> seed 7 -> running total 7\n\nNext: `step07`."   finish_reason=stop
new-06  （同形，1 次工具调用后即 stop）
```

这就是你描述的症状本身：**报告了当前进度、点名了下一步要读哪个文件，然后不发工具调用就结束了。**

---

## 6. 每轮推理字符数

| run    | t1  | t2  | t3  | t4  | t5  | t6  | t7  | t8  | t9  | t10 | t11 |
| ------ | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| old-01 | 162 | 0   | -   | -   | -   | -   | -   | -   | -   | -   | -   |
| new-01 | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 71  |
| old-02 | 0   | 0   | 0   | 0   | 0   | 178 | 243 | 0   | 0   | 0   | 328 |
| new-02 | 0   | 0   | 122 | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 249 |
| old-03 | 0   | 0   | -   | -   | -   | -   | -   | -   | -   | -   | -   |
| new-03 | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 214 |
| old-04 | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   |
| new-04 | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 93  | 151 |
| old-05 | 0   | 0   | 141 | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 100 |
| new-05 | 0   | 0   | 0   | 0   | 0   | 175 | 0   | 0   | 0   | 0   | 197 |
| old-06 | 0   | 0   | 122 | 0   | 0   | 0   | 0   | 0   | 0   | 234 | 136 |
| new-06 | 0   | 0   | -   | -   | -   | -   | -   | -   | -   | -   | -   |
| old-07 | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 160 |
| new-07 | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 156 |
| old-08 | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   |
| new-08 | 0   | 0   | 0   | 0   | 0   | 187 | 175 | 0   | 0   | 0   | 308 |

**这张表最重要的一点不是臂差异，而是"分母太小"**：
`claude-opus-5-high` 在这个任务上**大部分轮次根本不产生任何推理**（一半的运行是 0/11 或 1/11）。
"推理坍缩"这个说法在这里几乎无从谈起——它压根没怎么开始过。
这也直接解释了为什么签名回放在行为上没有可测效果：**没有推理可以保护。**

> 数据来源说明：`--format json` 事件流里**不含 `reasoning` 部件**，
> 所以推理量是从 `opencode export <sessionID>` 取的（那里有完整的 `type:"reasoning"` 部件）。
> runner 每跑完一次就自动导一份，两个通道都作为原始证据提交了。

---

## 7. 签名推理有没有真的上线（插件 api 日志）

| run    | arm | 出站 SDK 请求 | 带 `historyReasoning` 的请求 | 回放的签名信封数 |
| ------ | --- | ------------- | ---------------------------- | ---------------- |
| old-01 | old | 2             | 0                            | 0                |
| new-01 | new | 11            | 0                            | 0                |
| old-02 | old | 11            | 0                            | 0                |
| new-02 | new | 11            | **8**                        | **8**            |
| old-03 | old | 2             | 0                            | 0                |
| new-03 | new | 11            | 0                            | 0                |
| old-04 | old | 11            | 0                            | 0                |
| new-04 | new | 11            | **1**                        | **1**            |
| old-05 | old | 11            | 0                            | 0                |
| new-05 | new | 11            | **5**                        | **5**            |
| old-06 | old | 11            | 0                            | 0                |
| new-06 | new | 2             | 0                            | 0                |
| old-07 | old | 11            | 0                            | 0                |
| new-07 | new | 11            | 0                            | 0                |
| old-08 | old | 11            | 0                            | 0                |
| new-08 | new | 11            | **5**                        | **9**            |

一条真实的回放记录长这样（插件日志本身就是脱敏的——只有长度和 sha256 前缀，没有签名原文）：

```json
{
  "index": 3,
  "envelope": {
    "redacted": true,
    "kind": "reasoningText",
    "reasoningText": {
      "textLength": 38,
      "textSha256Prefix": "f2be5d265557",
      "signature": { "present": true, "length": 340, "sha256Prefix": "6483b5aece5f" }
    }
  }
}
```

签名长度 340 落在此前实测的 308–376 区间内。

**结论**：机制在真机端到端链路上**确实生效**——OLD 臂 8/8 运行、共 70 个请求，一个 `historyReasoning` 都没有（代码里就没这东西）；
NEW 臂在 4/8 运行里发生了回放。另外 4 次 NEW 运行是 0，原因见 §6：那几次模型压根没输出推理，
**缓存里没有信封可发，按设计就退化成 OLD 的行为**（未命中 = 无操作 = 零回归）。

⚠️ **这条必须说清楚**：new-01 / new-03 / new-07 是 `historyReasoning=0` 的情况下完成任务的。
也就是说这三次成功**不能归因于签名回放**——那时候两臂送上线的历史在推理层面是等价的。
我们还独立核对了这一点：完成任务的 old / new 运行的 `historyLength` 序列**完全一致**
（`[2, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20]`），说明会话结构本身没有差别。

---

## 8. 结果计数与显著性

| 结果                                                                           | OLD (n=8) | NEW (n=8) |
| ------------------------------------------------------------------------------ | --------- | --------- |
| `completed_correct`（走完 10 跳且 `FINAL_TOTAL=231`）                          | 6         | 7         |
| `announced_then_stopped`（链未完成 + 末轮只有文本无工具调用 + 文本指向下一步） | **2**     | **1**     |
| `silent_stop`（链未完成且末轮完全没有输出，即空 200 形态）                     | 0         | 0         |
| `other_failure`（非 0 退出 / 超时 / 事件流报错）                               | 0         | 0         |

**双侧 Fisher 精确检验：p = 1.0。**

2/8 与 1/8 在统计上无法区分。要在 α=0.05 下把"提前停止率从 25% 降到 12.5%"这个量级
检出来，每臂大约需要 **150–200 次运行**——本实验的 8 次连接近都算不上。

---

## 9. 更难的条件（stress：20 跳 + 每轮模数校验和）

因为 baseline 的行为结果打平，这里加了一个更难的条件，直接回答"要多难才看得出差别"。
`fixture-stress/`：**20 跳**、非顺序遍历、更大的数字，并且**每轮还要重算一个模 9973 的校验和**
（提示词明确要求"从 hop 1 重新相加，不许在上一轮的校验和上累加"）。
正确答案 `FINAL_TOTAL=459`、`FINAL_CHECKSUM=8553`，同样用独立 Python 脚本验算过。

每臂 4 次，交替执行，同一模型。

| run    | arm | 工具调用 | 唯一 ledger 读取 | 走完链 | FINAL_TOTAL | 正确 | 轮数 | 有推理的轮 | 推理字符 | 结果              | 耗时   |
| ------ | --- | -------- | ---------------- | ------ | ----------- | ---- | ---- | ---------- | -------- | ----------------- | ------ |
| old-01 | old | 20       | 20/20            | 是     | 459         | 是   | 21   | 12/21      | 2009     | completed_correct | 125.5s |
| new-01 | new | 20       | 20/20            | 是     | 459         | 是   | 21   | 12/21      | 1606     | completed_correct | 107.8s |
| old-02 | old | 20       | 20/20            | 是     | 459         | 是   | 21   | 10/21      | 1967     | completed_correct | 111.3s |
| new-02 | new | 20       | 20/20            | 是     | 459         | 是   | 21   | 3/21       | 550      | completed_correct | 102.1s |
| old-03 | old | 20       | 20/20            | 是     | 459         | 是   | 21   | 13/21      | 2345     | completed_correct | 123.0s |
| new-03 | new | 20       | 20/20            | 是     | 459         | 是   | 21   | 3/21       | 424      | completed_correct | 115.1s |
| old-04 | old | 20       | 20/20            | 是     | 459         | 是   | 21   | 10/21      | 1762     | completed_correct | 122.6s |
| new-04 | new | 20       | 20/20            | 是     | 459         | 是   | 21   | 3/21       | 454      | completed_correct | 108.0s |

**结果计数：OLD 4/4 完成正确，NEW 4/4 完成正确。8 次运行里 0 次提前停止。**
`FINAL_CHECKSUM` 也全部正确（分析器对 stress 变体会同时校验总和与校验和）。

**这个结果和"更难 = 更容易暴露差异"的直觉是相反的：任务变难反而让症状消失了。**
最合理的解释是：20 跳 + 每轮模数运算让模型从第 10 轮起持续进入推理状态（见下表），
它不再把"重述当前折叠"当成一个可交付的终态答案。

签名回放在这个条件下强度大得多：

| run       | arm | 出站请求 | 带 `historyReasoning` 的请求 | 回放信封数    |
| --------- | --- | -------- | ---------------------------- | ------------- |
| old-01…04 | old | 21 each  | **0**（全部）                | **0**（全部） |
| new-01    | new | 21       | 11                           | **66**        |
| new-02    | new | 21       | **18**                       | 29            |
| new-03    | new | 21       | 11                           | 21            |
| new-04    | new | 21       | 11                           | 21            |

每轮推理字符数（`t10` 之后才是有信息量的区间）：

| run    | t1–t9          | t10 | t11 | t12 | t13 | t14 | t15 | t16 | t17 | t18 | t19 | t20 | t21 |
| ------ | -------------- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| old-01 | 全 0           | 116 | 248 | 211 | 156 | 111 | 141 | 130 | 132 | 167 | 171 | 215 | 211 |
| new-01 | 全 0           | 290 | 119 | 107 | 45  | 84  | 127 | 108 | 140 | 123 | 156 | 84  | 223 |
| old-02 | 全 0           | 142 | 227 | 0   | 183 | 225 | 184 | 166 | 149 | 132 | 0   | 116 | 443 |
| new-02 | t3=179         | 145 | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 226 |
| old-03 | t3=179         | 132 | 145 | 181 | 173 | 181 | 200 | 87  | 131 | 140 | 110 | 237 | 449 |
| new-03 | 全 0           | 115 | 45  | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 264 |
| old-04 | t2=169, t7=181 | 397 | 179 | 0   | 0   | 0   | 147 | 164 | 0   | 95  | 139 | 162 | 129 |
| new-04 | 全 0           | 155 | 158 | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 0   | 141 |

### 两个**探索性**观察（不是预先假设，不能当结论）

| 指标                 | OLD 均值 (n=4) | NEW 均值 (n=4)     | Mann-Whitney 精确双侧 p |
| -------------------- | -------------- | ------------------ | ----------------------- |
| 新产生的推理字符总量 | 2020.8         | **758.5**（−62%）  | **0.0286**              |
| 端到端耗时           | 120.6s         | **108.2s**（−10%） | 0.0571                  |
| 有推理的轮数         | 11.2           | 5.2                | 0.6857                  |

方向是一致的：**NEW 臂在正确性完全相同（4/4）的前提下，产生的新推理更少、跑得更快。**
一个说得通的解释是——回放回去的签名推理让模型**不必重新推导**它上一轮已经想过的东西，
所以它省掉了重复推理。new-02/03/04 在 t12–t20 几乎完全不再推理，而对应的 OLD 运行几乎每轮都在推。

**但请按探索性观察对待，不要当成结论**，理由有四条：

1. **n=4**。
2. 这些指标**不是预先声明的**——我是先看到表格才去检验的。
   在同一批数据里我可以做的比较有很多，所以这个 p 值没有做多重比较校正，名义显著性会被高估。
3. 耗时受网络与机器负载影响，`p=0.0571` 本身也没过 0.05。
4. new-01 是个反例：它推理了 1606 字符、12/21 轮，和 OLD 同一量级。
   所以"NEW 一定推理更少"并不成立。

如果要把"回放降低冗余推理"变成一个可主张的结论，需要**预先声明该指标**，
每臂跑 20–30 次，并且用 token 计数（而不是字符数）作为口径。

---

## 10. 诚实的裁决

### 被证实的

1. **用户报告的症状是真的，而且能在受控条件下复现。** 24 次运行里 3 次
   （baseline 的 old-01、old-03、new-06）在第 1 次工具调用后就停了，末条消息明确点名了下一步。
   这不是"模型偷懒"的主观印象，是可以从提交的 `export.json` 里逐字读出来的。
2. **修复的机制在真机端到端链路上生效。** NEW 臂把带签名的原生
   `assistantResponseMessage.reasoningContent.reasoningText.{text,signature}` 送上了线
   （baseline 4/8 运行；stress **4/4 运行、最多 18/21 个请求、单次最多 66 个信封**），
   全部被服务端接受（无 400、无重试、无 `THINKING_SIGNATURE_INVALID`）。
   OLD 臂在 12 次运行、共 154 个请求里一个都没有——结构上不可能做到这件事。
3. **未命中就是无操作。** baseline 有 4 次 NEW 运行完全没有回放（模型没产出推理），
   这几次的表现和 OLD 臂没有区别——这正是设计承诺的"最坏情况零回归"，在真机上得到了验证。

### 没有被证实的（也是你最该知道的）

4. **修复没有可测量地降低"提前停止"的发生率。** baseline 2/8 vs 1/8，p = 1.0；
   stress 两臂各 0/4。
   **如果你现在发版的理由是"它能治好提前停止"，这份数据不支持这个说法。**
5. **"提前停止 = 推理坍缩"这个因果假设，在本实验里站不住。**
   三次停止全都发生在**第 2 轮**。此时的历史里最多只有一轮助手消息，
   其中两次上一轮的推理量是 **0**（另一次是 162 字符）。
   签名回放能保护的东西——"上一轮的推理"——在停止发生的那一刻**基本不存在**。
   换句话说：这个症状发生得**太早**，早于任何推理能够累积、也早于任何回放能够起作用。
6. **"任务更难更容易暴露差异"也被否掉了。** 20 跳 + 每轮模数校验和这个更重的条件，
   反而让症状**在两臂都彻底消失**（8/8 全部完成正确）。
   难度更高 ⇒ 模型从第 10 轮起持续推理 ⇒ 它不再把"重述折叠"当成终态答案。
   所以这个症状偏好的是**轻量、每轮都有"看起来像交付物"的输出**的任务，
   而不是长而重的任务。

### 要把差异（如果存在）暴露出来，需要什么

- **样本量**：每臂 150–200 次，才够检出 25% → 12.5% 这个量级。当前是 8 次（stress 4 次）。
- **换指标**：既然"提前停止率"在两臂都测不出差别，更有希望的是
  **stress 条件下已经出现方向性信号的那两个效率指标**（新推理量 −62%、耗时 −10%，§9）。
  把它们**预先声明**、改用 token 计数、每臂 20–30 次，是最省配额的下一步。
- **一个真的会产生推理的任务**：baseline 上 `opus-5-high` 大部分轮次推理为 0（§6），
  stress 上要到第 10 轮才开始（§9）。**没有推理，就没有签名；没有签名，这个修复在定义上是空操作。**
  更高 effort 档（`claude-opus-5-max` / `-xhigh`）可能把推理起点提前。
- **一个更长的、单一连续工具循环**：修复的作用域被 `findActiveToolLoopStart` 限制在
  **进行中的那一个工具循环**内。循环一旦结束、用户又发了新一轮，什么都不会回放。
  所以能体现价值的场景是"一次提问、很多跳、不中断"——而不是多轮对话。
- **进程内缓存意味着跨运行无收益**：每次 `opencode run` 都是独立进程，
  关联缓存（`reasoningCorrelationCache`）是**进程内**的模块级单例，
  上限 64 条 / 每循环 16 条 / TTL 30 分钟。
  这已由本实验独立确认：每次运行的 `historyReasoning` 计数**互相独立**、不递增
  （baseline 8 / 1 / 5 / 5 / 0…），第一次请求永远是 0（缓存刚建、还没有信封）。
  **所以这个修复只在单次运行的工具循环内部起作用，重启一次就清零。**

---

## 11. 用大白话把测量和你的症状对上

你的观察是：**"长任务里，agent 说了它接下来要干什么，然后就停住了，不发工具调用。"**

这份实验对这句话的回答是：

1. **确实会发生**，24 次里 3 次（全部出现在 10 跳这个较轻的条件下）。你没有看错。
2. **它发生在很早的地方**——第 2 轮，也就是刚读完第一个文件之后。
   不是"跑了很久之后注意力涣散"，而是"第一步刚做完就撒手"。
3. **它在修复前后都会发生**（OLD 2 次、NEW 1 次）。所以它**不是**"插件把推理签名丢了"造成的。
4. 更像是模型侧的一种**指令跟随/停止判断**问题：模型把"restate 当前折叠"当成了一个可交付的答案，
   于是给出 `finish_reason=stop`，而不是把 `Next: step07` 变成下一个工具调用。
   我们的提示词里"每轮只读一个文件 + 每轮从头重述"这两条规则，
   恰好给了它一个"这一轮我已经交付了东西"的借口。
5. **把任务加重之后症状消失了**（20 跳 + 每轮模数校验和：两臂 8/8 全部完成）。
   这条反而是支持第 4 点的最强证据：如果原因是"长任务里注意力涣散"，
   任务变长变难应该让症状**更严重**，而实测是**完全消失**。
   更长更重的任务让模型持续处于推理状态，它就不再误判"我已经交付完了"。
6. 也**不是** Kiro 那个已知的"HTTP 200 + 完全空响应"行为：
   这三次都实实在在输出了文本，`finish_reason` 是 `stop`，
   分析器把这种"完全没输出"的形态单独归为 `silent_stop`，24 次运行里**是 0 次**。

**结论的置信度**：对第 1、2、3、5、6 条是**高**（都是直接测量）；
对第 4 条的机制解释是**中高**——我们证明了"不是推理坍缩"，而且第 5 条的方向性
（越难越不容易停）与"注意力涣散"假设正好相反、与"停止判定误判"假设一致；
但"指令跟随"仍然是最贴合证据的推断，本实验没有直接测它（那需要改提示词做消融实验）。

**这对"要不要发版"意味着什么**：修复本身是正确的、被真机验证过的、最坏情况零回归的，
发版的理由可以是"恢复了推理连续性、消除了签名被丢弃这个真实缺陷"，
再加上一个**尚未证实但方向一致**的效率信号（§9）；
**但不能是"修好了提前停止"**。要治提前停止，方向更可能在提示词/agent 的停止判定上
（例如显式禁止"只重述不行动"的回合），而不在这个插件里。

---

## 12. 与已提交的直连 API 探针证据的关系

`scripts/probes/results/` 里已经有一批更底层的证据（`ab-reasoning-probe.ts` 产出，**本次没有重跑**）：

| turn | arm A（回放签名） frames | arm B（丢弃签名） frames | A chars | B chars |
| ---- | ------------------------ | ------------------------ | ------- | ------- |
| 0    | 15                       | 11                       | 112     | 68      |
| 1    | 12                       | 9                        | 62      | 63      |
| 2    | 6                        | 7                        | 44      | 44      |
| 3    | 14                       | **0**                    | 98      | **0**   |
| 4    | 18                       | —                        | 114     | —       |

arm A 5/5 轮都有推理并算出正确答案；arm B 在第 3 轮推理归零、不发工具调用、也不出文本，任务被放弃。

**两份证据为什么都必要，又为什么不能互相替代：**

- 直连探针**自己构造 CodeWhisperer 请求体**。它证明的是**机制**在真实 API 上成立：
  丢签名会导致推理逐轮衰减直至坍缩，带签名不会。它**不经过** `transformToSdkRequest`、
  不经过账号选择器、不经过 OpenCode。
- 本实验**完整走真实插件**（OpenCode → 自定义 fetch → `RequestHandler` → SDK），
  但它测的是**端到端行为**，而端到端里有大量它控制不了的变量（模型是否愿意推理、
  agent 的停止判定、提示词）。

另外一个必须诚实指出的差异：直连探针里 arm B **第 3 轮就坍缩**并放弃任务；
本实验**两个条件都没有复现坍缩**。

- 10 跳条件：推理量本来就稀疏（§6），大量轮次为 0，**没有可坍缩的东西**。
- 20 跳条件：推理确实持续存在（从第 10 轮起每轮都有，§9），
  但 **OLD 臂也没有坍缩** —— 12/21、10/21、13/21、10/21 轮有推理，一路推到第 21 轮，
  而且 4/4 全部算对。也就是说"丢签名 ⇒ 逐轮衰减至坍缩"这个在直连探针上重复出现的现象，
  **在真实插件的端到端链路上没有重现**。

为什么会这样，本实验没有答案。两个候选解释（都未验证）：
(a) OpenCode 的 openai-compatible 通道把每轮的助手可见文本完整回传，
这些文本本身就承载了"我推导到哪一步"的信息，起到了推理的替代作用；
(b) 直连探针的任务每轮强制产生 6–18 个推理帧，对推理连续性的依赖远高于本任务。

**所以：直连探针说"机制有效"，本实验说"在这两个任务规模下机制生效但行为上看不出差别，
而且连坍缩本身都没复现"。** 任何把两者合并成"修复解决了任务放弃问题"的总结都是**过度解读**。

---

## 13. 作废的运行、真实调用量与配额

### 作废的第一批（诚实记账，不计入任何一臂）

| 批次                               | 真实请求数 | 为什么作废                                                                                                                                                                  |
| ---------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 手动 smoke（NEW 臂，2 跳）         | 4          | 只用于验证管道和 `--format json` 形状                                                                                                                                       |
| harness 校验（haiku，两臂各 1 次） | 27         | 只用于验证 runner 落盘，不是推理模型                                                                                                                                        |
| **第一批 baseline（每臂 3 次）**   | **85**     | **`opencode run` 忽略了 spawn 的 cwd（§2 末），项目目录落到了仓库根**：agent 要先满仓库找 `ledger/`，还吃进了仓库的 `AGENTS.md`。两臂对称，但行为测量已被污染，故整批弃用。 |
| **被中止的第一次 stress**          | **51**     | 同一个 cwd 缺陷，跑到一半主动 kill                                                                                                                                          |
| `--dir` 验证探针（haiku）          | 2          | 用来确认 `--dir` 修好了项目目录                                                                                                                                             |

作废批次里唯一仍然可信的观察，是它也独立看到了 NEW 臂 `historyReasoning` 稳定生效
（3/3 运行、每次 12/14 个请求、33 个信封）——但**行为结论一律不采用**。

### 有效批次

| 批次                  | 运行数 | 真实请求数 |
| --------------------- | ------ | ---------- |
| baseline（每臂 8 次） | 16     | 149        |
| stress（每臂 4 次）   | 8      | 168        |

两批有效运行共 **317** 次真实 `generateAssistantResponse` 调用。
连同作废批次（85 + 51 + 27 + 4 + 2 = 169），本次实验共消耗 **486** 次真实调用。
交叉核对：插件今天的 api 日志里一共记了 **488** 个 request，其中 2 个在实验开始前
（03:01，属于其他会话）——`488 − 2 = 486`，与逐批相加**完全吻合**。

### 配额（`kiro.db`，只读查询）

运行前（`used_count` / `limit_count` / headroom）：

```
acct1  0     / 10000 / 10000   token 到期 2026-07-30 04:12:15Z
acct2  0     / 10000 / 10000   token 到期 2026-07-30 04:15:09Z
（另有 9500/10000 与 9707/10000 两个低余量账号，未被 sticky 选中）
```

运行后：

```
acct1  0     / 10000 / 10000   token 到期 2026-07-30 05:07:22Z
acct2  0     / 10000 / 10000   token 到期 2026-07-30 05:10:13Z
（两个低余量账号：9500 与 9707，均未变动）
```

**`used_count` 差值 = 0，尽管确实发生了 486 次真实调用。**
这与此前 wave 记录的现象一致（"9 次真实调用后 delta = 0"）。
所以 **`kiro.db` 的 `used_count` 不能作为计费依据**；真实调用量请用上表的 api 日志计数。
顺带一个副作用：headroom 拒绝判定是基于这个**可能已经过期**的计数算出来的。

**token 到期时间从 04:12/04:15 变成了 05:07/05:10** ——说明实验中途确实发生了一次
token 轮换，并且**正确写回了真实的 `kiro.db`**（走符号链接），账号状态健康。
这正是 §2 里坚持用符号链接而不是拷贝库的原因。

**关于写入 `kiro.db`**：本实验从未手工写库（所有查询都带 `-readonly`）。
但插件在正常运行中**必然**会写 `used_count` / `last_used`，token 到期时还会写轮换后的 token。
这与用户日常使用 opencode 时发生的事完全一样，不是实验引入的额外行为。

**关于用户的真实配置文件**：`~/.config/opencode/opencode.json`、`~/.omo/omo.jsonc`、
`auth.json` 一律未改。`~/.config/opencode/kiro-auth-plugin/kiro.json` 在实验前做了备份
并校验了 SHA-256，实验后再次校验为**未变更**（见 §14）。
插件设置是通过 `KIRO_ENABLE_LOG_API_REQUEST=true` / `KIRO_ACCOUNT_SELECTION_STRATEGY=sticky`
两个**环境变量**注入的——之所以用环境变量而不是项目级 `.opencode/kiro.json`，
是因为 `dist/plugin/config/loader.js` 在 0.15.4 和 HEAD 上是**同一个文件**（已 diff 确认），
所以环境变量这条路**不可能**引入臂间差异。

---

## 14. 残留混淆项与局限（全部如实列出）

1. **样本量太小。** baseline 每臂 8 次、stress 每臂 4 次。
   停止率对比 p = 1.0，§9 的两个效率指标 p = 0.029 / 0.057 但**未预先声明、未做多重比较校正**。
   任何"NEW 更好"的说法目前都没有足以支撑发版话术的统计强度。
2. **推理量稀疏。** 模型在 10 跳任务上大部分轮次不产生推理（§6），
   20 跳任务上也要到第 10 轮才开始（§9），
   这直接限制了修复能起作用的余地。这是**任务设计的局限**，不是修复的问题。
3. **两臂共享 `kiro.db` 与插件目录（符号链接）。** 这是为了账号安全刻意做的（§2），
   代价是两臂共享同一个使用量计数与刷新锁。两臂对称，不构成臂间偏差。
4. **模式初始化锁不共享。** `getMigrationLockPath()` 在 `$XDG/opencode/` 下，
   两臂各有一份，也与真实配置目录的那一份不同。因为该库已迁移完毕且迁移是
   marker 门控的（稳态下零写入），实测无影响，但这里如实标注。
5. **`expected.json` 新增了一个 `variant` 字段。** 为支持 stress 变体，
   `build-fixture.ts` 现在会往 `fixture/expected.json` 里多写一个 `variant: "baseline"`。
   **`PROMPT.md` 与 `ledger/*.json` 与实际运行时逐字节相同**（已 `diff -r` 确认），
   `expected.json` 只是判分元数据、不进提示词，所以不影响任何一次运行。
6. **`api-filtered.ndjson` 是过滤后的派生物，不是原始拷贝。** 每个请求里那份完整的工具
   schema 被替换成了 `toolCount`（它每个请求都一样，几百 KB 的纯样板）。
   其余内容除了 §15 列出的脱敏项之外**逐字节保留**。`REDACTION.json` 里有声明。
7. **`--format json` 事件流不含推理部件。** 推理量来自 `opencode export`。
   两个通道都提交了，但要注意别把 `stream.jsonl` 当成推理的证据来源。
8. **只测了一个模型、一个 agent、一种任务形状。** 不能外推到别的模型或别的工作负载。
9. **"宣告下一步"的词法判定是启发式的。** 主判据是**结构性**的
   （链未完成 + 末轮有文本无工具调用），词法正则只是并列报告，
   让你能自己核对措辞是否真的对得上你的症状。三次停止的原文都抄在 §5 里了。

---

## 15. 原始证据在哪

```
scripts/probes/ab-opencode/
├── build-fixture.ts                 # 幂等 fixture 生成器（baseline + stress）
├── run-ab.ts                        # 臂搭建 + 交替执行 + 落盘（需要 CONFIRM=1）
├── analyze-ab.ts                    # 从原始产物重算本文所有表格
├── sanitize-runs.ts                 # 生成可提交的脱敏副本
├── fixture/                         # baseline：10 跳，FINAL_TOTAL=231
│   ├── ledger/step01.json … step10.json
│   ├── PROMPT.md
│   └── expected.json
├── fixture-stress/                  # stress：20 跳，FINAL_TOTAL=459 / CHECKSUM=8553
└── results/
    ├── baseline/                    # 每臂 8 次
    │   ├── index.json               # 全部运行的元数据
    │   ├── REDACTION.json           # 逐文件脱敏账目
    │   └── {old,new}-0N/
    │       ├── meta.json            # 臂、插件 spec、时间戳、退出码、session id
    │       ├── stream.jsonl         # `opencode run --format json` 的完整原始事件流
    │       ├── export.json          # `opencode export <session>`：含 reasoning 部件的完整对话
    │       ├── stderr.txt           # 全部为 0 字节（`*.log` 被仓库 gitignore，故改名 .txt 提交）
    │       └── api-filtered.ndjson  # 插件出站 api 日志（工具 schema 已剔除）
    └── stress/                      # 每臂 4 次，结构同上
```

每份产物都做了三类脱敏（`REDACTION.json` 有逐文件计数）：
账号邮箱 → 稳定假名 `acctN@redacted.invalid`（保留了账号粘性的可见性）；
`profileArn` → 保留形状但去掉 AWS 账号 id 与 profile id；
任何 ≥100 字符的 base64url 串 → `<redacted:len=N>`。
提交前已 grep 校验：**没有 token、没有 refresh token、没有 `profileArn` 真值、
没有明文邮箱、没有签名原文**。签名本来就没有泄露风险——插件的日志层
（`describeReasoningContentForLog`）只记录长度和 sha256 前缀。

相关的、更底层的一批证据在 `scripts/probes/results/`（见 §12），本次**没有重跑**。
