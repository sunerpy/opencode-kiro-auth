# opencode-kiro-auth

[简体中文](docs/readme/README.zh.md) · English

[![npm version](https://img.shields.io/npm/v/@sunerpy/opencode-kiro-auth)](https://www.npmjs.com/package/@sunerpy/opencode-kiro-auth)
[![npm downloads](https://img.shields.io/npm/dm/@sunerpy/opencode-kiro-auth)](https://www.npmjs.com/package/@sunerpy/opencode-kiro-auth)
[![codecov](https://codecov.io/gh/sunerpy/opencode-kiro-auth/branch/main/graph/badge.svg)](https://codecov.io/gh/sunerpy/opencode-kiro-auth)
[![license](https://img.shields.io/npm/l/@sunerpy/opencode-kiro-auth)](https://www.npmjs.com/package/@sunerpy/opencode-kiro-auth)

> OpenCode plugin that lets OpenCode use AWS Kiro (CodeWhisperer) as a model
> provider — Claude Sonnet, Opus, and Haiku, plus the open-weight models Kiro
> proxies (DeepSeek, GLM, MiniMax, Qwen3) — with substantial trial quotas.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Setup / Auth](#setup--auth)
- [Configuration](#configuration)
- [Multiple accounts & rotation](#multiple-accounts--rotation)
- [Usage display](#usage-display)
- [Models](#models)
- [Troubleshooting](#troubleshooting)
- [Migration](#migration)
- [Local plugin development](#local-plugin-development)
- [Development](#development)
- [Storage](#storage)
- [Acknowledgements](#acknowledgements)
- [Upstream sync](#upstream-sync)
- [Disclaimer](#disclaimer)
- [License](#license)

## Features

- **Multiple auth methods**: AWS Builder ID (IDC), IAM Identity Center (custom
  Start URL), and Kiro Desktop (CLI-based) authentication.
- **Auto-sync Kiro CLI**: automatically imports and synchronizes active
  sessions from your local `kiro-cli` SQLite database.
- **Gradual context truncation**: intelligently prevents error 400 by reducing
  context size dynamically during retries.
- **Intelligent account rotation**: prioritizes multi-account usage based on
  lowest available quota.
- **High-performance storage**: efficient account and usage management using
  native Bun SQLite.
- **Native thinking mode**: full support for Claude reasoning capabilities via
  virtual model mappings.
- **Kiro effort mapping**: maps OpenCode thinking budgets to Kiro's native
  effort levels automatically.
- **Automated recovery**: exponential backoff for rate limits and automated
  token refresh.

## Installation

Add the plugin to your `opencode.json` or `opencode.jsonc`:

```json
{
  "plugin": ["@sunerpy/opencode-kiro-auth"]
}
```

That alone registers the `kiro-auth` provider with a default model set. To
customize which models are exposed (including thinking variants), see
[Models](#models) and the full catalog in
[docs/MODELS.md](docs/MODELS.md).

## Setup / Auth

1. **Authentication via Kiro CLI (recommended)**:
   - Log in directly in your terminal with `kiro-cli login`.
   - The plugin automatically bootstraps a minimal `kiro-auth` placeholder in
     OpenCode's `auth.json` when it detects the Kiro CLI database, then
     imports and synchronizes your active session on startup.
   - For AWS IAM Identity Center (SSO/IDC), the plugin imports both the token
     and device registration (OIDC client credentials) from the `kiro-cli`
     database.
2. **Direct authentication**:
   - Run `opencode auth login`.
   - Select `Other`, type `kiro-auth`, and press enter.
   - You'll be prompted for your **IAM Identity Center Start URL** and
     **region** (`sso_region`). Leave it blank for **AWS Builder ID**, or
     enter your company's Start URL (e.g.
     `https://your-company.awsapps.com/start`) for **IAM Identity Center
     (SSO)**.
   - Note: the TUI `/connect` flow does **not** currently run plugin OAuth
     prompts (Start URL / region), so Identity Center logins may fall back to
     Builder ID unless you use `opencode auth login` (or preconfigure
     defaults in `~/.config/opencode/kiro.json`).
   - For **IAM Identity Center**, you may also need a **profile ARN**
     (`profileArn`) — auto-detected from `kiro-cli profile` if available, or
     set `idc_profile_arn` manually.
   - A browser window opens directly to AWS's verification URL (no local auth
     server). If it doesn't, copy/paste the URL and enter the code OpenCode
     prints.
3. Configuration is automatically managed at `~/.config/opencode/kiro.db`.

## Configuration

Plugin-wide behavior (auth sync, account selection, retry limits, effort
mapping) lives in `~/.config/opencode/kiro.json`. See
[docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the full example and every
option.

New default keys are backfilled into an existing `kiro.json` automatically when
the plugin loads (additive only — your existing values are never changed). For
multi-account or long-idle setups, enable
[token keep-alive](docs/CONFIGURATION.md#token-keep-alive)
(`token_keepalive_enabled: true`) to keep idle accounts' tokens fresh while
OpenCode is running.

Paid-overage protection is on by default; see
[Overage protection](docs/CONFIGURATION.md#overage-protection) before disabling
`stop_on_overage`.

## Multiple accounts & rotation

You can register more than one Kiro account and let the plugin spread
requests across them for combined quota and automatic failover.

**Adding accounts**, two ways:

1. Run `opencode auth login`, select `kiro-auth`, and complete a Builder ID
   or IAM Identity Center login. Run this once per account — each distinct
   AWS identity is stored separately in `kiro.db`. Re-running login for the
   same identity updates it in place; logging in with a different identity
   adds a new account.
2. Auto-sync from Kiro CLI: with `auto_sync_kiro_cli: true` (opt-in, default
   `false`), the plugin imports credentials from your local `kiro-cli`
   database. Note `kiro-cli` stores only one token per auth method, so it
   cannot represent multiple accounts — manual `opencode auth login` per
   account (option 1) is the supported multi-account path.

**Rotation strategy** — set `account_selection_strategy` in
`~/.config/opencode/kiro.json`:

| Strategy       | Behavior                                                            | Default |
| -------------- | -------------------------------------------------------------------- | ------- |
| `lowest-usage` | Each request picks the healthy account with the lowest used quota    | ✅      |
| `round-robin`  | Cycles through accounts in order                                     |         |
| `sticky`       | Always uses the first account; switches only when it becomes unhealthy |       |

**Automatic failover** requires no configuration: a rate-limited or 403
account is marked unhealthy and the next healthy account takes over. If every
account is rate-limited, the plugin waits out the minimum reset time and
retries. A circuit breaker trips after 10 consecutive selection failures to
avoid a hot loop.

**Removing an account**: run `opencode auth login`, select `kiro-auth`,
choose "Remove a Kiro account (N stored)", then pick the account from the
dropdown (or cancel).

> **Note:** removal is persistent. Once you remove an account it stays
> removed across restarts and Kiro CLI auto-sync — it won't come back on its
> own. To re-add it, just log in with that account again via
> `opencode auth login`. See
> [Removing accounts & the removal tombstone](docs/CONFIGURATION.md#removing-accounts--the-removal-tombstone)
> for how this works.

Full config key reference: [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Usage display

The plugin reads real quota from Kiro's usage API (`usedCount`/`limitCount`
per account, e.g. `929/10000`) and surfaces it in three places:

1. **Auth menu label** — running `opencode auth login` and selecting
   `kiro-auth` shows `[current: <email> <used>/<limit> (<pct>%)]` on the
   first login method; with multiple accounts they're joined with ` · `,
   capped at 3 with a `+N more` suffix.
2. **Startup toast** — once per plugin init, a toast shows
   `Kiro usage (<email>): <used>/<limit> (<pct>%)` a few seconds after
   OpenCode starts, turning yellow (`warning`) at ≥90% usage.
3. **Runtime warning** — a warning toast fires whenever a selected account
   is at ≥90% usage.

There is **no persistent usage widget** in the TUI status bar — usage only
shows up via the label and toasts above. To check usage at any time, either
restart OpenCode (triggers the startup toast) or query `kiro.db` directly:

```bash
python3 -c "import sqlite3;r=sqlite3.connect('$HOME/.config/opencode/kiro.db').execute('SELECT email,used_count,limit_count FROM accounts').fetchall();[print(f'{e}: {u}/{l} (left {l-u})') for e,u,l in r]"
```

## Models

The default install exposes Claude Sonnet/Opus/Haiku plus the open-weight
models Kiro proxies. To pin an exact model list or configure thinking-budget
variants, paste the full catalog from [docs/MODELS.md](docs/MODELS.md) into
your `provider.kiro-auth.models` block.

Thinking budgets map to Kiro's native `effort` field automatically:

| OpenCode budget | Kiro effort |
| ---------------- | ----------- |
| `<= 10000`        | `low`       |
| `<= 20000`        | `medium`    |
| `<= 28000`        | `high`      |
| `> 28000`         | `max`       |

Details and the full JSON example: [docs/MODELS.md](docs/MODELS.md).

> **Note:** OpenCode's per-agent thinking level (`--variant` / an agent's
> `variant` in `oh-my-openagent.json`) isn't honored per agent by this
> plugin — OpenCode consumes it upstream. Use the global `effort` key in
> `kiro.json` instead. See
> [Reasoning effort](docs/CONFIGURATION.md#reasoning-effort) for details.

> **Note:** Reasoning-capable Kiro models (Claude Opus 4.x and other
> reasoning-capable models) stream their chain-of-thought as a separate
> event, which the plugin surfaces as OpenCode's own reasoning block — shown
> as "Thought: `<duration>`" above the final reply. No config needed. See
> [Reasoning display](docs/CONFIGURATION.md#reasoning-display) for details.

> **Note:** Per-request thinking level via model variants — pick
> `kiro-auth/claude-opus-4-8-xhigh` (or similar) straight from the model
> list to pin an explicit Kiro effort level for that model, no `kiro.json`
> edit needed. Base models like `claude-opus-4-8` remain available and keep
> using the global `effort` setting. See [docs/VARIANTS.md](docs/VARIANTS.md)
> for the full variant list and why they exist.

## Troubleshooting

Common issues — 403/AccessDeniedException with IAM Identity Center, "No
accounts", `/connect` vs `opencode auth login`, and Kiro CLI OAuth users whose
sync doesn't start — are covered in
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Migration

If you're upgrading from a version that used the provider id `kiro` instead of
`kiro-auth`:

- A stale `kiro` key in OpenCode's `auth.json` will be claimed by OpenCode's
  **built-in** `kiro` provider (models.dev provider #91), not this plugin.
  Remove or ignore that key — this plugin now bootstraps and uses `kiro-auth`.
- Any config or session string of the form `kiro/<model>` must become
  `kiro-auth/<model>` (e.g. `kiro/claude-sonnet-4-5` →
  `kiro-auth/claude-sonnet-4-5`).

## Local plugin development

Point OpenCode directly at your local repo path in `opencode.json` or
`opencode.jsonc`:

```json
{
  "plugin": ["/path/to/opencode-kiro-auth"]
}
```

Then build and restart OpenCode to pick up changes: `bun run build`.

## Development

This project uses Bun. The [Makefile](Makefile) is the single source of truth
for local checks and mirrors CI:

```bash
make install    # bun install
make ci         # typecheck + fmt-check + test (what CI runs)
make build      # tsc + fix-esm-imports -> dist/
```

Agent contributors: see [AGENTS.md](AGENTS.md) for the codebase architecture
map, invariants that must not break, and the CodeGraph-assisted workflow.

### Releasing

Releases are automated with
[release-please](https://github.com/googleapis/release-please):

- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit
  messages and pull request titles (`feat:`, `fix:`, `chore:`, …) — these drive
  the next version bump automatically.
- release-please opens and maintains a release pull request on `main`.
  **Merging that PR** cuts the git tag + GitHub Release and triggers the
  workflow that runs typecheck/test/build and then publishes to npm.
- Contributors never hand-edit the version in `package.json` or the files under
  [`changelog/`](changelog/) — release-please maintains both.

## Storage

**Linux/macOS:**

- SQLite database: `~/.config/opencode/kiro.db`
- Plugin config: `~/.config/opencode/kiro.json`

**Windows:**

- SQLite database: `%APPDATA%\opencode\kiro.db`
- Plugin config: `%APPDATA%\opencode\kiro.json`

## Acknowledgements

Special thanks to [AIClient-2-API](https://github.com/justlovemaki/AIClient-2-API)
for providing the foundational Kiro authentication logic and request patterns.

## Upstream sync

This package is a fork of
[tickernelz/opencode-kiro-auth](https://github.com/tickernelz/opencode-kiro-auth).
Upstream fixes and improvements are tracked via the `upstream` git remote
(`https://github.com/tickernelz/opencode-kiro-auth.git`) and cherry-picked into
this fork as needed.

Note: [AIClient-2-API](https://github.com/justlovemaki/AIClient-2-API) (credited
above) is licensed under **GPLv3**, a strong copyleft license. Because this
project's Kiro authentication logic and request patterns are derived from it,
this project is now licensed under **GPLv3** as well, to comply with
AIClient-2-API's copyleft requirements.

## Disclaimer

This plugin is provided strictly for learning and educational purposes.
It is an independent implementation and is not affiliated with, endorsed by,
or supported by Amazon Web Services (AWS) or Anthropic.
Use of this plugin is at your own risk.

Feel free to open a PR to optimize this plugin further.

## License

GPL-3.0-or-later, see [LICENSE](LICENSE)
