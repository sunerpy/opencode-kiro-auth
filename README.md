# opencode-kiro-auth

[简体中文](docs/readme/README.zh.md) · English

[![npm version](https://img.shields.io/npm/v/@sunerpy/opencode-kiro-auth)](https://www.npmjs.com/package/@sunerpy/opencode-kiro-auth)
[![npm downloads](https://img.shields.io/npm/dm/@sunerpy/opencode-kiro-auth)](https://www.npmjs.com/package/@sunerpy/opencode-kiro-auth)
[![license](https://img.shields.io/npm/l/@sunerpy/opencode-kiro-auth)](https://www.npmjs.com/package/@sunerpy/opencode-kiro-auth)

> OpenCode plugin that lets OpenCode use AWS Kiro (CodeWhisperer) as a model
> provider — Claude Sonnet, Opus, and Haiku, plus the open-weight models Kiro
> proxies (DeepSeek, GLM, MiniMax, Qwen3) — with substantial trial quotas.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Setup / Auth](#setup--auth)
- [Configuration](#configuration)
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
