# AGENTS.md — opencode-kiro-auth

Knowledge base for coding agents working in this repo. Grounded in the CodeGraph
index (`.codegraph/codegraph.db`); paths below are verified against on-disk source.

## 1. Project overview

`@sunerpy/opencode-kiro-auth` is an OpenCode plugin (TypeScript, runs on Bun)
that lets OpenCode use AWS Kiro (CodeWhisperer) as a model provider — Claude
Sonnet/Opus/Haiku plus a handful of open-weight models (DeepSeek, GLM, MiniMax,
Qwen3) that Kiro proxies. The provider id it registers with OpenCode is
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
`KiroOAuthPlugin` is `createKiroPlugin('kiro-auth')` from `src/plugin.ts:15`,
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
  -> custom fetch (src/plugin.ts:151)
  -> RequestHandler.handle (src/core/request/request-handler.ts:50)
       - non-Kiro URLs pass through to global fetch untouched
       - Kiro URLs are serialized through a static request queue
         (RequestHandler.kiroRequestQueue) to avoid races across concurrent calls
  -> AccountSelector.selectHealthyAccount (src/core/account/account-selector.ts)
  -> TokenRefresher.refreshIfNeeded (src/core/auth/token-refresher.ts:25)
  -> transformToSdkRequest (src/plugin/request.ts) builds the CodeWhisperer payload
  -> createSdkClient(...).send(GenerateAssistantResponseCommand)
       (src/plugin/sdk-client.ts, @aws/codewhisperer-streaming-client)
  -> on success: ResponseHandler.handleSdkSuccess (src/core/request/response-handler.ts:18)
       -> streams via transformSdkStream (src/plugin/streaming/sdk-stream-transformer.ts)
          or collects a single OpenAI-shaped chat.completion
  -> on SDK error (has $metadata.httpStatusCode): ErrorHandler.handle
       (src/core/request/error-handler.ts:28) decides retry / switch-account /
       throw, including the one-shot invalid-bearer 403 -> forceRefresh -> retry
       path guarded by `context.bearerRefreshAttempted`
  -> on network error (no httpStatusCode): ErrorHandler.handleNetworkError
```

`RequestHandler` (`src/core/request/request-handler.ts:23`) owns and wires up
`AccountSelector`, `TokenRefresher`, `ErrorHandler`, `ResponseHandler`, and
`UsageTracker`/`RetryStrategy`; it is constructed once in `src/plugin.ts:30`
and is the only class with direct access to the OpenCode `client` (used for
`triggerReauth` -> `client.provider.oauth.authorize/callback`).

## 3. Directory guide

| Path | Contents |
|---|---|
| `src/core/auth/` | `AuthHandler`, `IdcAuthMethod`, `TokenRefresher` — OAuth methods and access-token refresh logic. |
| `src/core/request/` | `RequestHandler` (main loop), `ErrorHandler` (HTTP status handling incl. 402/403/429), `ResponseHandler` (SDK/stream -> OpenAI response), `RetryStrategy`. |
| `src/core/account/` | `AccountSelector` (sticky/round-robin/lowest-usage), `UsageTracker`. |
| `src/plugin/config/` | Zod schema + `loadConfig`/`loader.ts` (user + project `kiro.json` merge). |
| `src/plugin/storage/` | `sqlite.ts` (`KiroDatabase`, `DB_PATH` = `kiro.db`), `migrations.ts`, `locked-operations.ts` (cross-process file locking via `proper-lockfile`). |
| `src/plugin/streaming/` | Stream transformers: raw Kiro event stream and SDK event stream -> OpenAI SSE chunks. |
| `src/plugin/sync/` | `syncFromKiroCli` — imports credentials/profile from the external `kiro-cli`'s own `data.sqlite3`. |
| `src/kiro/` | `auth.ts` (token decode/expiry helpers), `oauth-idc.ts` (IDC OAuth device flow, `authorizeKiroIDC`). |
| `src/infrastructure/database/` | `AccountRepository`, `AccountCache` — persistence layer in front of `KiroDatabase`. |
| `src/infrastructure/transformers/` | Message/history/tool-call transformers between OpenAI-shaped input and CodeWhisperer's `conversationState` shape. |
| `src/__tests__/` | `bun:test` suite (47 tests) — includes a dedicated `provider-id-collision.test.ts` and `bearer-refresh-retry.test.ts`. |
| `src/plugin.ts`, `src/index.ts`, `index.ts` (root) | Plugin composition root and public exports. |
| `src/constants.ts` | `KIRO_CONSTANTS`, `MODEL_MAPPING`, `KIRO_AUTH_SERVICE`, region helpers. |

## 4. Critical invariants — DO NOT BREAK

- **Provider id must stay `kiro-auth`**, never bare `kiro` — models.dev has a
  built-in provider #91 named `kiro` and colliding with it breaks model
  resolution for users. Enforced by `src/__tests__/provider-id-collision.test.ts`.
- **Never rename external `kiro-cli` integration points.** These are contracts
  with a different project, not internal naming you control:
  - SQLite keys `kirocli:odic:token` / `kirocli:social:token`
    (`src/plugin/sync/kiro-cli.ts:235`).
  - `kiro-cli`'s own DB path `data.sqlite3` (`src/plugin/sync/kiro-cli-parser.ts:13,16,17`).
- **Never rename filenames used for local storage/config**: `kiro.db`
  (`src/plugin/storage/sqlite.ts:17`), `kiro.json`
  (`src/plugin/config/loader.ts:23,40`).
- **Never alter the AWS wire strings** — these are literal values the
  CodeWhisperer service expects, not display text:
  - `x-amzn-kiro-agent-mode: 'vibe'` header (multiple call sites: `request-handler.ts:255`, `plugin/token.ts:39`, `plugin/sdk-client.ts:43`, `plugin/usage.ts:27`, `plugin/request.ts:308`).
  - User-agent strings containing `KiroIDE` / `Kiro IDE` (`constants.ts:45`, `kiro/oauth-idc.ts:44`, `plugin/token.ts:29-30`, `plugin/request.ts:297,309`).
  - `auth.desktop.kiro.dev` refresh endpoint (`constants.ts:39,102`, `plugin/token.ts:11`).
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
| Provider id | `src/plugin.ts:12` (`KIRO_PROVIDER_ID`), used at `src/plugin.ts:183` |
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
