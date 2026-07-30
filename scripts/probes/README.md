# `scripts/probes/`

Diagnostic probes that talk to the **real** AWS Kiro (CodeWhisperer)
`generateAssistantResponse` endpoint. They exist to make the empirical claims in
`.omo/plans/reasoning-signature-roundtrip.md` independently reproducible instead of
resting on a table in a document.

> **These probes spend real request quota.** A default `ab-reasoning-probe` run costs
> **10 requests** (`(TURNS + 1) * 2`). Read [Quota reality](#quota-reality) before running.

---

## `ab-reasoning-probe.ts`

### What it measures

Whether replaying **signed reasoning** in `conversationState.history` keeps the model
_reasoning_ on later tool-loop turns — the single measurement that justifies the whole
reasoning-signature-roundtrip project (plan §3.1).

Two arms walk the same 4-step dependent tool chain (`17 → ×23 → +149 → ÷6 = 90`):

| Arm   | History contains                                                                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | every prior assistant turn carries the nested wire form `reasoningContent:{reasoningText:{text,signature}}`, using the signature genuinely captured from that turn's **own** response |
| **B** | no `reasoningContent` at all (the plugin's pre-Wave-5 behavior)                                                                                                                       |

Prompts, tool specs, tool results, model, effort, region and the `conversationId`
strategy are identical between arms. **Tool results are canned by turn index**, not by
what the model asked for, so the arms cannot diverge on content. `ORDER=BA` reverses arm
order to rule out ordering effects.

The dependent variables are `reasoningContentEvent` **frame count per turn**, reasoning
character count, whether a signature was emitted, and whether the model completed all
four steps and stated `90`.

### Invocation

Free dry run — builds and prints both arms' wire payloads, makes **zero** API calls and
spends **zero** quota. Always start here:

```bash
DRY=1 bun run scripts/probes/ab-reasoning-probe.ts
```

Real run. `CONFIRM=1` is **mandatory**; without it the probe refuses and exits `2`:

```bash
KIRO_PROBE_ACCOUNT='you@example.com' CONFIRM=1 \
  bun run scripts/probes/ab-reasoning-probe.ts
```

Reversed arm order (the second half of the original A/B, BA design):

```bash
KIRO_PROBE_ACCOUNT='you@example.com' CONFIRM=1 ORDER=BA \
  bun run scripts/probes/ab-reasoning-probe.ts
```

### Environment

| Variable             | Default                  | Meaning                                                                     |
| -------------------- | ------------------------ | --------------------------------------------------------------------------- |
| `CONFIRM`            | unset                    | Must be `1` for any real API call. Guard against accidental quota burn.     |
| `DRY`                | unset                    | `1` builds payloads and prints wire shapes only. No API calls, no quota.    |
| `ORDER`              | `AB`                     | `BA` runs arm B first.                                                      |
| `TURNS`              | `4`                      | Continuation turns after the opening turn. Total cost is `(TURNS + 1) * 2`. |
| `KIRO_PROBE_ACCOUNT` | unset                    | Pin a specific account by email. **Strongly recommended** — see below.      |
| `OUT_DIR`            | `scripts/probes/results` | Where the raw result JSON is written.                                       |
| `XDG_CONFIG_HOME`    | `~/.config`              | Where `opencode/kiro.db` is found.                                          |

### Prerequisites

- `bun install` in the repo root.
- A local `kiro.db` (`$XDG_CONFIG_HOME/opencode/kiro.db`, or
  `%APPDATA%\opencode\kiro.db` on Windows) containing at least one authenticated
  account. The probe opens it **read-only** and never writes to it.
- A **non-expired** access token. The probe does not refresh tokens: if the selected
  account's token expires within 2 minutes it exits `1` and tells you to start OpenCode
  once to refresh. This keeps the probe out of the refresh-lock path entirely.
- Credentials are never embedded in this file. They are read from `kiro.db` at runtime.

### Account selection and quota reality

With `KIRO_PROBE_ACCOUNT` set, the probe uses exactly that account. Without it, it
auto-selects the healthy account with the **largest** remaining headroom. In either case
it refuses to run when `limit_count - used_count < plannedCalls`.

<a id="quota-reality"></a>
As measured on the maintainer's machine at the time this probe was committed:
**17 accounts stored, 15 of them already at or over quota; only two had headroom —
about 500 and about 293 remaining calls.** Always pass `KIRO_PROBE_ACCOUNT` so the run
lands on one of the accounts that actually has room, rather than trusting auto-selection.

### Output

Human-readable progress goes to stdout: a per-turn line, a per-turn table, per-arm
aggregates, any signature rejection, the final text per arm, the real call count, and
usage before/after.

Machine-readable raw results are written to
`scripts/probes/results/ab-reasoning-<ISO timestamp>-<ORDER>[-dry].json`:

```jsonc
{
  "schemaVersion": 1,
  "probe": "ab-reasoning-probe",
  "finishedAt": "2026-07-30T02-47-35-450Z",
  "dry": false,
  "order": "AB",
  "model": "claude-opus-5",
  "effort": "high",
  "region": "us-east-1",
  "turnsConfigured": 4,
  "account": { "masked": "us****@example.com", "headroomBefore": 500 },
  "usage": { "before": 12, "after": 22 },
  "realApiCalls": 10,
  "arms": {
    "A": { "turns": [/* TurnObs[] */], "sigInvalid": null, "strippedRetryAt": null },
    "B": { "turns": [/* TurnObs[] */] }
  }
}
```

Each `TurnObs` records `turn`, `http`, `reasoningFrames`, `reasoningTextFrames`,
`reasoningSigFrames`, `reasoningChars`, `signaturePresent`, `signatureLen`,
`signatureFingerprint`, `toolKeys`, `textChars`, `text`, `latencyMs`,
`historyReasoningTurns`, `requestId`, and on failure `errorName` / `errorMessage`.

**Commit the result JSON** next to this README so the run stops being ephemeral.

### Interpreting the output

- **The signal is collapse frequency and task completion, not a smooth per-turn
  increase.** Look for turns where `reasoningFrames` drops to `0` with no signature, and
  for whether the arm reaches `CORRECT(90)`.
- `historyReasoningTurns` is arm A's self-check: it must grow with each turn. If it stays
  `0` in arm A, the replay is not actually being sent and the run is void.
- A 400 whose message matches `THINKING_SIGNATURE_INVALID` or `signature` makes arm A
  strip history reasoning once and retry that turn; `sigInvalid` and `strippedRetryAt`
  record it. That path was **never** triggered across the original 19 calls.
- `usage.after - usage.before` should equal `realApiCalls`. Replay costs no extra quota;
  if the delta exceeds the call count, something else was using the account.

### Sanitization guarantees

The probe is committed sanitized and enforces it at runtime:

- No token, refresh token, `profileArn` or email is embedded anywhere in the file.
- Emails are masked (`us****@example.com`) on **every** output path.
- The `DRY=1` wire dump is meant to be pasteable into an issue, so it masks the account's
  `profileArn` (`arn:<redacted>/DM**********`) and elides the signature and the signed
  reasoning text. The earlier throwaway version printed the ARN in full.
- Signatures are reduced to `length + sha256Prefix` via
  `describeSignatureForLog` from `src/plugin/log-redaction.ts` — the same §6.8 helper the
  plugin's log sinks use. The earlier throwaway version printed the first and last 8
  characters of the real signature; that was removed.
- Before writing the result JSON the probe re-scans the serialized output and **throws**
  if it contains the unmasked email, either token, the `profileArn`, or any signature it
  observed during the run.

---

## Historical baseline (plan §3.1) — raw output was LOST

The numbers below are the plan's §3.1 table, reproduced here as the historical baseline.

**They are not reproducible artifacts.** They come from two runs made **before Wave 5**
with an earlier, throwaway version of this probe that lived in
`/tmp/opencode/kiro-probe/ab-reasoning-probe.ts`. That directory was volatile: when this
evidence was collected for the repo, **only the four `.ts` probe sources survived — every
raw result JSON was gone.** The original raw output cannot be recovered, and it has
deliberately **not** been reconstructed, back-filled or regenerated from the table.

Two runs against the real `generateAssistantResponse`, model `claude-opus-5`, effort
`high`, `us-east-1`. 19 real calls total. Run order was reversed between runs (AB, then
BA).

Reasoning frames emitted per turn:

| turn    | Run 1 A | Run 1 B | Run 2 A | Run 2 B            |
| ------- | ------- | ------- | ------- | ------------------ |
| 0       | 13      | 15      | 7       | 8                  |
| 1       | 9       | 10      | 10      | 10                 |
| **2**   | **7**   | **0**   | **6**   | **0**              |
| 3       | 9       | 14      | 9       | **0**              |
| 4       | 18      | 9       | 18      | —                  |
| outcome | correct | correct | correct | **abandoned task** |

- Reasoning collapse (0 frames, no signature) occurred **only in arm B**, and in **both
  runs at turn 2** — the same position.
- Run 2 arm B is the decisive cell: after collapsing, the model deviated from
  instructions, skipped step 4, emitted 22 characters and never produced the answer.
- Arm A had reasoning in 5/5 turns. Arm B had none in 1/5 (run 1) and 2/4 (run 2).
- Honest limits: at run 1 turn 3, arm B actually exceeded arm A (14 vs 9 frames). Two
  runs is a small sample and the effect is qualitative.

Also from those runs, and likewise not backed by surviving raw JSON: genuine signature
lengths observed **304–560 characters**, and `redactedContent` was **never** emitted.

**What "closing the gap" means from here.** The committed baseline is this table plus
whatever a fresh re-run of the committed probe produces. A re-run's raw JSON should be
committed under `scripts/probes/results/` and compared against the table above
qualitatively (does arm B collapse, does arm A complete the task), not numerically.

---

## Independent implementations (plan §3.3)

Third-party Kiro proxies that already round-trip the signature:

- **`SunNorthGod/kiro2cc-proxy`** (Rust), commit
  [`4bedabf`](https://github.com/SunNorthGod/kiro2cc-proxy/commit/4bedabf) — identifies
  dropping history `reasoningContent{reasoningText:{text,signature}}` as the root cause
  of "direct Kiro thinks on tool turns, plugin does not".
- **`SunNorthGod/kiro2cc-proxy`**, commit
  [`7becf73`](https://github.com/SunNorthGod/kiro2cc-proxy/commit/7becf73) — a
  user-reported regression from gating replay too narrowly: dropping thinking from
  completed text-only turns made the model reason more shallowly on later turns.
- **`YorrickBao/kiro-anthropic`** (Go), commit
  [`ca0c995`](https://github.com/YorrickBao/kiro-anthropic/commit/ca0c995) —
  independently implemented, described as "mirrors Kiro's client".
- **`d-kuro/kirocc`** — captures the signature but forwards it only downstream; its
  request type has no `reasoningContent` field at all. Its history comment ("v2 captures
  show thinking blocks are NOT included in history toolUses") is about `toolUses`, not
  about `reasoningContent`. No evidence it attempted the round-trip.
- **`chaogei/Kiro-account-manager`** — claims the request field is rejected outright, but
  the same repo implements `THINKING_SIGNATURE_INVALID` recovery, which could not exist
  if the field were illegal. Most likely it hit the flat wire format or an unsigned block.

---

## Probes deliberately NOT committed

Three further throwaway probes were written during investigation and are **not** in this
directory:

| Probe                                      | Measured                                                                                                                                           | Why not committed                                                                                                                                                                                   |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signature-probe.ts` (580 lines)           | Plan §3.2's binding matrix: whether the signature is bound to `conversationId`, account, paired text or model, and whether it is actually verified | Large, quota-heavy, and the plan's "reproducibility gap" box names only the §3.1 A/B probe. §3.2 therefore still rests on the plan's table alone — a **named residual gap**, not a silent omission. |
| `multiturn-reasoning-probe.ts` (440 lines) | An earlier, less controlled version of the same A/B question                                                                                       | Superseded by `ab-reasoning-probe.ts`, which canned tool results by turn index so the arms cannot diverge. Committing both would invite comparing incomparable runs.                                |
| `followup-probe.ts` (230 lines)            | Two one-off follow-ups: retry without effort, and signature-vs-mutated-text binding                                                                | Ad-hoc single-question arms whose conclusions are already folded into §3.2.                                                                                                                         |

Their conclusions are recorded in plan §3.2 and in
`.omo/notepads/reasoning-signature-roundtrip/learnings.md` under "Empirical facts". If
§3.2 ever needs to be re-verified, `signature-probe.ts` is the one worth reconstructing.
