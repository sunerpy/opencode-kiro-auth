# Configuration reference

Full `~/.config/opencode/kiro-auth-plugin/kiro.json` example and every supported option. See the
root [README](../README.md#configuration) for the short version.

## Example `kiro.json`

```json
{
  "auto_sync_kiro_cli": false,
  "account_selection_strategy": "lowest-usage",
  "distribute_across_processes": true,
  "per_request_spread": false,
  "quota_avoidance_enabled": true,
  "quota_reserve_threshold": 0.95,
  "stop_on_overage": true,
  "overage_threshold": 0,
  "default_region": "us-east-1",
  "idc_start_url": "https://your-company.awsapps.com/start",
  "idc_region": "us-east-1",
  "rate_limit_retry_delay_ms": 5000,
  "rate_limit_max_retries": 3,
  "max_request_iterations": 20,
  "sdk_response_timeout_enabled": false,
  "sdk_response_timeout_ms": 300000,
  "request_timeout_ms": 120000,
  "token_expiry_buffer_ms": 300000,
  "token_keepalive_enabled": false,
  "token_keepalive_interval_ms": 600000,
  "usage_sync_max_retries": 3,
  "usage_tracking_enabled": true,
  "auto_effort_mapping": true,
  "enable_log_api_request": false
}
```

> New default keys are backfilled into an existing `kiro.json` automatically on
> load: when the plugin adds an option in a new version, it is appended to your
> file with its default value the next time the plugin loads. Backfill is
> additive only — it never changes, reorders, or removes keys you already set,
> never rewrites a file that is already complete, and leaves an unparseable file
> untouched.

## Storage layout

The plugin config, logs, and refresh/keep-alive locks live under
`~/.config/opencode/kiro-auth-plugin/` (`%APPDATA%\opencode\kiro-auth-plugin\`
on Windows). Existing safe files are migrated automatically once, so no manual
action is needed. The SQLite database remains at `~/.config/opencode/kiro.db`
because moving a live database during an upgrade is unsafe.

## Options

- `auto_sync_kiro_cli`: Automatically sync sessions from Kiro CLI (default:
  `false`). `kiro-cli` stores only one token per auth method, so its auto-sync
  cannot represent multiple accounts and can overwrite a freshly-rotated plugin
  token with a stale one. Manual `opencode auth login` per account is the
  supported multi-account path; enable this only if you rely on `kiro-cli`.
- `account_selection_strategy`: Account rotation strategy (default: `lowest-usage`).
  See the [strategy table](#account-selection-strategy) below.
- `distribute_across_processes`: Spread simultaneously-started OpenCode
  processes across different accounts using a DB-backed atomic counter
  (default: `true`). Set to `false` to restore the old behavior where every
  process starts from the first account. See
  [Account distribution across processes](#account-distribution-across-processes)
  below.
- `per_request_spread`: Re-pick the lowest-usage account on every single
  request instead of pinning to the process's assigned account (default:
  `false`). Overrides sticky pinning from `account_selection_strategy`. See
  [Account distribution across processes](#account-distribution-across-processes)
  below.
- `quota_avoidance_enabled`: Softly avoid near-exhausted accounts when
  multiple accounts are registered (default: `true`). See
  [Quota-aware account avoidance](#quota-aware-account-avoidance) below.
- `quota_reserve_threshold`: Usage-ratio cutoff (`0`-`1`, default: `0.95`)
  above which an account is considered near-exhausted and gets soft-avoided.
  Only meaningful when `quota_avoidance_enabled` is `true`.
- `stop_on_overage`: Stop selecting accounts that have entered AWS paid
  overage (default: `true`). See [Overage protection](#overage-protection)
  below.
- `overage_threshold`: Paid-overage invocations tolerated before stopping an
  account (default: `0`, meaning stop on any overage). Only meaningful when
  `stop_on_overage` is `true`.
- `default_region`: AWS region (`us-east-1`, `us-west-2`).
- `idc_start_url`: Default IAM Identity Center Start URL (e.g.
  `https://your-company.awsapps.com/start`). Leave unset/blank to default to AWS Builder
  ID.
- `idc_region`: IAM Identity Center (SSO OIDC) region (`sso_region`). Defaults to
  `us-east-1`.
- `rate_limit_retry_delay_ms`: Delay between rate limit retries (1000-60000ms).
- `rate_limit_max_retries`: Maximum retry attempts for rate limits (0-10).
- `max_request_iterations`: Maximum loop iterations to prevent hangs (10-1000).
- `sdk_response_timeout_enabled`: Opt into a fixed deadline while waiting for
  `client.send()` to return the initial SDK response (default: `false`). It is
  disabled because a pending request is ambiguous: high-effort models can
  legitimately spend several minutes generating before their event stream is
  available, and Windows sleep or network transitions can consume a wall-clock
  deadline. Caller cancellation still aborts the SDK request and releases the
  request queue. Override with `KIRO_SDK_RESPONSE_TIMEOUT_ENABLED`.
- `sdk_response_timeout_ms`: Fixed SDK response deadline when
  `sdk_response_timeout_enabled` is `true` (30000-600000ms, default: `300000`).
  Override with `KIRO_SDK_RESPONSE_TIMEOUT_MS`.
- `request_timeout_ms`: Maximum inactivity while waiting for the next upstream
  stream event (30000-600000ms, default: `120000`). The timer is paused after an
  event arrives and while the downstream consumer is not pulling, so active
  reasoning streams and slow consumers may outlive this interval. Override with
  `KIRO_REQUEST_TIMEOUT_MS`.
- `token_expiry_buffer_ms`: Token refresh buffer time (30000-300000ms, default:
  `300000`). An access token within this window of expiry is treated as expired
  and refreshed on next use.
- `token_keepalive_enabled`: Opt-in background keep-alive that proactively
  rotates idle accounts' tokens before they expire (default: `false`).
  **Recommended for multi-account setups or accounts left idle for long
  stretches**, so a rarely-used account's token stays fresh instead of only
  refreshing on its next request. It only runs while OpenCode is running (it is
  an in-process timer, not an OS daemon) and cannot extend past the AWS IAM
  Identity Center session ceiling — an expired IdC session still requires a full
  `opencode auth login`. See [Token keep-alive](#token-keep-alive) below.
- `token_keepalive_interval_ms`: How often the keep-alive scan runs
  (60000-3600000ms, default: `600000` = 10 minutes). Only meaningful when
  `token_keepalive_enabled` is `true`.
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
- `enable_log_effort_debug`: Log each request's inbound body shape (top-level
  keys and reasoning-related fields only, no message content) and the resolved
  Kiro effort (default: `false`). Independent from `enable_log_api_request`.

## Account distribution across processes

If you run several OpenCode processes at once (multiple terminals, editor
sessions, or CI jobs), each process previously started with its own
process-local selection cursor at index 0 — so with no cross-process
coordination, every process's first pick landed on the same account, piling
all their traffic onto it while other registered accounts sat idle.

`distribute_across_processes` (default `true`) fixes this with an atomic
counter stored in the `plugin_meta` table of `kiro.db`. On startup, each
process claims the next counter value and uses it as its starting offset, so
concurrently-launched processes begin on different accounts instead of
converging on the first one. Each strategy applies that offset differently:
`sticky` does a circular scan over the stable, id-sorted account list
starting at the offset, picking the first selectable account at or after it
(wrapping around without collapsing back to index 0); `lowest-usage` uses the
offset only as a deterministic tie-breaker over that same id-sorted order,
never overriding an account with genuinely lower usage; and `round-robin`
starts its rotation cursor at the offset and cycles through the current pool
of available accounts in their existing order. If the counter can't be read
for any reason, the process falls back to offset 0 — startup is never blocked
by this. Set it to `false` to restore the old single-offset behavior.

`per_request_spread` (default `false`) is a separate, opt-in trade-off: with
it on, every request re-picks whichever account currently has the lowest
usage, rather than staying pinned to the account the process was assigned.
This maximizes spread across accounts but gives up the conversation affinity
that a pinned/sticky account provides. Leave it off unless you specifically
want per-request rebalancing over sticky conversation pinning.

An internal benchmark (4 concurrent workers × 5 requests each, real
`generateAssistantResponse` calls, `us-east-1`, `claude-opus-4-8`) puts the
trade-off in numbers. Both distribution modes reach the same throughput —
roughly 1.6× the single-account baseline (~34 s → ~21 s wall time) — because
that gain comes from spreading load off one account, not from re-picking per
request. What differs is the tail: leaving `per_request_spread` off (the
default `distribute_across_processes`-only mode) kept p95 latency lower
(~3.8 s vs ~5.7 s), while turning it on spread quota consumption more evenly
across accounts (a 10/10 split vs 15/5). So: keep it off if you care about
stable tail latency and conversation pinning; turn it on if even quota
draw-down across accounts matters more to you than p95. These are small-sample,
directional figures, not an SLA.

Both keys are additive — see the automatic backfill note above; if you
already have a `~/.config/opencode/kiro-auth-plugin/kiro.json`, these are
added with their default values the next time the plugin loads. No manual
edit is required.

## Token keep-alive

Kiro access tokens last ~1 hour and are normally refreshed on demand — the next
request that needs an expired token triggers a refresh (the same model Kiro's own
CLI uses). For a single active account that is enough. But with **multiple
accounts** the rotation strategy may leave some accounts idle for long stretches,
so an idle account's token only gets refreshed the next time it happens to be
picked — which can be much later.

Set `token_keepalive_enabled: true` to run a lightweight background scan every
`token_keepalive_interval_ms` (default 10 minutes) that proactively refreshes any
healthy account whose token is within `token_expiry_buffer_ms` of expiry. This
keeps idle-account tokens rotating so they are ready when selected.

Important properties:

- **In-process only.** The scan runs while OpenCode is running. There is no
  OS-level daemon; nothing refreshes while OpenCode is closed. This matches how
  `kiro-cli` and the Kiro IDE behave (on-demand / while-open, no background
  daemon).
- **Leader-elected.** If several OpenCode processes are open, a file lock ensures
  only one runs the scan, so accounts are not double-refreshed.
- **Bounded by the IdC session.** AWS IAM Identity Center caps the session
  (commonly 8 hours, up to 90 days for Kiro). Once that ceiling is hit even a
  valid refresh token fails and you must run `opencode auth login` again — no
  keep-alive can extend past it.
- **Default off.** Enable it explicitly; recommended for multi-account or
  long-idle setups.

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
`~/.config/opencode/kiro-auth-plugin/logs/plugin.log`. This is independent from
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
  distinct model id (model choice _is_ forwarded), not inside this plugin.

## Reasoning display

Reasoning-capable Kiro models (Claude Opus 4.x, and other reasoning-capable
Kiro models) stream their chain-of-thought through a distinct event,
separate from the final answer text. The plugin picks that event up and
surfaces it as OpenCode's own reasoning block (`reasoning_content`), shown
as "Thought: `<duration>`" plus a collapsible reasoning section above the
final reply, instead of dropping it or merging it into the visible answer.

This is separate from the `effort` setting above:

- **Reasoning is emitted by default** for reasoning models, regardless of
  `effort` or `auto_effort_mapping`.
- **`effort` only scales reasoning depth** (how much the model thinks), not
  whether reasoning is shown. Even at `low` effort, any reasoning the model
  produces still streams into the reasoning block.
- **No config needed.** There's no toggle for this — reasoning display is
  automatic for any model/request that has reasoning content to stream.

## Account selection strategy

`account_selection_strategy` controls how the plugin picks which stored Kiro
account handles the next request. It only matters once you have more than
one account registered (see the root [README](../README.md#multiple-accounts--rotation)
for how accounts are added).

| Value          | Behavior                                                                                                                                  | Default |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `lowest-usage` | Picks the healthy account with the lowest used quota on every request. Maximizes combined quota across accounts and keeps usage balanced. | ✅      |
| `round-robin`  | Cycles through healthy accounts in order, one request each.                                                                               |         |
| `sticky`       | Always uses the first account; only switches away when that account becomes unhealthy (rate-limited/403).                                 |         |

Regardless of strategy, failover is automatic: an unhealthy account is
skipped in favor of the next healthy one. If all accounts are rate-limited,
the plugin waits the minimum reset time and retries. A circuit breaker trips
after 10 consecutive selection failures.

### Example: round-robin across accounts

```json
{
  "account_selection_strategy": "round-robin",
  "token_keepalive_enabled": true,
  "usage_tracking_enabled": true,
  "usage_sync_max_retries": 3,
  "default_region": "us-east-1"
}
```

With this config, add two or more accounts via `opencode auth login` per
account, and the plugin cycles through them on each request instead of always
favoring the account with the most quota left. `token_keepalive_enabled` is
included here because round-robin can leave individual accounts idle between
turns; see [Token keep-alive](#token-keep-alive).

### Quota-aware account avoidance

`quota_avoidance_enabled` and `quota_reserve_threshold` add a soft layer on
top of `account_selection_strategy`. It only kicks in once you have **two or
more** accounts registered; with a single account it's bypassed entirely and
that account is used normally (only the usual health/rate-limit checks
apply).

With multiple accounts, the plugin splits them into two tiers on each
request: accounts whose usage ratio (`usedCount / limitCount`) is below
`quota_reserve_threshold` ("ample" tier) and accounts at or above it
("near-exhausted" tier). Whatever `account_selection_strategy` you've
configured (`sticky`, `round-robin`, or `lowest-usage`) then runs within the
ample tier first, so accounts with room are preferred before ones sitting
near their limit. Accounts with an unknown quota (`limitCount` of `0`, e.g.
`FEATURE_NOT_SUPPORTED`) are treated as having a `0` ratio and are never
avoided.

**Drain fallback:** if every account is at or above the threshold, avoidance
doesn't block requests. The plugin falls back to using the near-exhausted
tier and keeps draining remaining quota normally until an account actually
returns a real `402 Quota` error, at which point the existing hard
account-switch takes over. There's no starvation.

**This is a soft, proactive layer only.** It does not change any of the
existing hard behaviors:

- A real `402 Quota` error still hard-switches to the next account.
- A `429` rate-limit response still triggers the existing rate-limit
  handling and account switch.
- The ≥90%-usage warning toast (see [Reading usage](#reading-usage)) still
  fires the same as before.

`quota_reserve_threshold` just tells the account selector to prefer accounts
with more headroom _before_ any of those hard limits are hit.

Env overrides: `KIRO_QUOTA_AVOIDANCE_ENABLED` (boolean),
`KIRO_QUOTA_RESERVE_THRESHOLD` (number, `0`-`1`).

## Overage protection

AWS Kiro allows paid overage after the free quota is exhausted: the usage API
can return HTTP 200 with `currentOverages > 0`, and AWS bills those extra
invocations at `$0.04` per invocation. By default this plugin treats that
signal as a hard selection stop so it does not keep spending money silently.

With `stop_on_overage: true` and `overage_threshold: 0`, any account whose
latest usage sync reports paid overage is excluded from selection. If every
otherwise-usable account is blocked by overage, the plugin throws a hard-stop
error instead of sleeping or retrying. A clean account that is merely
rate-limited still takes precedence and follows the normal wait path.

To intentionally continue with paid overage, set:

```json
{
  "stop_on_overage": false
}
```

Recovery is automatic after AWS resets the monthly quota: the next successful
usage sync records `currentOverages: 0`, and the account becomes selectable
again.

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
