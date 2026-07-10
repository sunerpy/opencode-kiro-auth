# Configuration reference

Full `~/.config/opencode/kiro.json` example and every supported option. See the
root [README](../README.md#configuration) for the short version.

## Example `kiro.json`

```json
{
  "auto_sync_kiro_cli": true,
  "account_selection_strategy": "lowest-usage",
  "default_region": "us-east-1",
  "idc_start_url": "https://your-company.awsapps.com/start",
  "idc_region": "us-east-1",
  "rate_limit_retry_delay_ms": 5000,
  "rate_limit_max_retries": 3,
  "max_request_iterations": 20,
  "request_timeout_ms": 120000,
  "token_expiry_buffer_ms": 120000,
  "usage_sync_max_retries": 3,
  "usage_tracking_enabled": true,
  "auto_effort_mapping": true,
  "enable_log_api_request": false
}
```

## Options

- `auto_sync_kiro_cli`: Automatically sync sessions from Kiro CLI (default: `true`).
- `account_selection_strategy`: Account rotation strategy (default: `lowest-usage`).
  See the [strategy table](#account-selection-strategy) below.
- `default_region`: AWS region (`us-east-1`, `us-west-2`).
- `idc_start_url`: Default IAM Identity Center Start URL (e.g.
  `https://your-company.awsapps.com/start`). Leave unset/blank to default to AWS Builder
  ID.
- `idc_region`: IAM Identity Center (SSO OIDC) region (`sso_region`). Defaults to
  `us-east-1`.
- `rate_limit_retry_delay_ms`: Delay between rate limit retries (1000-60000ms).
- `rate_limit_max_retries`: Maximum retry attempts for rate limits (0-10).
- `max_request_iterations`: Maximum loop iterations to prevent hangs (10-1000).
- `request_timeout_ms`: Request timeout in milliseconds (60000-600000ms).
- `token_expiry_buffer_ms`: Token refresh buffer time (30000-300000ms).
- `usage_sync_max_retries`: Retry attempts for usage sync (0-5, default: `3`).
- `auth_server_port_start`: Legacy/ignored (no local auth server).
- `auth_server_port_range`: Legacy/ignored (no local auth server).
- `usage_tracking_enabled`: Enable usage tracking and toast notifications
  (default: `true`). When enabled, the plugin refreshes each account's used
  quota into `kiro.db` after requests (60s cooldown per account) and shows
  the auth-menu label, startup toast, and ≥90% warning toast described in
  [Reading usage](#reading-usage) below.
- `auto_effort_mapping`: Automatically map OpenCode thinking budgets to Kiro effort
  levels for supported models (default: `true`). See [docs/MODELS.md](MODELS.md)
  for the budget-to-effort table.
- `enable_log_api_request`: Enable detailed API request logging.

## Reasoning effort

Kiro's reasoning depth is controlled by a global `effort` setting in
`kiro.json`, not by OpenCode's per-agent thinking level. Read the
[limitation](#limitation-per-agent-thinking-level-isnt-honored) below before
trying to give different agents different reasoning depths.

- `effort` (`low | medium | high | xhigh | max`, optional): sets Kiro's
  reasoning effort for every request sent through the plugin. Leave it unset
  to fall back to automatic budget-based mapping (below), or `medium` for
  thinking-enabled requests with no budget set.
- `auto_effort_mapping` (default `true`): when `effort` isn't set, this maps
  OpenCode's thinking budget (`thinkingConfig.thinkingBudget` on a
  `-thinking` model variant) to a Kiro effort level automatically. See the
  budget table in
  [docs/MODELS.md](MODELS.md#thinking-effort-configuration). Set to `false`
  to disable the mapping and always fall back to `medium` unless `effort` is
  explicit.

### Which models support effort

Effort only changes behavior on effort-capable models:

- `claude-opus-4-5`, `claude-opus-4-6`, `claude-opus-4-6-1m`
- `claude-sonnet-4-5`, `claude-sonnet-4-5-1m`, `claude-sonnet-4-6`,
  `claude-sonnet-4-6-1m`
- `claude-opus-4-7`, `claude-opus-4-8`

`xhigh` is only honored on `claude-opus-4-7` and `claude-opus-4-8`; on every
other effort-capable model it's clamped down to `max`. Any model outside
this list (Haiku, the open-weight models, etc.) ignores `effort` entirely.

### `-thinking` model ids

Model ids ending in `-thinking` (e.g. `claude-opus-4-8-thinking`) trigger
Kiro's reasoning mode directly, independent of the global `effort` key.
Their `thinkingConfig.thinkingBudget` variant maps to an effort level
through the same budget table (default `medium` when no budget is set). See
[docs/MODELS.md](MODELS.md) for the full variant catalog.

### Debugging effort resolution

Set `enable_log_effort_debug` (default `false`) to log each request's
inbound body shape (top-level keys and reasoning-related fields only, never
message content) plus the effort level the plugin resolved, to
`~/.config/opencode/kiro-logs/plugin.log`. This is independent from
`enable_log_api_request`.

### Limitation: per-agent thinking level isn't honored

OpenCode lets you set a thinking/reasoning level per agent, either with
`--variant high|low|max` on the CLI or a per-agent `variant` in
`oh-my-openagent.json`. **This plugin cannot see that setting.** Capturing
real inbound request bodies with `--variant high` and `--variant low`
produced byte-identical payloads: a plain OpenAI-style
`{model, max_tokens, messages, ...}` body with no `reasoningEffort`,
`reasoning`, or `thinkingConfig` field anywhere. OpenCode's orchestration
layer consumes the variant upstream and never forwards it to this plugin's
custom `fetch`.

In practice:

- You can't give different agents different Kiro effort levels through
  OpenCode's per-agent variant mechanism.
- Use the global `effort` key in `kiro.json` (applies to every request
  across every agent), or pin an agent to a `-thinking` model id with an
  explicit budget in `provider.kiro-auth.models`, to control effort.
- Genuinely per-agent effort would need to be implemented at the
  OpenCode/omo orchestration layer, for example by mapping each agent to a
  distinct model id (model choice *is* forwarded), not inside this plugin.

## Account selection strategy

`account_selection_strategy` controls how the plugin picks which stored Kiro
account handles the next request. It only matters once you have more than
one account registered (see the root [README](../README.md#multiple-accounts--rotation)
for how accounts are added).

| Value          | Behavior                                                                | Default |
| -------------- | ------------------------------------------------------------------------ | ------- |
| `lowest-usage` | Picks the healthy account with the lowest used quota on every request. Maximizes combined quota across accounts and keeps usage balanced. | ✅ |
| `round-robin`  | Cycles through healthy accounts in order, one request each.              |         |
| `sticky`       | Always uses the first account; only switches away when that account becomes unhealthy (rate-limited/403). |         |

Regardless of strategy, failover is automatic: an unhealthy account is
skipped in favor of the next healthy one. If all accounts are rate-limited,
the plugin waits the minimum reset time and retries. A circuit breaker trips
after 10 consecutive selection failures.

### Example: round-robin across accounts

```json
{
  "account_selection_strategy": "round-robin",
  "auto_sync_kiro_cli": true,
  "usage_tracking_enabled": true,
  "usage_sync_max_retries": 3,
  "default_region": "us-east-1"
}
```

With this config, add two or more accounts (via `opencode auth login` per
account, or by switching accounts in `kiro-cli`), and the plugin cycles
through them on each request instead of always favoring the account with
the most quota left.

## Removing accounts & the removal tombstone

Removing an account (`opencode auth login` → `kiro-auth` → "Remove a Kiro
account (N stored)" → pick one) deletes it from `kiro.db` and records its
account id in a `removed_accounts` table — a tombstone.

That tombstone matters because of `auto_sync_kiro_cli`. With auto-sync on
(the default), the plugin re-scans your local `kiro-cli` database on every
auth init and imports whatever sessions it finds there. Before the
tombstone existed, this meant a removed account would simply get re-imported
on the next startup if it was still present in `kiro-cli`'s own store — the
exact bug reported with recurring `idc-placeholder+...@awsapps.local`
accounts. Now `syncFromKiroCli` checks the tombstone first and skips any
account id it lists, so:

- **`auto_sync_kiro_cli: true` will not revive a removed account.** Once
  removed, it stays removed across restarts and every subsequent sync, no
  matter how many times auto-sync runs.
- **Re-login clears the tombstone.** If you deliberately want that account
  back, run `opencode auth login` and log in with it again (Builder ID or
  IAM Identity Center, matching the identity you removed). That login clears
  the tombstone entry and the account is stored normally again — auto-sync
  will also pick it up from `kiro-cli` afterward if it's still there.
- **This only affects this plugin's own `kiro.db`.** Removing an account
  here does **not** touch `kiro-cli`'s own credential store
  (`data.sqlite3`). If you also want `kiro-cli` itself to forget that
  identity, log it out there directly (`kiro-cli logout` or equivalent) —
  that's a separate, unrelated store from this plugin's tombstone.

## Reading usage

The plugin surfaces live usage (`usedCount`/`limitCount` per account) in the
`opencode auth login` menu label, a startup toast, and a ≥90%-usage warning
toast — see the root [README](../README.md#usage-display) for details. There
is no persistent status-bar widget. To check usage at any time without
restarting OpenCode, query `kiro.db` directly:

```bash
python3 -c "import sqlite3;r=sqlite3.connect('$HOME/.config/opencode/kiro.db').execute('SELECT email,used_count,limit_count FROM accounts').fetchall();[print(f'{e}: {u}/{l} (left {l-u})') for e,u,l in r]"
```

On Windows, replace the path with `%APPDATA%\opencode\kiro.db`.
