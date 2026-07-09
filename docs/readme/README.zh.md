# opencode-kiro-auth

简体中文 · [English](../../README.md)

[![npm version](https://img.shields.io/npm/v/@sunerpy/opencode-kiro-auth)](https://www.npmjs.com/package/@sunerpy/opencode-kiro-auth)
[![npm downloads](https://img.shields.io/npm/dm/@sunerpy/opencode-kiro-auth)](https://www.npmjs.com/package/@sunerpy/opencode-kiro-auth)
[![license](https://img.shields.io/npm/l/@sunerpy/opencode-kiro-auth)](https://www.npmjs.com/package/@sunerpy/opencode-kiro-auth)

> 一个 OpenCode 插件，让 OpenCode 把 AWS Kiro（CodeWhisperer）作为模型提供方——
> 支持 Claude Sonnet、Opus、Haiku，以及 Kiro 代理的开放权重模型（DeepSeek、GLM、
> MiniMax、Qwen3），并附带较为宽裕的试用额度。

## 目录

- [特性](#特性)
- [安装](#安装)
- [配置认证](#配置认证)
- [插件配置](#插件配置)
- [多账号与轮换](#多账号与轮换)
- [用量显示](#用量显示)
- [模型](#模型)
- [故障排查](#故障排查)
- [迁移说明](#迁移说明)
- [本地插件开发](#本地插件开发)
- [开发](#开发)
- [存储位置](#存储位置)
- [致谢](#致谢)
- [上游同步](#上游同步)
- [免责声明](#免责声明)
- [许可证](#许可证)

## 特性

- **多种认证方式**：支持 AWS Builder ID（IDC）、IAM Identity Center（自定义
  Start URL）以及基于 Kiro Desktop CLI 的认证。
- **自动同步 Kiro CLI**：自动导入并同步本地 `kiro-cli` SQLite 数据库中的活跃会话。
- **渐进式上下文截断**：在重试时动态缩减上下文大小，智能规避 400 错误。
- **智能账号轮转**：基于剩余额度最低优先，在多账号间智能分配请求。
- **高性能存储**：使用原生 Bun SQLite 高效管理账号与用量数据。
- **原生 Thinking 模式**：通过虚拟模型映射完整支持 Claude 的推理能力。
- **Kiro Effort 映射**：自动将 OpenCode 的 thinking budget 映射为 Kiro 原生的
  effort 等级。
- **自动化恢复**：对限流请求做指数退避，并自动刷新 token。

## 安装

将插件添加到你的 `opencode.json` 或 `opencode.jsonc`：

```json
{
  "plugin": ["@sunerpy/opencode-kiro-auth"]
}
```

这样即可注册 `kiro-auth` provider 并使用默认模型集。如果要自定义暴露的模型
（包括 thinking 变体），参见 [模型](#模型) 一节以及
[docs/MODELS.md](../MODELS.md) 中的完整目录。

## 配置认证

1. **通过 Kiro CLI 认证（推荐）**：
   - 在终端里直接执行 `kiro-cli login` 完成登录。
   - 插件检测到本地 Kiro CLI 数据库后，会自动在 OpenCode 的 `auth.json` 中
     创建一个最小化的 `kiro-auth` 占位项，随后在启动时导入并同步你的活跃会话。
   - 对于 AWS IAM Identity Center（SSO/IDC），插件会从 `kiro-cli` 数据库中
     同时导入 token 和设备注册信息（OIDC 客户端凭据）。
2. **直接认证**：
   - 执行 `opencode auth login`。
   - 选择 `Other`，输入 `kiro-auth`，回车确认。
   - 系统会要求输入 **IAM Identity Center Start URL** 和 **region**
     （`sso_region`）。留空即使用 **AWS Builder ID**；填入你公司的 Start URL
     （例如 `https://your-company.awsapps.com/start`）即使用 **IAM Identity
     Center（SSO）**。
   - 注意：目前 TUI 的 `/connect` 流程**不会**触发插件的 OAuth 提示
     （Start URL / region），因此 Identity Center 登录可能会回退到 Builder
     ID，除非使用 `opencode auth login`（或在 `~/.config/opencode/kiro.json`
     中预先配置默认值）。
   - 使用 **IAM Identity Center** 时，你可能还需要一个 **profile ARN**
     （`profileArn`）——如果本地装有 `kiro-cli` 并已选择过 profile
     （`kiro-cli profile`），插件会自动检测；否则请手动设置
     `idc_profile_arn`。
   - 浏览器会直接打开 AWS 的验证 URL（无需本地认证服务器）。如果没有自动打开，
     请手动复制该 URL 并输入 OpenCode 打印的验证码。
3. 配置信息会自动管理在 `~/.config/opencode/kiro.db` 中。

## 插件配置

插件级行为（认证同步、账号选择策略、重试限制、effort 映射）位于
`~/.config/opencode/kiro.json`。完整示例和全部选项见
[docs/CONFIGURATION.md](../CONFIGURATION.md)。

## 多账号与轮换

你可以注册多个 Kiro 账号，让插件在这些账号之间分配请求，从而合并额度并获得
自动故障切换能力。

**添加账号**，有两种方式：

1. 执行 `opencode auth login`，选择 `kiro-auth`，完成一次 Builder ID 或
   IAM Identity Center 登录。每个账号只需执行一次——每个不同的 AWS 身份都会
   单独存入 `kiro.db`。对同一身份重新登录会原地更新；用不同身份登录则会新增
   一个账号。
2. 从 Kiro CLI 自动同步：当 `auto_sync_kiro_cli: true`（默认值）时，插件会
   从本地 `kiro-cli` 数据库导入凭据。通过 `kiro-cli login` 在 `kiro-cli`
   中切换或新增账号后会自动流入插件，无需额外操作。

**轮换策略** —— 在 `~/.config/opencode/kiro.json` 中设置
`account_selection_strategy`：

| 策略           | 行为                                                       | 默认值 |
| -------------- | ------------------------------------------------------------ | ------ |
| `lowest-usage` | 每次请求都选择剩余额度最低的健康账号                        | ✅     |
| `round-robin`  | 按顺序依次轮流使用各账号                                     |        |
| `sticky`       | 始终使用第一个账号；仅当该账号变为不健康时才切换             |        |

**自动故障切换**无需任何配置：被限流或返回 403 的账号会被标记为不健康，插件
会自动切换到下一个健康账号。如果所有账号都被限流，插件会等待最短的重置时间
后重试。连续 10 次选择失败会触发熔断，避免死循环。

**移除账号**：执行 `opencode auth login`，选择 `kiro-auth`，选择
"Remove a Kiro account (N stored)"，然后在下拉列表中选中要移除的账号（或选
Cancel 取消）。

完整配置项参考见 [docs/CONFIGURATION.md](../CONFIGURATION.md)。

## 用量显示

插件会从 Kiro 的用量接口读取真实额度（每个账号的 `usedCount`/`limitCount`，
例如 `929/10000`），并在三处展示：

1. **认证菜单标签**——执行 `opencode auth login` 并选择 `kiro-auth` 时，第
   一个登录方式会显示 `[current: <email> <used>/<limit> (<pct>%)]`；有多个
   账号时用 ` · ` 连接，最多显示 3 个，超出部分显示为 `+N more`。
2. **启动 Toast**——每次插件初始化后，OpenCode 启动几秒后会弹出一条 Toast：
   `Kiro usage (<email>): <used>/<limit> (<pct>%)`，用量 ≥90% 时变为黄色
   （`warning`）。
3. **运行时告警**——当前选中账号用量 ≥90% 时会弹出告警 Toast。

TUI 状态栏中**没有持久化的用量小组件**——用量只通过上述标签和 Toast 展示。
如果想随时查看用量，可以重启 OpenCode（触发启动 Toast），或直接查询
`kiro.db`：

```bash
python3 -c "import sqlite3;r=sqlite3.connect('$HOME/.config/opencode/kiro.db').execute('SELECT email,used_count,limit_count FROM accounts').fetchall();[print(f'{e}: {u}/{l} (left {l-u})') for e,u,l in r]"
```

## 模型

默认安装会暴露 Claude Sonnet/Opus/Haiku 以及 Kiro 代理的开放权重模型。如果要
精确指定模型列表或配置 thinking-budget 变体，可将
[docs/MODELS.md](../MODELS.md) 中的完整目录粘贴到你的
`provider.kiro-auth.models` 配置块中。

Thinking budget 会自动映射到 Kiro 原生的 `effort` 字段：

| OpenCode budget | Kiro effort |
| ---------------- | ----------- |
| `<= 10000`        | `low`       |
| `<= 20000`        | `medium`    |
| `<= 28000`        | `high`      |
| `> 28000`         | `max`       |

详情与完整 JSON 示例见 [docs/MODELS.md](../MODELS.md)。

## 故障排查

常见问题——IAM Identity Center 下的 403/AccessDeniedException、"No accounts"、
`/connect` 与 `opencode auth login` 的区别，以及 Kiro CLI OAuth 用户同步不启动
的问题——均收录在 [docs/TROUBLESHOOTING.md](../TROUBLESHOOTING.md)。

## 迁移说明

如果你正从使用 `kiro`（而不是 `kiro-auth`）作为 provider id 的旧版本升级：

- OpenCode `auth.json` 中残留的 `kiro` 键会被 OpenCode **内置**的 `kiro`
  provider（models.dev provider #91）认领，而不属于本插件。请删除或忽略该
  键——本插件现在使用并自动创建的是 `kiro-auth`。
- 任何形如 `kiro/<model>` 的配置或会话字符串都需要改为 `kiro-auth/<model>`
  （例如 `kiro/claude-sonnet-4-5` → `kiro-auth/claude-sonnet-4-5`）。

## 本地插件开发

在 `opencode.json` 或 `opencode.jsonc` 中直接指向本地仓库路径：

```json
{
  "plugin": ["/path/to/opencode-kiro-auth"]
}
```

然后构建并重启 OpenCode 以应用改动：`bun run build`。

## 开发

本项目使用 Bun。[Makefile](../../Makefile) 是本地检查的唯一权威来源，与 CI
保持一致：

```bash
make install    # bun install
make ci         # typecheck + fmt-check + test（与 CI 一致）
make build      # tsc + fix-esm-imports -> dist/
```

Agent 贡献者请参阅 [AGENTS.md](../../AGENTS.md)，其中包含代码库架构图、不可
破坏的不变量，以及 CodeGraph 辅助的工作流说明。

## 存储位置

**Linux/macOS：**

- SQLite 数据库：`~/.config/opencode/kiro.db`
- 插件配置：`~/.config/opencode/kiro.json`

**Windows：**

- SQLite 数据库：`%APPDATA%\opencode\kiro.db`
- 插件配置：`%APPDATA%\opencode\kiro.json`

## 致谢

特别感谢 [AIClient-2-API](https://github.com/justlovemaki/AIClient-2-API)
提供了 Kiro 认证逻辑与请求模式的基础实现。

## 上游同步

本包是 [tickernelz/opencode-kiro-auth](https://github.com/tickernelz/opencode-kiro-auth)
的 fork。上游的修复与改进通过 `upstream` git remote
（`https://github.com/tickernelz/opencode-kiro-auth.git`）跟踪，并按需 cherry-pick
到本 fork 中。

注意：上面致谢的 [AIClient-2-API](https://github.com/justlovemaki/AIClient-2-API)
采用 **GPLv3** 强 copyleft 许可证。由于本项目的 Kiro 认证逻辑与请求模式衍生自
该项目，为遵守 AIClient-2-API 的 copyleft 要求，本项目现已采用 **GPLv3** 许可证。

## 免责声明

本插件仅出于学习和教育目的提供。它是一个独立实现，与 Amazon Web Services
（AWS）或 Anthropic 没有任何关联、认可或支持关系。使用本插件的风险由使用者
自行承担。

欢迎提交 PR 进一步优化本插件。

## 许可证

本项目采用 GPLv3 许可证，详见 [LICENSE](../../LICENSE)。
