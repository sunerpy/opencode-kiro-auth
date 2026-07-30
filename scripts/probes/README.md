# `scripts/probes/`

Diagnostic probes that talk to the **real** AWS Kiro (CodeWhisperer)
`generateAssistantResponse` endpoint. They exist to make the empirical claims in
`.omo/plans/reasoning-signature-roundtrip.md` independently reproducible instead of
resting on a table in a document.

> **These probes spend real request quota.** A default `ab-reasoning-probe` run costs
> **10 requests** (`(TURNS + 1) * 2`); a `cross-account-replay-probe` run costs **3**. Read
> [Quota reality](#quota-reality) before running.

Contents:

- [`ab-reasoning-probe.ts`](#ab-reasoning-probets) — does replaying signed reasoning keep the
  model reasoning across a tool loop? (plan §3.1)
- [`cross-account-replay-probe.ts`](#cross-account-replay-probets) — does a signature produced
  under one account still work, and keep reasoning alive, when the follow-up runs on a
  different account? (plan §10 "multi-account rotation … including replay across a rotation")
- [`results/`](#results--which-files-are-canonical) — the committed raw runs, and which of them
  is canonical for which claim.

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

**Commit the result JSON** next to this README so the run stops being ephemeral. See
[`results/`](#results--which-files-are-canonical) for which runs are committed and why the
`-dry` ones are not.

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

## `cross-account-replay-probe.ts`

### What it measures

Whether a signed reasoning envelope produced under **one** account is still accepted, and
still keeps the model reasoning, when the follow-up request is sent with a **different**
account's token. This backs plan §10's "Multi-account rotation continues to work, including
replay across a rotation".

Plan §3.2 already measured the narrow AWS-level fact (account A's signature + account B's
token → 200). This probe adds the multi-turn continuation shape the plugin actually produces:

| turn | account | history                                                   |
| ---- | ------- | --------------------------------------------------------- |
| 0    | **A**   | empty — produces the first signature                      |
| 1    | **B**   | replays turn 0's signature, produced by **A**             |
| 2    | **B**   | replays **both** — one block signed by A, one signed by B |

Turn 2 is the interesting one: a **mixed-producer history**. The dependent variables are the
HTTP status on each account-B turn, whether `reasoningContentEvent` frames keep arriving, and
whether the 2-step chain (`17 → ×3 = 51`) completes.

> **Scope caveat.** Like `ab-reasoning-probe.ts`, this probe builds its own CodeWhisperer
> payloads. It proves the **mechanism** against the real API — it does **not** exercise the
> plugin's request builder or its account selector. The plugin-level half of the same claim is
> covered offline by `src/__tests__/reasoning-replay-account-rotation.test.ts`, which drives a
> real `AccountManager` in `round-robin` mode plus the real `transformToSdkRequest` and asserts
> the outbound body. **Neither half alone is sufficient; together they cover the checkbox.**

### Invocation

Both accounts must be pinned explicitly. There is **no auto-selection**, so the probe cannot
land on an over-quota account by accident:

```bash
DRY=1 \
  KIRO_PROBE_ACCOUNT_A='first@example.com' \
  KIRO_PROBE_ACCOUNT_B='second@example.com' \
  bun run scripts/probes/cross-account-replay-probe.ts

CONFIRM=1 \
  KIRO_PROBE_ACCOUNT_A='first@example.com' \
  KIRO_PROBE_ACCOUNT_B='second@example.com' \
  bun run scripts/probes/cross-account-replay-probe.ts
```

### Environment

| Variable               | Default                  | Meaning                                                        |
| ---------------------- | ------------------------ | -------------------------------------------------------------- |
| `KIRO_PROBE_ACCOUNT_A` | unset — **required**     | Email of the account that produces the signature.              |
| `KIRO_PROBE_ACCOUNT_B` | unset — **required**     | Email of the account that replays it. Must differ from `A`.    |
| `CONFIRM`              | unset                    | Must be `1` for any real API call.                             |
| `DRY`                  | unset                    | `1` builds payloads and prints wire shapes only. No API calls. |
| `OUT_DIR`              | `scripts/probes/results` | Where the raw result JSON is written.                          |
| `XDG_CONFIG_HOME`      | `~/.config`              | Where `opencode/kiro.db` is found.                             |

### Refusals

Every one of these exits non-zero **before** any client is constructed:

- either account env var missing (exit `2`);
- the two emails are equal, or resolve to the same stored account id (exit `2`) — otherwise
  nothing is cross-account;
- `CONFIRM=1` absent on a non-dry run (exit `2`);
- **either** account's headroom `< 3` (exit `2`) — both are checked, not just the producer;
- either account's access token expired or within 2 minutes of expiry (exit `1`). The probe
  never refreshes a token, so it stays out of the refresh-lock path and never writes to
  `kiro.db`.

The verdict flags are also guarded against a vacuous pass: with **zero** cross-account turns,
`allAcceptedHttp200` and `reasoningContinued` are reported `false`, not `true`.

### Sanitization guarantees

Identical to `ab-reasoning-probe.ts`, extended to two accounts: emails masked, ARNs masked in
the `DRY` dump, signatures reduced to `length + sha256Prefix`, and a pre-write self-scan that
**throws** if the serialized result contains either account's unmasked email, access token,
refresh token or `profileArn`, or any signature observed during the run.

---

<a id="results--which-files-are-canonical"></a>

## `results/` — which files are canonical

All committed result JSON is sanitized: signatures appear only as `length + sha256Prefix`,
emails only masked, and no token or `profileArn` appears at all. The AWS `requestId` values are
kept deliberately — they are correlation handles, not credentials.

| File                                                 | Probe                        | Calls | Canonical for                                                                               |
| ---------------------------------------------------- | ---------------------------- | ----- | ------------------------------------------------------------------------------------------- |
| `ab-reasoning-2026-07-30T03-03-39-864Z-AB.json`      | `ab-reasoning-probe`         | 9     | **The post-Wave-5 reproduction of plan §3.1.** The only surviving raw A/B data.             |
| `cross-account-replay-2026-07-30T03-17-10-528Z.json` | `cross-account-replay-probe` | 3     | **The live cross-account rotation result.** All three turns 200, reasoning sustained, `51`. |
| `cross-account-replay-2026-07-30T03-16-42-075Z.json` | `cross-account-replay-probe` | 1     | An **aborted** attempt, kept on purpose — see below.                                        |

**Why the aborted run is committed.** Its turn 0 returned **HTTP 200 with a completely empty
response**: 0 reasoning frames, 0 characters, no tool call. The probe correctly stopped rather
than fabricating a continuation, and the run was simply repeated. It is kept because it is
independent evidence that a 200 from this endpoint can carry no content at all — the same
shape as the arm-B collapse in the A/B run — and because it explains why the cross-account
verification cost 4 real calls rather than 3. Deleting it would make the call accounting
unreproducible.

**Why no `-dry` results are committed.** A `DRY=1` result JSON contains zero measurements (the
`ab-reasoning` dry file recorded literally empty arms). The dry path is free and reproducible
at any time, so committing its output would add a file that looks like evidence and is not.

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

**What "closing the gap" means from here — and what actually closed.** The committed baseline
is this table **plus** the post-Wave-5 reproduction now in
[`results/ab-reasoning-2026-07-30T03-03-39-864Z-AB.json`](results/ab-reasoning-2026-07-30T03-03-39-864Z-AB.json)
(9 real calls, `claude-opus-5`, effort `high`, `us-east-1`, order `AB`). Compare the two
qualitatively — does arm B collapse, does arm A complete the task — never numerically.

That reproduction:

| turn | arm A frames | arm B frames |
| ---- | ------------ | ------------ |
| 0    | 15           | 11           |
| 1    | 12           | 9            |
| 2    | 6            | 7            |
| 3    | 14           | **0**        |
| 4    | 18           | —            |

- Arm A reasoned on **5/5** turns and answered `90` correctly. Arm B emitted **0 frames, 0
  characters and no tool call at turn 3**, then abandoned the task with empty final text.
- **The collapse turn moved: 3 here, 2 in both original runs.** So the reproduced invariant is
  _"collapse and abandonment happen in arm B and not in arm A"_, at a position that **varies** —
  not "arm B collapses at turn 2". Anyone reading the older table as if turn 2 were the
  invariant is over-reading it.
- Signature lengths observed here were **308–376** characters, inside the originally documented
  304–560 range.
- `usage.before` and `usage.after` were **both 9504 — a delta of 0 across 9 real calls.** Do
  **not** read that as proof that replay is free; the far likelier explanation is that Kiro's
  usage counter lags or is sampled. The quota claim rests on the separate §3.2 measurement that
  5 calls billed as 5 in both arms.
- **Scope caveat:** this probe builds its own CodeWhisperer payloads, so it proves the mechanism
  against the real API, **not** the plugin's request wiring. That wiring was verified separately
  and end-to-end through `transformToSdkRequest` on both request-path branches (cache hit →
  byte-exact nested `reasoningContent`, no `<thinking>`, `toolUses` intact;
  `disableReasoningReplay` strips all; model-switch and one-character drift both refuse).
  Neither half alone is sufficient.

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

| Probe                                      | Measured                                                                                                                                           | Why not committed                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signature-probe.ts` (580 lines)           | Plan §3.2's binding matrix: whether the signature is bound to `conversationId`, account, paired text or model, and whether it is actually verified | Large and quota-heavy. **§3.2's binding matrix remains a named residual gap** — with one exception now closed: `cross-account-replay-probe.ts` independently reproduces the "not bound to the account" row. The other rows (`conversationId`, paired text, cross-model, flipped-character rejection, unsigned-block 400) still rest on the plan's table alone. |
| `multiturn-reasoning-probe.ts` (440 lines) | An earlier, less controlled version of the same A/B question                                                                                       | Superseded by `ab-reasoning-probe.ts`, which canned tool results by turn index so the arms cannot diverge. Committing both would invite comparing incomparable runs.                                                                                                                                                                                           |
| `followup-probe.ts` (230 lines)            | Two one-off follow-ups: retry without effort, and signature-vs-mutated-text binding                                                                | Ad-hoc single-question arms whose conclusions are already folded into §3.2.                                                                                                                                                                                                                                                                                    |

Their conclusions are recorded in plan §3.2 and in
`.omo/notepads/reasoning-signature-roundtrip/learnings.md` under "Empirical facts". If the rest
of §3.2 ever needs to be re-verified, `signature-probe.ts` is the one worth reconstructing.
