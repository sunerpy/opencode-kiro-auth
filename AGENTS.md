# AGENTS.md — opencode-kiro-auth

Knowledge base for coding agents working in this repo. Grounded in the CodeGraph
index (`.codegraph/codegraph.db`); paths below are verified against on-disk source.

## 1. Project overview

`@sunerpy/opencode-kiro-auth` is an OpenCode plugin (TypeScript, runs on Bun)
that lets OpenCode use AWS Kiro (CodeWhisperer) as a model provider — Claude
Sonnet (including Sonnet 5)/Opus/Haiku, OpenAI GPT 5.6 (Sol/Terra/Luna), plus a
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
fail while the SDK event stream is *iterated*. `ResponseHandler.handleSdkSuccess`
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
- **After output has been emitted** — never re-calls the SDK (no replay of
  content/tool calls). The stream ends and the failure surfaces as
  `UpstreamUnexpectedError` with `emittedOutput: true`.
- **On exhaustion** — returns a structured HTTP 503 via
  `UpstreamUnexpectedError.toResponse()`:
  `{"retryable":true,"phase":"stream","emittedOutput":false,"code":"UPSTREAM_UNEXPECTED"}`.

Output uses a pull-driven `ReadableStream` with `highWaterMark: 0`; an empty
stream still emits a terminal `finish_reason:"stop"` SSE chunk. Abort/timeout is
threaded into the SDK send, iterator, stream-retry backoff, and every
ErrorHandler/AccountSelector wait, and always releases the static request queue.
A per-account **attempt epoch** plus `UsageTracker.syncUsage(..., isValid)`
prevents a stale (superseded) stream from committing success or usage over a
newer failure.

`RequestHandler` (`src/core/request/request-handler.ts:23`) owns and wires up
`AccountSelector`, `TokenRefresher`, `ErrorHandler`, `ResponseHandler`, and
`UsageTracker`/`RetryStrategy`; it is constructed once in `src/plugin.ts:79`
and is the only class with direct access to the OpenCode `client` (used for
`triggerReauth` -> `client.provider.oauth.authorize/callback`).

## 3. Directory guide

| Path | Contents |
|---|---|
| `src/core/auth/` | `AuthHandler`, `IdcAuthMethod`, `TokenRefresher` — OAuth methods and access-token refresh logic. |
| `src/core/request/` | `RequestHandler` (main loop + stream-iteration retry), `ErrorHandler` (HTTP status handling incl. 402/403/429), `ResponseHandler` (SDK/stream -> OpenAI response), `RetryStrategy`, `stream-error.ts` (`SdkEventStreamIterationError` / `UpstreamUnexpectedError`). |
| `src/core/account/` | `AccountSelector` (sticky/round-robin/lowest-usage), `UsageTracker`. |
| `src/plugin/config/` | Zod schema + `loadConfig`/`loader.ts` (user + project `kiro.json` merge). |
| `src/plugin/storage/` | `sqlite.ts` (`KiroDatabase`, `DB_PATH` = `kiro.db`), `migrations.ts`, `locked-operations.ts` (cross-process file locking via `proper-lockfile`). |
| `src/plugin/streaming/` | Stream transformers: raw Kiro event stream and SDK event stream -> OpenAI SSE chunks. |
| `src/plugin/sync/` | `syncFromKiroCli` — imports credentials/profile from the external `kiro-cli`'s own `data.sqlite3`. |
| `src/kiro/` | `auth.ts` (token decode/expiry helpers), `oauth-idc.ts` (IDC OAuth device flow, `authorizeKiroIDC`). |
| `src/infrastructure/database/` | `AccountRepository`, `AccountCache` — persistence layer in front of `KiroDatabase`. |
| `src/infrastructure/transformers/` | Message/history/tool-call transformers between OpenAI-shaped input and CodeWhisperer's `conversationState` shape. |
| `src/__tests__/` | `bun:test` suite (69 test files) — includes a dedicated `provider-id-collision.test.ts`. |
| `src/plugin.ts`, `src/index.ts`, `index.ts` (root) | Plugin composition root and public exports. |
| `src/constants.ts` | `KIRO_CONSTANTS`, `MODEL_MAPPING`, `KIRO_AUTH_SERVICE`, region helpers. |

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
  (`src/plugin/storage/sqlite.ts:22`), `kiro.json`
  (`src/plugin/config/loader.ts:29`).
- **Never alter the AWS wire strings** — these are literal values the
  CodeWhisperer service expects, not display text:
  - `x-amzn-kiro-agent-mode: 'vibe'` header (multiple call sites: `request-handler.ts:380`, `plugin/token.ts:39`, `plugin/sdk-client.ts:44`, `plugin/usage.ts:68`, `plugin/request.ts:333`).
  - User-agent strings containing `KiroIDE` / `Kiro IDE` (`constants.ts:45`, `kiro/oauth-idc.ts:43`, `plugin/token.ts:29-30`, `plugin/request.ts:322,334`).
  - `auth.desktop.kiro.dev` refresh endpoint (`constants.ts:39`, `KIRO_AUTH_SERVICE.ENDPOINT` at `constants.ts:144`, `plugin/token.ts:11`).
  - `q.{region}.amazonaws.com` CodeWhisperer base URL (`constants.ts:41-42`).
  - `ORIGIN_AI_EDITOR: 'AI_EDITOR'` message origin (`constants.ts:49`, used in `history-builder.ts` and `plugin/request.ts`).
- **Do not hardcode a wire id for an unreleased model** — every entry in
  `MODEL_MAPPING` (`src/constants.ts:52`) must be backed by an observed 200
  response from the real API before being added. Sonnet 5 is now probe-confirmed
  (wire id `claude-sonnet-5`, no dot suffix, HTTP 200 in us-east-1); its `.0` and
  `-1m` variants returned 400 "Invalid model" and must NOT be added.

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

## 6. Conventions

- Conventional Commits; Chinese commit subjects are acceptable per repo history.
- Formatting via `prettier` (invoked through husky/lint-staged) — don't hand-roll style.
- TypeScript strict mode; no `any`/`@ts-ignore` in new code (existing files use
  loose `any` at plugin boundaries — don't propagate that pattern into new code).
- Keep AWS-facing literals (headers, URLs, model ids) centralized in
  `src/constants.ts` rather than inlined at new call sites.

## 7. Where things live (quick index)

| What | Where |
|---|---|
| Provider id | `src/plugin.ts:14` (`KIRO_PROVIDER_ID`), used at `src/plugin.ts:431` |
| Model id map | `src/constants.ts` `MODEL_MAPPING` (line 52) |
| Model resolution | `src/plugin/models.ts` `resolveKiroModel` |
| Request loop | `src/core/request/request-handler.ts` `RequestHandler.handle` |
| Error / 402/403/429 handling | `src/core/request/error-handler.ts` `ErrorHandler.handle` |
| Token refresh | `src/core/auth/token-refresher.ts` `TokenRefresher` + `src/plugin/token.ts` `refreshAccessToken` |
| kiro-cli sync | `src/plugin/sync/kiro-cli.ts` `syncFromKiroCli` |
| Config load | `src/plugin/config/loader.ts` |
| SQLite storage | `src/plugin/storage/sqlite.ts` `KiroDatabase` / `DB_PATH` |
| SDK client construction | `src/plugin/sdk-client.ts` `createSdkClient` |
| Response -> OpenAI shape | `src/core/request/response-handler.ts` `ResponseHandler` |
