# Recovery Request Identity and Atomic Compaction Plan

> Baseline: `v0.18.0` (`7f39550`)
> Source investigations:
> [`SESSION_STOP_AFTER_NEXT_STEP_FORENSICS.md`](./SESSION_STOP_AFTER_NEXT_STEP_FORENSICS.md) and
> [`KIRO_REPLAY_REQUEST_IDENTITY_RESEARCH.md`](./KIRO_REPLAY_REQUEST_IDENTITY_RESEARCH.md)

## 1. Scope

This release fixes the plugin-owned failure paths identified by the two
investigations:

1. Recovery attempts on the same account must reuse one transformed semantic
   request, including its Kiro `conversationId` and recovered reasoning
   signatures.
2. OpenCode compaction requests must not publish a partial summary before the
   upstream stream drains successfully.
3. Recovery logs need one stable correlation ID, a privacy-safe semantic
   fingerprint, per-attempt causes, and one terminal summary.

The release does not attempt to solve OMO parent-wake ownership, OpenCode
cross-process session leases, or a model that returns a normal `finish:"stop"`
after merely describing future work. The provider must not infer continuation
from assistant prose or fabricate a finish reason.

## 2. Safety Decisions

- Keep `ExactReplayMatcher` byte-exact for reasoning, visible text, and tools.
- Keep reasoning-signature replay from `#79`.
- Keep normal chat live-streaming and preserve multi-workspace concurrency.
- Do not increase `stream_max_attempts`.
- Do not treat missing completion metadata as truncation.
- Buffer only requests marked as OpenCode compaction, unless the existing
  global `stream_buffer_until_complete` option is enabled.
- Reuse one transformed request on the same account by default.
- Reusing the same Kiro `conversationId` after switching accounts remains
  experimental and defaults off until a real API A/B proves that Kiro accepts
  the identity with a different `profileArn`.

## 3. Request Identity

One semantic snapshot contains:

- a random `recoveryGroupId`;
- a canonical SHA-256 semantic fingerprint;
- `conversationState` and wire `conversationId`;
- effective model, effort, streaming mode, and the reasoning-replay decision;
- request kind (`normal`, `compaction`, or `unknown`).

The fingerprint normalizes the random wire `conversationId` and excludes
credentials, account IDs, email, `profileArn`, region, endpoint, and attempt
IDs. The wire ID is logged separately, allowing diagnostics to distinguish
"same semantics, new wire ID" from a true request-shape change.

Each SDK attempt gets a fresh account envelope:

- access credentials and SDK client;
- `profileArn` and region;
- account attempt epoch, usage attribution, and attempt ID;
- stream observer, emitted-output accumulator, iterator, and timers.

The semantic snapshot is cloned before binding so an SDK implementation cannot
mutate the frozen source used by later attempts.

## 4. Cross-Account Policy

`stream_recovery_reuse_conversation_id_across_accounts` controls the unproven
cross-account behavior:

- `false` (default): a switch to another account performs a fresh transform.
  If the normalized semantic fingerprint is unchanged, it remains correlated
  to the same recovery group while reporting
  `sameConversationIdAsInitial:false`.
- `true`: the original semantic snapshot and wire `conversationId` are rebound
  to the new account envelope.

Any normalized semantic change, including removal of invalid reasoning
signatures, starts a new recovery group.

## 5. Atomic Compaction

The plugin's `chat.headers` hook marks only:

```text
agent == compaction
providerID == kiro-auth
```

with the private header:

```text
x-opencode-kiro-request-kind: compaction
```

The custom fetch consumes this marker before constructing the AWS SDK request.
When `compaction_buffer_until_complete` is enabled (default), the existing
buffered response path drains each Kiro stream before exposing any SSE byte.
Failed attempts are discarded; one complete attempt is published once.
Ordinary requests still return after their first semantic chunk.

## 6. Observability and Privacy

Normal recovery logs include:

- `recoveryGroupId`, `semanticFingerprint`, `wireConversationId`;
- request kind, attempt index, model, effort, and region;
- `sameSemanticAsInitial` and `sameConversationIdAsInitial`;
- a process-local `accountAlias`;
- emitted character/tool counts, replay progress, cause chain, and elapsed time.

The terminal record includes attempts used, number of accounts tried, initial
failure, final failure, recovery outcome, and terminal source.

Routine logs must not contain account email, raw account ID, token,
`profileArn`, prompt/response text, reasoning text, or tool arguments.

## 7. Verification Gates

Targeted tests must prove:

- same-account retries transform once and keep one wire ID;
- the experimental cross-account option is the only path that keeps that ID
  across accounts;
- signature-bearing transformed history is frozen between attempts;
- semantic changes start a new group;
- compaction failures publish zero partial bytes and success publishes once;
- normal requests still stream immediately;
- one request start maps to one terminal record;
- log records carry aliases and fingerprints without sensitive values.

Release gates:

```bash
bun test src/__tests__/recovery-request-identity.test.ts \
  src/__tests__/request-kind.test.ts \
  src/__tests__/plugin-hooks.test.ts \
  src/__tests__/request-handler.test.ts \
  src/__tests__/recovery-integration.test.ts \
  src/__tests__/reasoning-log-redaction.test.ts \
  src/__tests__/config-loader.test.ts \
  src/__tests__/config-backfill.test.ts \
  src/__tests__/logger.test.ts
bun run typecheck
bunx prettier --check README.md 'docs/**/*.md' 'src/**/*.ts' package.json
bun test
bun run build
```

The feature PR uses a conventional `feat:` commit. Release Please owns the
version bump, changelog, tag, GitHub release, and npm trusted publish.

## 8. Rollout and Rollback

The change is additive at the configuration boundary. User `kiro.json` files
are backfilled with the two new defaults without overwriting explicit values:

- `compaction_buffer_until_complete: true`;
- `stream_recovery_reuse_conversation_id_across_accounts: false`.

The rollout keeps `stream_recovery_mode: "off"` and
`stream_buffer_until_complete: false`, so ordinary chat preserves the existing
live-stream behavior. The operational rollback order is:

1. Set `KIRO_COMPACTION_BUFFER_UNTIL_COMPLETE=false` if compaction latency is
   unacceptable.
2. Keep `KIRO_STREAM_RECOVERY_MODE=off` to disable post-output live recovery.
3. Keep cross-account conversation ID reuse disabled.
4. Roll back to `0.18.0` only if same-account request freezing itself causes a
   compatibility regression.

Release Please owns the version bump. A successful feature PR should create a
minor release because the conventional commit is `feat(request): ...`.

## 9. Implementation Status

Status as of 2026-08-05:

| Phase                          | Status             | Delivered behavior                                                                                                 |
| ------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| P0 observability               | Implemented        | Recovery group, semantic fingerprint, wire ID, request kind, account aliases, attempt causes, and terminal summary |
| P1 stable identity             | Implemented        | Same-account attempts reuse one transformed request; cross-account reuse is experimental and off by default        |
| P2 atomic compaction           | Implemented        | OpenCode `agent: "compaction"` requests buffer to a clean end before publishing                                    |
| P3 OpenCode atomic persistence | Upstream follow-up | This plugin cannot make OpenCode's session database transactional across providers                                 |

The implementation intentionally leaves `ExactReplayMatcher`, reasoning
signature replay, completion-metadata semantics, retry budgets, and ordinary
chat streaming unchanged.

## 10. Verification Results

Feature-branch release gates completed on 2026-08-05:

- targeted recovery/config/logging suite: `220 pass / 0 fail` across 9 files;
- complete suite: `1256 pass / 0 fail` across 95 files;
- `bun run typecheck`: passed;
- `bun run build`: passed;
- Prettier and `git diff --check`: passed;
- refreshed CodeGraph index: 201 files, 2,971 nodes, 12,626 edges, no pending
  changes;
- OpenCode `v1.18.12` (`0dd6950d1b06958fbcdcadf0ad56258257ab7fdb`)
  source verified that compaction resolves `agents.get("compaction")` and sends
  the request through the normal agent-aware LLM preparation path.

A real Kiro cross-account reuse A/B was intentionally not run. The
quota-consuming, protocol-uncertain path remains behind an explicit option that
defaults to `false`.
