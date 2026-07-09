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
