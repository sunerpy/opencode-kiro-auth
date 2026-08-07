# AGENTS.md — opencode-kiro-auth

Knowledge base for coding agents working in this repo. Grounded in the CodeGraph
index (`.codegraph/codegraph.db`); paths below are verified against on-disk source.

## 1. Project overview

`@sunerpy/opencode-kiro-auth` is an OpenCode plugin (TypeScript, runs on Bun)
that lets OpenCode use AWS Kiro (CodeWhisperer) as a model provider — Claude
Sonnet (including Sonnet 5)/Opus (including Opus 5)/Haiku, OpenAI GPT 5.6
(Sol/Terra/Luna), plus a
handful of open-weight models (DeepSeek, GLM, MiniMax, Qwen3) that Kiro
proxies. The provider id it registers with OpenCode is
`kiro-auth` (deliberately not `kiro` — see invariants). This is a fork of
`tickernelz/opencode-kiro-auth`, rebranded and maintained under `sunerpy`
(`package.json` `repository` field still points at the upstream `tickernelz`
repo; that's expected, not a bug to "fix").

The plugin's job is entirely on the OpenCode side: it intercepts OpenCode's
outbound HTTP calls for this provider, translates them into CodeWhisperer
`generateAssistantResponse` SDK calls, and translates the SDK response back
into an OpenAI-compatible `Response`. It never changes the AWS wire protocol.

## 2. Architecture map

Entry point `src/index.ts` default-exports `{ id: 'kiro-auth', server: KiroOAuthPlugin }`.
`KiroOAuthPlugin` is `createKiroPlugin('kiro-auth')` from `src/plugin.ts:47`,
which returns an object with three OpenCode plugin hooks:

- **`config`** — calls `bootstrapAuthIfNeeded(id)` (`src/plugin/auth-bootstrap.ts`)
  to seed an `auth.json` placeholder so OpenCode invokes the auth `loader` on
  startup, then injects `provider[id].npm = '@ai-sdk/openai-compatible'`,
  `provider[id].api = baseURL`, and a static `models` map (Sonnet/Opus/Haiku +
  open-weight models) if the user hasn't already defined them.
- **`auth`** — `provider: id`; `loader` returns
  `{ apiKey: '', baseURL, fetch: (input, init) => requestHandler.handle(input, init, showToast) }`.
  This custom `fetch` is the interception point: OpenCode's SDK calls it for
  every request, and it routes anything matching the Kiro API host straight
  into `RequestHandler`. `methods` comes from `AuthHandler.getMethods()`
  (`src/core/auth/auth-handler.ts`) — IDC / AWS Builder ID OAuth flows.
- **`provider`** — a `models` normalizer that ensures each model's `api.url`
  falls back to the computed `baseURL`.

**Request flow** (confirmed via `codegraph_explore`):

```
opencode SDK call
  -> custom fetch (src/plugin.ts:399, inside the `auth.loader` hook)
  -> RequestHandler.handle (src/core/request/request-handler.ts:58)
       - non-Kiro URLs pass through to global fetch untouched
       - Kiro URLs are serialized through a static request queue
         (RequestHandler.kiroRequestQueue) to avoid races across concurrent calls
  -> AccountSelector.selectHealthyAccount (src/core/account/account-selector.ts)
  -> TokenRefresher.refreshIfNeeded (src/core/auth/token-refresher.ts:73)
  -> transformToSdkRequest (src/plugin/request.ts) builds the CodeWhisperer payload
  -> createSdkClient(...).send(GenerateAssistantResponseCommand)
       (src/plugin/sdk-client.ts, @aws/codewhisperer-streaming-client)
  -> on success: ResponseHandler.handleSdkSuccess (src/core/request/response-handler.ts:124)
       -> streams via transformSdkStream (src/plugin/streaming/sdk-stream-transformer.ts)
          or collects a single OpenAI-shaped chat.completion
  -> on SDK error (has $metadata.httpStatusCode): ErrorHandler.handle
       (src/core/request/error-handler.ts:45, class at :37) decides retry /
       switch-account / throw. Each account is force-refreshed via
       TokenRefresher.forceRefresh (token-refresher.ts:90) at most once per
       request: the set of already-force-refreshed account ids
       (`context.forcedRefreshAccountIds: Set<string>`, RequestContext at
       error-handler.ts:18/:24) is threaded through both retries and
       account switches — it is never reset when switching accounts — which,
       combined with RetryStrategy's iteration cap, bounds the retry loop.
  -> on network error (no httpStatusCode): ErrorHandler.handleNetworkError
```

**Post-200 stream-iteration failures** are a distinct path from the HTTP-error
path above. Once `client.send()` resolves with HTTP 200 the response may still
fail while the SDK event stream is _iterated_. `ResponseHandler.handleSdkSuccess`
wraps the raw SDK iterator and rethrows only its `next()` errors as
`SdkEventStreamIterationError` (`src/core/request/stream-error.ts:8`) — transform,
serialization, and Response-construction errors are NOT wrapped and are never
replayed. `RequestHandler.handleKiroRequest` (request-handler.ts:251) catches
that typed error and:

- **Before any semantic output** (`choices[0].delta.content`,
  `reasoning_content`, or `tool_calls`) — transparently retries up to 3 stream
  attempts. Attempt 1's retry reuses the current account; attempt 2 prefers a
  healthy alternative via `AccountSelector.selectAlternativeAccount`
  (account-selector.ts:73). Backoff is 250/500ms base + 0–25% jitter.
- **After output has been emitted in live-stream mode** — behavior depends on
  `stream_recovery_mode` (`off` | `reasoning_restart` | `exact_replay`, default
  `off`, env `KIRO_STREAM_RECOVERY_MODE`). Under `off` the SDK is never re-called:
  the stream ends and the failure surfaces as `UpstreamUnexpectedError` with
  `emittedOutput: true`. Under the two recovery modes the SDK _is_ re-called —
  see "Live stream recovery" below.
- **With `stream_buffer_until_complete` enabled** — consumes the entire
  transformed SSE response before exposing any chunk to OpenCode. An iterator
  failure at any point therefore remains a pre-delivery failure and can be
  retried without duplicating content or tool calls. This deliberately trades
  live token display for task continuity. `stream_max_attempts` (default 3,
  range 1-10) controls the bounded retry count.
- **On exhaustion** — returns a structured HTTP 503 via
  `UpstreamUnexpectedError.toResponse()`:
  `{"retryable":true,"phase":"stream","emittedOutput":false,"code":"UPSTREAM_UNEXPECTED"}`,
  with `Retry-After: 2`. That header is load-bearing: opencode's own retry logic
  applies its 2^31 cap (not the 30s no-headers cap) to any error carrying response
  headers, so a 503 without it grows host backoff unboundedly.

Live output uses a pull-driven `ReadableStream` with `highWaterMark: 0`; buffered
recovery mode consumes that same transformed stream to completion and then
returns a pull-driven in-memory SSE response. An empty stream still emits a
terminal `finish_reason:"stop"` SSE chunk. Caller abort is threaded through the
SDK send, iterator, stream-retry backoff, and every ErrorHandler/AccountSelector
wait. The initial `client.send()` deadline is disabled by default;
`sdk_response_timeout_enabled` opts into the `sdk_response_timeout_ms` fixed
deadline, which continues through the first raw stream event. When that deadline
is disabled, the first event has no plugin deadline but remains
caller-cancellable. Stream-event inactivity deadlines are also disabled by
default because a silent event gap can be valid model computation;
`stream_event_timeout_enabled` opts into using `request_timeout_ms` (default
120s) for each post-first-event iterator `next()` wait, paused during downstream
backpressure. Initial-response timeouts are not automatically retried because
the server may already be generating, so replay could duplicate output and
quota usage. All terminal paths release the static request queue.
A per-account **attempt epoch** plus `UsageTracker.syncUsage(..., isValid)`
prevents a stale (superseded) stream from committing success or usage over a
newer failure.

**Live stream recovery.** When `stream_recovery_mode` is not `off`,
`createLiveRecoveryResponse` (`src/core/request/recovery-integration.ts`) hands the
outbound `Response` to a `StreamRecoveryCoordinator`
(`src/core/request/stream-recovery.ts`). The coordinator owns **one** outbound SSE
byte stream across multiple SDK attempts: attempts stay pre-SSE-encoding (each keeps
its own transformer, `EmittedOutputAccumulator`, and `StreamObserver`), the coordinator
is the sole publication point, and it withholds a terminal chunk plus everything after
it until that attempt drains cleanly — so a failed attempt can never publish a
synthetic success. It fires `onComplete` at most once and `onTerminal` exactly once on
every exit path (drain, error, abort, cancel). Attempts are opened by
`RecoveryAttemptFactory` (`recovery-attempt.ts`); each recovery attempt is a real SDK
send and consumes quota.

`decideRecoveryTier` picks the tier from the mode plus what has already been
delivered:

- **Tier A `reasoning_restart`** — eligible only when zero visible chars, zero
  tool calls, and no observed tool intent have been delivered. Only reasoning was
  lost, so the next attempt simply continues the same SSE.
- **Tier B `exact_replay`** — only under `exact_replay` mode, and only once visible
  text or tool calls were delivered. `ExactReplayMatcher`
  (`src/core/request/replay-matcher.ts`) byte-exactly matches the new attempt against
  the delivered three-channel prefix (reasoning / visible text / tool calls).
  **Zero chunks are delivered until the whole delivered prefix is matched**; any
  divergence — or a terminal chunk arriving before catch-up (`early_end`) — aborts
  that attempt. Each attempt reports `Kiro exact replay attempt finished` telemetry.
- **Clean-EOF action-commitment replay** — separate from semantic truncation. Under
  `exact_replay` only, a clean EOF may spend one remaining attempt when the exact
  request exposes tools, the response emitted visible text but zero tool calls and
  no tool intent, and `action-commitment.ts` recognizes either an immediate
  first-person execution promise or an ordered unfinished self-owned action
  sequence. The same `ExactReplayMatcher` withholds duplicate bytes. This dedicated
  retry runs at most once and does not fail, rotate, rate-limit, or back off the
  healthy account.
- **`none`** — under `off`, or when neither tier is eligible; the failure is mapped
  to `UpstreamUnexpectedError` and terminates the stream.

**Semantic truncation** is decided ONLY by an unclosed tool intent
(`StreamObserver.hasOpenToolIntent`), never by missing completion metadata — see
`isSemanticTruncation` in `response-handler.ts`. Dialect tool-intent closure is
tri-state (`DialectToolResolution` = `none` | `complete` | `incomplete`,
`src/infrastructure/transformers/tool-call-parser.ts`) and shares the tool-call
parser's code-region rules. Under a recovery mode, an `incomplete` resolution makes
`transformSdkStream` suppress both the dialect `remainderText` and the whole turn's
tool calls (raw SDK tool calls included), so half an invocation or a partial tool set
never leaks to the consumer. The action-commitment replay above is a separate,
pattern-gated reliability guard; it must not be labeled or implemented as truncation.

**Reasoning-signature publication is tier-dependent** (`commitReasoningCorrelation`,
`request-handler.ts`). A Tier A recovery reports `recovered: true` and MUST NOT
publish its reasoning envelope: the delivered reasoning is old-partial + new-full,
which does not match the final attempt's envelope, so publishing would be a false hit
and the next turn would fail `THINKING_SIGNATURE_INVALID`. Loop lifecycle cleanup
still runs. A Tier B caught-up replay reports `recovered: false` and MAY publish,
because after a byte-exact prefix match the whole delivered response equals that
replay attempt's own complete output. The staleness gate here is **request-scoped**
(`owningAttemptId` compared against the request's latest attempt id), never the
per-account attempt epoch — that epoch is bumped by unrelated same-account requests,
so keying on it would drop healthy concurrent streams' envelopes.

**Observability.** `StreamObserver`
(`src/plugin/streaming/stream-observer.ts`) is write-only from the transformer's
perspective — the transformer never reads it back, so attaching one cannot change an
emitted chunk. It is threaded in via `lifecycle.streamObserver` and exposes
`sawToolIntent`, `hasOpenToolIntent`, `reasoningPhase` (`none` | `active` | `ended`),
and `dialectActive`. Stream failure logs carry `emittedReasoningChars`,
`emittedVisibleChars`, `emittedToolCount`, `sawToolIntent`, plus the transport-side
`sdkHttpKeepAlive`, `processId`, `bunVersion`, `streamElapsedMs`, and
`upstreamEventCount`. Three log-event constants live in
`src/core/request/stream-log-events.ts` and are re-exported from `request-handler.ts`:
`STREAM_REQUEST_STARTED_LOG` (`Kiro stream request started`, written unconditionally
once per inbound streaming request — the denominator for failure-rate measurement) and
`STREAM_MISSING_COMPLETION_LOG` (`Kiro stream ended without completion metadata`, a
benign WARN that fires on essentially every stream from this endpoint), plus
`STREAM_ACTION_COMMITMENT_RETRY_LOG` for the narrow one-shot replay.

**Transport.** `sdk_http_keep_alive` (default `false`) disables socket reuse after a
request completes, via `httpsAgent: { keepAlive, maxSockets: SDK_MAX_SOCKETS }` in
`createSdkClient` (`src/plugin/sdk-client.ts`); `maxSockets` stays 50. Fresh sockets
mitigate Bun stale-connection `ECONNRESET` mid-stream at the cost of one extra
TCP/TLS handshake per request. The flag is part of the SDK client cache key.

**History pollution.** Collapsed assistant turns in `collapseAgenticLoops`
(`src/infrastructure/transformers/history-builder.ts`) carry `content: ''`, matching
the official Kiro IDE shape. `stripPollutionMarkers`
(`src/infrastructure/transformers/message-transformer.ts`) scrubs this plugin's own
marker literals (`[system: tool calling continues]`,
`[system: conversation continues]`) out of inbound assistant `content` and `thinking`
as history is rebuilt, because the model copies them into its visible output and the
client replays them forever. The `<thinking>` text fallback is bounded to a single
turn — the most recent assistant message (`findThinkingTextReplayIndex`) — since
flattening reasoning into assistant text on every replayed turn teaches the model to
narrate instead of calling tools; one turn rather than zero because Tier A recovery
deliberately misses the signature cache. Adjacent same-role turns are merged
(`mergeIntoPreviousUserTurn`) so no synthetic assistant separator turns are produced;
`MAX_KIRO_IMAGES` is exported from `src/plugin/image-handler.ts` and shared by that
merge path.

**Storage concurrency.** Several OpenCode processes share one `kiro.db`, so every
write path has to assume contention. Runtime writes do NOT take a global file
lock: each of `KiroDatabase`'s write methods runs its read-modify-write inside a
`BEGIN IMMEDIATE` transaction (`withImmediateTransaction`,
`src/plugin/storage/sqlite.ts:64`), which gives `mergeAccounts` a consistent read
for conflict resolution. Single-statement writes go through the same path,
because autocommit atomicity does not imply the write eventually lands.

Acquisition is asynchronous by design. Before `BEGIN IMMEDIATE` the transaction
helper sets `busy_timeout = 0` so `SQLITE_BUSY` returns immediately, then backs
off via `setTimeout` and retries until the `WRITE_LOCK_DEADLINE_MS` (30s)
deadline (`sqlite.ts:11`), after which it throws `KIRO_DB_WRITE_LOCK_TIMEOUT`
(`sqlite.ts:17`) with the original error as `cause` — distinguishable from
corruption or permission failures.

`proper-lockfile` survives in exactly three narrower scopes
(`src/plugin/storage/locked-operations.ts`): `withDatabaseLockSync` (:79) around
schema init and `runMigrations`, since migrations open their own transactions and
an outer wrapper would nest `BEGIN`; `withRefreshLock` (:111) per account,
because a rotated refresh token is single-use; and
`tryAcquireKeepAliveLock`/`withKeepAliveLock` (:134, :149) for non-blocking
leader election. Lock-acquisition `ENOENT` is treated as a retryable race, not a
hard failure — `proper-lockfile`'s `mtimePrecision.probe()` surfaces it when
another process removes the lock file concurrently
(`locked-operations.ts:38`).

Migrations are marker-gated. `runMigrations` (`migrations.ts:61`) runs
`migratePluginMetaTable` (:288) first so the marker table exists, then
`migrateToUniqueRefreshToken` (:73) returns early when
`refresh_token_dedup_migration_version` is already present in `plugin_meta`
(`hasRefreshTokenDedupMarker`, :52). The marker is written in the same
`BEGIN IMMEDIATE` transaction as the dedup work, so a crash rolls back both. The
other startup migrations probe before writing, and
`beginImmediateWithRetry` (:31) throws `KIRO_DB_MIGRATION_LOCK_TIMEOUT`
(:13) once its bounded retry budget is exhausted. On an already-migrated
database, five consecutive opens leave `PRAGMA data_version` unchanged (zero
writes); six concurrent processes reach steady-state startup in ~4.5ms average.

**Token persistence ordering.** A rotated token is published to
`AccountManager`'s in-memory state only after it has been persisted
(`TokenRefresher.runLockedRefresh`, `src/core/auth/token-refresher.ts:174`). An
unpersisted candidate is held in `pendingPersistence` (:92) and later attempts
retry the write only — they do not call AWS again, since the refresh token was
already consumed. A persistence failure raises `TokenPersistenceError` and is
never treated as invalid credentials: `refreshIfNeeded` (:110) still does not
throw and returns `shouldContinue: true` so the main loop backs off and retries,
`forceRefresh` (:127) still never throws and returns `{ok: false, dead: false}`,
and a keep-alive failure on one account does not abort the scan.

`RequestHandler` (`src/core/request/request-handler.ts:23`) owns and wires up
`AccountSelector`, `TokenRefresher`, `ErrorHandler`, `ResponseHandler`, and
`UsageTracker`/`RetryStrategy`; it is constructed once in `src/plugin.ts:79`
and is the only class with direct access to the OpenCode `client` (used for
`triggerReauth` -> `client.provider.oauth.authorize/callback`).

## 3. Directory guide

| Path                                               | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/core/auth/`                                   | `AuthHandler`, `IdcAuthMethod`, `TokenRefresher` — OAuth methods and access-token refresh logic.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/core/request/`                                | `RequestHandler` (main loop + stream-iteration retry), `ErrorHandler` (HTTP status handling incl. 402/403/429), `ResponseHandler` (SDK/stream -> OpenAI response), `RetryStrategy`, `stream-error.ts` (`SdkEventStreamIterationError` / `UpstreamUnexpectedError`), `stream-recovery.ts` (`StreamRecoveryCoordinator`, `decideRecoveryTier`), `recovery-attempt.ts` (`RecoveryAttemptFactory`), `recovery-integration.ts` (`createLiveRecoveryResponse`), `replay-matcher.ts` (`ExactReplayMatcher`), `stream-log-events.ts` (the two stable log-event constants). |
| `src/core/account/`                                | `AccountSelector` (sticky/round-robin/lowest-usage), `UsageTracker`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/plugin/config/`                               | Zod schema + `loadConfig`/`loader.ts` (user + project `kiro.json` merge).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `src/plugin/storage/`                              | `sqlite.ts` (`KiroDatabase`, `DB_PATH` = `kiro.db`, `withImmediateTransaction`), `migrations.ts` (schema migrations + `plugin_meta` markers), `locked-operations.ts` (`mergeAccounts`/`deduplicateAccounts` plus the three remaining `proper-lockfile` scopes: schema init, per-account refresh, keep-alive leader election).                                                                                                                                                                                                                                      |
| `src/plugin/streaming/`                            | Stream transformers: raw Kiro event stream and SDK event stream -> OpenAI SSE chunks; `stream-observer.ts` (`StreamObserver`, write-only ingestion-time signals).                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/plugin/sync/`                                 | `syncFromKiroCli` — imports credentials/profile from the external `kiro-cli`'s own `data.sqlite3`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/kiro/`                                        | `auth.ts` (token decode/expiry helpers), `oauth-idc.ts` (IDC OAuth device flow, `authorizeKiroIDC`).                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `src/infrastructure/database/`                     | `AccountRepository`, `AccountCache` — persistence layer in front of `KiroDatabase`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/infrastructure/transformers/`                 | Message/history/tool-call transformers between OpenAI-shaped input and CodeWhisperer's `conversationState` shape.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/__tests__/`                                   | `bun:test` suite (90 test files, 1185 tests) — includes `provider-id-collision.test.ts`, `sqlite-concurrency.test.ts`, and `sqlite-multiprocess-stress.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/plugin.ts`, `src/index.ts`, `index.ts` (root) | Plugin composition root and public exports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/constants.ts`                                 | `KIRO_CONSTANTS`, `MODEL_MAPPING`, `KIRO_AUTH_SERVICE`, region helpers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## 4. Critical invariants — DO NOT BREAK

- **Provider id must stay `kiro-auth`**, never bare `kiro` — models.dev has a
  built-in provider #91 named `kiro` and colliding with it breaks model
  resolution for users. Enforced by `src/__tests__/provider-id-collision.test.ts`.
- **Never rename external `kiro-cli` integration points.** These are contracts
  with a different project, not internal naming you control:
  - SQLite keys `kirocli:odic:token` / `kirocli:social:token`
    (`src/plugin/sync/kiro-cli.ts:258`).
  - `kiro-cli`'s own DB path `data.sqlite3` (`src/plugin/sync/kiro-cli-parser.ts:13,16,17`).
- **Never rename filenames used for local storage/config**: `kiro.db`
  (`src/plugin/storage/sqlite.ts:49`), `kiro.json`
  (`src/plugin/config/loader.ts:29`).
- **`withImmediateTransaction`'s callback must stay synchronous** (`fn: () => T`,
  no `await` inside). Yielding the event loop mid-transaction lets the same
  connection be re-entered — nested `BEGIN`, interleaved inserts, or a writer
  lock held for the duration of an unrelated `await`. Acquisition is async on
  purpose and the callback plus `COMMIT`/`ROLLBACK` are sync on purpose; do not
  collapse the two. Relatedly, do not "simplify" acquisition by leaving
  `busy_timeout` non-zero: libsql's native layer spins inside the synchronous
  `exec`, freezing the event loop. Measured with a synchronous implementation, a
  `setInterval` heartbeat fired zero times while a holder kept the lock for 2.5
  seconds — and this plugin is forwarding SSE on that same thread. Also: `BEGIN`
  failing must not be followed by `ROLLBACK` (there is no open transaction).
- **Never switch the read-modify-write transactions to `BEGIN DEFERRED`.** In
  libsql, a deferred read-then-write upgrade does not raise
  `SQLITE_BUSY_SNAPSHOT` — it silently overwrites, losing the concurrent update.
  `BEGIN IMMEDIATE` is the only safe form here (see the comment at
  `src/plugin/storage/migrations.ts:80`).
- **Migration guards must be persistent markers, not schema probes.**
  `migrateToUniqueRefreshToken` previously keyed off the existence of
  `idx_refresh_token_unique`, which `migrateDropRefreshTokenUniqueIndex` then
  dropped — so the guard never held again and every process re-ran a full-table
  `GROUP BY` plus `CREATE INDEX` inside a write transaction on every open. Guard
  new one-shot migrations with a `plugin_meta` key committed in the same
  transaction as the work.
- **Never alter the AWS wire strings** — these are literal values the
  CodeWhisperer service expects, not display text:
  - `x-amzn-kiro-agent-mode: 'vibe'` header (multiple call sites: `request-handler.ts:380`, `plugin/token.ts:39`, `plugin/sdk-client.ts:44`, `plugin/usage.ts:68`, `plugin/request.ts:333`).
  - User-agent strings containing `KiroIDE` / `Kiro IDE` (`constants.ts:45`, `kiro/oauth-idc.ts:43`, `plugin/token.ts:29-30`, `plugin/request.ts:322,334`).
  - `auth.desktop.kiro.dev` refresh endpoint (`constants.ts:39`, `KIRO_AUTH_SERVICE.ENDPOINT` at `constants.ts:144`, `plugin/token.ts:11`).
  - `q.{region}.amazonaws.com` CodeWhisperer base URL (`constants.ts:41-42`).
  - `ORIGIN_AI_EDITOR: 'AI_EDITOR'` message origin (`constants.ts:49`, used in `history-builder.ts` and `plugin/request.ts`).
- **Semantic truncation must never key off missing completion metadata.**
  `STREAM_MISSING_COMPLETION_LOG` fires on essentially every stream this endpoint
  serves, so treating "no completion metadata" as truncation declares every healthy
  turn truncated and makes a recovery mode replay all of them. The only truncation
  signal is an unclosed tool intent (`StreamObserver.hasOpenToolIntent`). The narrow
  clean-EOF action-commitment replay is not a truncation verdict: preserve every
  additional gate in `StreamRecoveryCoordinator`, including `exact_replay`, available
  tools, zero tool calls/intent, explicit text pattern, one-use flag, and remaining
  attempt budget.
- **Keep the reasoning-signature publication split intact.** A Tier A recovery
  (`recovered: true`) must NOT publish its reasoning envelope — the delivered
  reasoning is old-partial + new-full, so publishing produces a false cache hit and
  the next turn fails `THINKING_SIGNATURE_INVALID`. A Tier B caught-up replay MAY
  publish. And the staleness gate must stay **request-scoped** (`owningAttemptId` vs
  the request's latest attempt id); switching it to the per-account attempt epoch
  drops envelopes belonging to healthy concurrent streams on the same account.
- **Never put protocol narration or synthetic placeholder text into an assistant
  turn's `content`.** The model imitates whatever it sees in assistant history, so a
  separator like `[system: tool calling continues]` comes back as visible output, the
  client persists it, and it replays forever. This caused multiple regressions.
  Collapsed turns carry `content: ''`; inbound assistant `content`/`thinking` is
  scrubbed by `stripPollutionMarkers`; adjacent same-role turns are merged instead of
  separated by a synthetic assistant turn.
- **`stream_recovery_mode: 'off'` must stay byte-identical to pre-recovery
  behavior.** It is the default, so every recovery feature has to be gated on the
  mode: no extra SDK sends, no suppression of dialect remainder text or tool calls,
  no truncation verdict. Observation (`StreamObserver`) is allowed because it is
  write-only and cannot change an emitted chunk.
- **Do not hardcode a wire id for an unreleased model** — every entry in
  `MODEL_MAPPING` (`src/constants.ts:52`) must be backed by an observed 200
  response from the real API before being added. Sonnet 5 is now probe-confirmed
  (wire id `claude-sonnet-5`, no dot suffix, HTTP 200 in us-east-1); its `.0` and
  `-1m` variants returned 400 "Invalid model" and must NOT be added. Opus 5 is
  also probe-confirmed (wire id `claude-opus-5`, HTTP 200 in us-east-1), including
  all five effort levels: `low`, `medium`, `high`, `xhigh`, and `max`.

## 5. Build / test / dev

```bash
bun install
bun run build       # tsc -p tsconfig.build.json && node scripts/fix-esm-imports.mjs -> dist/
bun test            # bun:test, src/__tests__/*.test.ts
bun run typecheck   # tsc --noEmit
```

`dist/` is not committed (gitignored) — always `bun run build` before local
mounting; the published npm package ships prebuilt `dist/`.

To use a local checkout as an OpenCode plugin, add the absolute repo path to
`opencode.json`:

```json
{ "plugin": ["/absolute/path/to/opencode-kiro-auth"] }
```

`husky` runs `bunx lint-staged` on pre-commit (prettier formatting).

### Test isolation caveat

`bunfig.toml` sets `preload = ["./src/__tests__/setup.ts"]`, so every test file in
a process shares one `kiro.db` singleton and one set of lock files. Fire-and-forget
writes from unrelated test files land in that same database. New tests must not
assert on globally shared state (total row counts, process-wide spy call counts);
scope assertions with a test-specific id prefix or filter by the target path.

Database concurrency bugs need at least five processes to reproduce reliably —
four does not surface them. `sqlite-multiprocess-stress.test.ts` uses five.

## 6. Conventions

- Conventional Commits; Chinese commit subjects are acceptable per repo history.
- Formatting via `prettier` (invoked through husky/lint-staged) — don't hand-roll style.
- TypeScript strict mode; no `any`/`@ts-ignore` in new code (existing files use
  loose `any` at plugin boundaries — don't propagate that pattern into new code).
- Keep AWS-facing literals (headers, URLs, model ids) centralized in
  `src/constants.ts` rather than inlined at new call sites.
- Determine the AWS wire schema from real IDE traffic captures; treat the SDK's
  TypeScript types as corroboration only. Concretely:
  `reasoningContent{reasoningText:{text,signature}}` _is_ a field the official Kiro
  IDE sends in request-side `conversationState.history`, confirmed by a capture, even
  though the SDK's `AssistantResponseMessage` type does not list it. The types are
  incomplete or lag actual IDE behavior.

## 7. Where things live (quick index)

| What                                 | Where                                                                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider id                          | `src/plugin.ts:14` (`KIRO_PROVIDER_ID`), used at `src/plugin.ts:431`                                                                                 |
| Model id map                         | `src/constants.ts` `MODEL_MAPPING` (line 52)                                                                                                         |
| Model resolution                     | `src/plugin/models.ts` `resolveKiroModel`                                                                                                            |
| Request loop                         | `src/core/request/request-handler.ts` `RequestHandler.handle`                                                                                        |
| Error / 402/403/429 handling         | `src/core/request/error-handler.ts` `ErrorHandler.handle`                                                                                            |
| Token refresh                        | `src/core/auth/token-refresher.ts` `TokenRefresher` + `src/plugin/token.ts` `refreshAccessToken`                                                     |
| kiro-cli sync                        | `src/plugin/sync/kiro-cli.ts` `syncFromKiroCli`                                                                                                      |
| Config load                          | `src/plugin/config/loader.ts`                                                                                                                        |
| SQLite storage                       | `src/plugin/storage/sqlite.ts` `KiroDatabase` / `DB_PATH` (line 49)                                                                                  |
| DB write transactions                | `src/plugin/storage/sqlite.ts:64` `withImmediateTransaction`                                                                                         |
| Remaining file locks                 | `src/plugin/storage/locked-operations.ts:79,111,134`                                                                                                 |
| Schema migrations / markers          | `src/plugin/storage/migrations.ts:61` `runMigrations`                                                                                                |
| SDK client construction              | `src/plugin/sdk-client.ts` `createSdkClient`                                                                                                         |
| Response -> OpenAI shape             | `src/core/request/response-handler.ts` `ResponseHandler`                                                                                             |
| Live stream recovery entry           | `src/core/request/recovery-integration.ts` `createLiveRecoveryResponse`                                                                              |
| Recovery coordinator / tier decision | `src/core/request/stream-recovery.ts` `StreamRecoveryCoordinator`, `decideRecoveryTier`                                                              |
| Recovery attempt opening             | `src/core/request/recovery-attempt.ts` `RecoveryAttemptFactory`                                                                                      |
| Tier B prefix matching               | `src/core/request/replay-matcher.ts` `ExactReplayMatcher`                                                                                            |
| Clean-EOF action commitment detector | `src/core/request/action-commitment.ts` `detectForwardActionCommitment`                                                                              |
| Stream observation signals           | `src/plugin/streaming/stream-observer.ts` `StreamObserver`                                                                                           |
| Stable stream log events             | `src/core/request/stream-log-events.ts` (re-exported from `request-handler.ts`)                                                                      |
| Semantic truncation verdict          | `src/core/request/response-handler.ts` `isSemanticTruncation`                                                                                        |
| Reasoning-signature publication gate | `src/core/request/request-handler.ts` `commitReasoningCorrelation`                                                                                   |
| Stream/transport config keys         | `src/plugin/config/schema.ts` — `stream_recovery_mode`:174, `stream_max_attempts`:167, `stream_buffer_until_complete`:161, `sdk_http_keep_alive`:141 |
| Pollution-marker scrubbing           | `src/infrastructure/transformers/message-transformer.ts` `stripPollutionMarkers`, `findThinkingTextReplayIndex`                                      |
| Loop collapse / turn merge           | `src/infrastructure/transformers/history-builder.ts` `collapseAgenticLoops`, `mergeIntoPreviousUserTurn`                                             |
