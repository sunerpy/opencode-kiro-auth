# Troubleshooting

See the root [README](../README.md#troubleshooting) for a one-line pointer to
this doc.

## Assistant announces a next step, then the task ends

Do not diagnose this from the assistant's wording alone. A sentence such as
"I will dispatch the next task" is plain model output unless the persisted
assistant message also contains a tool part.

For one controlled reproduction, set:

```json
{
  "diagnostic_log_level": "verbose",
  "enable_log_api_request": false
}
```

Restart every OpenCode/ACP process that may load the plugin. The diagnostic
level is read at plugin startup. Then reproduce once and inspect
`~/.config/opencode/kiro-auth-plugin/logs/plugin.log*` for:

```bash
rg -n \
  'Kiro request shape diagnostics|Kiro stream attempt started|Kiro stream request terminal|Kiro SDK event stream iteration failed' \
  ~/.config/opencode/kiro-auth-plugin/logs/plugin.log*
```

Correlate records by `diagnosticTraceId` or `sessionHash`, then compare them
with the assistant message's persisted `finish`, `error`, and part types in
OpenCode:

- `inputToolCount > 0` but `wireCurrentToolCount == 0` points to request
  conversion or current-message assembly.
- `terminalProvenance:"clean_eof"`, `sawToolIntent:false`, and zero emitted
  tools means Kiro ended cleanly without observable tool intent. The plugin
  emitted `finish_reason:"stop"` because its compatibility terminal chunk is
  synthesized from the zero tool count; this is not a native Kiro stop marker.
- `sawToolIntent:true` plus no emitted tool and an error/truncation terminal
  points to a tool stream that failed before completion/publication.
- `terminalProvenance:"upstream_error"` is a transport/Kiro stream incident,
  not a normal stop.
- No matching diagnostic trace usually means the expected plugin version or
  config was not loaded, the process was not restarted, or the request used a
  different provider.

Even `verbose` does not log prompt/reasoning text, tool names/arguments/results,
signatures, accounts, email, ARN, or raw OpenCode IDs. It does emit linkable
hashes and detailed structural telemetry, so return `diagnostic_log_level` to
`off` after collecting the incident.

For the full field dictionary, decision matrix, DB/OMO correlation steps, and
rollback criteria, see
[the session-stop diagnostics rollout plan](SESSION_STOP_DIAGNOSTICS_ROLLOUT_PLAN.md).

## Error: Status: 403 (AccessDeniedException / User is not authorized)

If you're using **IAM Identity Center** (a custom Start URL), the Q Developer /
CodeWhisperer APIs typically require a **profile ARN**.

This plugin reads the active profile ARN from your local `kiro-cli` database
(`state.key = api.codewhisperer.profile`) and sends it as `profileArn`.

Fix:

1. Run `kiro-cli profile` and select a profile (e.g. `QDevProfile-us-east-1`).
2. Retry `opencode auth login` (or restart OpenCode so it re-syncs).

## Error: No accounts

This happens when the plugin has no records in `~/.config/opencode/kiro.db`.

1. Ensure `kiro-cli login` succeeds.
2. Ensure `auto_sync_kiro_cli` is `true` in `~/.config/opencode/kiro-auth-plugin/kiro.json`.
3. Retry the request; the plugin will attempt a Kiro CLI sync when it detects zero
   accounts.

## Note: `/connect` vs `opencode auth login`

If you need to enter provider-specific values for an OAuth login (like IAM Identity
Center Start URL / region), use `opencode auth login`. The current TUI `/connect` flow
may not display plugin OAuth prompts, so it can't collect those inputs.

Note for IDC/SSO (OIDC): the plugin may temporarily create an account with a placeholder
email if it cannot fetch the real email during sync (e.g. offline).
It will replace it with the real email once usage/email lookup succeeds.

## Kiro CLI (Google/GitHub OAuth) users: plugin sync does not start

If you authenticated via `kiro-cli login` using Google or GitHub OAuth (not AWS Builder
ID or IAM Identity Center), OpenCode still needs a stored `kiro-auth` auth entry before it
will call the plugin loader.

The plugin now creates that minimal placeholder automatically when it detects the local
Kiro CLI database. Restart OpenCode after `kiro-cli login`; the loader should then run
and sync your actual tokens into `kiro.db`. The placeholder values are not used for API
calls.

If bootstrap is skipped because `auth.json` is malformed, fix the JSON first. The plugin
will not overwrite malformed auth files because they may contain other provider
credentials.

**Important:** Ensure `auto_sync_kiro_cli` is `true` in `~/.config/opencode/kiro-auth-plugin/kiro.json`
and that `kiro-cli login` succeeds.

See [docs/CONFIGURATION.md](CONFIGURATION.md) for the full option reference.
