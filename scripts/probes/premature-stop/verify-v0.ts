/**
 * Prove that the `V0` payload used by `turn2-variant-probe.ts` really is what the plugin sends
 * in production, rather than a hand-written approximation.
 *
 * V0 is produced by driving the real `transformToSdkRequest` over the inbound body captured by
 * `capture-inbound.ts`. This script rebuilds it and compares it, field by field, against a real
 * turn-2 request recorded in a plugin `api-*.ndjson` log.
 *
 * The comparison cannot be byte-exact and must not pretend to be. Three classes of difference
 * are expected and are reported explicitly rather than hidden:
 *   1. `conversationId` and `toolUseId` are per-request identifiers;
 *   2. the captured run and the production run used different working directories, which appear
 *      inside OpenCode's system prompt and inside the `read` tool result text;
 *   3. the first assistant turn's visible text is the capture mock's canned sentence in V0 and
 *      the model's own sentence in production.
 * Everything else — trigger type, history length and role order, current-message content,
 * modelId, origin, tool count, the full tool schemas, tool-result status — must match exactly.
 *
 * ZERO API calls.
 *
 * Usage:
 *   bun run scripts/probes/premature-stop/verify-v0.ts \
 *     --capture <captured-inbound.json> --api <api.ndjson | api-filtered.ndjson>
 */

import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { transformToSdkRequest } from '../../../src/plugin/request.js'
import type { CodeWhispererRequest, KiroAuthDetails } from '../../../src/plugin/types.js'

const MODEL = 'claude-opus-5-high'
const THINKING_BUDGET = 20000
const FILLER = 'Tool results provided.'

type ConversationState = CodeWhispererRequest['conversationState']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseArgs(argv: readonly string[]): { capture: string; api: string } {
  let capture = join(import.meta.dir, 'captured-inbound.json')
  let api = ''
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--capture' && value) {
      capture = value
      i += 1
    } else if (flag === '--api' && value) {
      api = value
      i += 1
    }
  }
  if (!api) throw new Error('--api <api.ndjson> is required')
  return { capture, api }
}

function dbPath(): string {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'opencode', 'kiro.db')
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode', 'kiro.db')
}

function anyProfileArn(): string | undefined {
  const db = new Database(dbPath(), { readonly: true })
  try {
    const row: unknown = db
      .query(`SELECT profile_arn FROM accounts WHERE profile_arn IS NOT NULL LIMIT 1`)
      .get()
    return isRecord(row) && typeof row.profile_arn === 'string' ? row.profile_arn : undefined
  } finally {
    db.close()
  }
}

function buildV0(capturePath: string): ConversationState {
  const parsed: unknown = JSON.parse(readFileSync(capturePath, 'utf8'))
  const turn2 = isRecord(parsed) ? parsed.turn2 : undefined
  if (!isRecord(turn2)) throw new Error(`${capturePath} has no turn2 object`)
  const auth: KiroAuthDetails = {
    refresh: 'unused',
    access: 'unused',
    expires: Date.now() + 3_600_000,
    authMethod: 'idc',
    region: 'us-east-1',
    ...(anyProfileArn() ? { profileArn: anyProfileArn() } : {})
  }
  return transformToSdkRequest(
    structuredClone(turn2),
    MODEL,
    auth,
    false,
    THINKING_BUDGET,
    undefined,
    { effort: undefined, autoEffortMapping: true, disableReasoningReplay: false }
  ).conversationState
}

interface LoggedRequest {
  readonly conversationState: Record<string, unknown>
  readonly source: string
}

function findProductionTurn2(apiPath: string): LoggedRequest {
  for (const line of readFileSync(apiPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isRecord(parsed) || parsed.type !== 'request') continue
    const data = isRecord(parsed.data) ? parsed.data : {}
    const body = isRecord(data.body) ? data.body : {}
    const state = isRecord(body.conversationState) ? body.conversationState : undefined
    if (!state) continue
    if (state.historyLength !== 2) continue
    const current = isRecord(state.currentMessage) ? state.currentMessage : {}
    const uim = isRecord(current.userInputMessage) ? current.userInputMessage : {}
    if (uim.content !== FILLER) continue
    return { conversationState: state, source: apiPath }
  }
  throw new Error(`no turn-2 request (historyLength=2, content="${FILLER}") found in ${apiPath}`)
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)
}

interface Check {
  readonly field: string
  readonly v0: string
  readonly production: string
  readonly match: boolean
}

function main(): void {
  const options = parseArgs(process.argv.slice(2))
  const v0 = buildV0(options.capture)
  const prod = findProductionTurn2(options.api)

  const v0Current = v0.currentMessage.userInputMessage
  if (!v0Current) throw new Error('V0 current message has no userInputMessage')
  const prodCurrentRaw = isRecord(prod.conversationState.currentMessage)
    ? prod.conversationState.currentMessage
    : {}
  const prodCurrent = isRecord(prodCurrentRaw.userInputMessage)
    ? prodCurrentRaw.userInputMessage
    : {}
  const prodCtx = isRecord(prodCurrent.userInputMessageContext)
    ? prodCurrent.userInputMessageContext
    : {}
  const v0Ctx = v0Current.userInputMessageContext ?? {}

  const prodToolsRaw = prodCtx.tools
  const prodTools = Array.isArray(prodToolsRaw) ? prodToolsRaw : undefined
  const prodToolCount =
    prodTools?.length ?? (typeof prodCtx.toolCount === 'number' ? prodCtx.toolCount : -1)
  const prodToolResults = Array.isArray(prodCtx.toolResults) ? prodCtx.toolResults : []
  const v0ToolResults = v0Ctx.toolResults ?? []
  const firstProdResult = isRecord(prodToolResults[0]) ? prodToolResults[0] : {}
  const firstV0Result = v0ToolResults[0]

  const v0Roles = (v0.history ?? []).map((entry) => (entry.userInputMessage ? 'user' : 'assistant'))

  const checks: Check[] = [
    {
      field: 'chatTriggerType',
      v0: String(v0.chatTriggerType),
      production: String(prod.conversationState.chatTriggerType),
      match: v0.chatTriggerType === prod.conversationState.chatTriggerType
    },
    {
      field: 'history length',
      v0: String(v0.history?.length ?? 0),
      production: String(prod.conversationState.historyLength),
      match: (v0.history?.length ?? 0) === prod.conversationState.historyLength
    },
    {
      field: 'history role order',
      v0: v0Roles.join(','),
      production: 'user,assistant (implied by historyLength=2 + injectSystemPrompt)',
      match: v0Roles.join(',') === 'user,assistant'
    },
    {
      field: 'currentMessage.content',
      v0: JSON.stringify(v0Current.content),
      production: JSON.stringify(prodCurrent.content),
      match: v0Current.content === prodCurrent.content
    },
    {
      field: 'currentMessage.modelId',
      v0: String(v0Current.modelId),
      production: String(prodCurrent.modelId),
      match: v0Current.modelId === prodCurrent.modelId
    },
    {
      field: 'currentMessage.origin',
      v0: String(v0Current.origin),
      production: String(prodCurrent.origin),
      match: v0Current.origin === prodCurrent.origin
    },
    {
      field: 'tool count',
      v0: String(v0Ctx.tools?.length ?? 0),
      production: String(prodToolCount),
      match: (v0Ctx.tools?.length ?? 0) === prodToolCount
    },
    {
      field: 'tool names',
      v0: (v0Ctx.tools ?? []).map((tool) => tool.toolSpecification.name).join(','),
      production: prodTools
        ? prodTools
            .map((tool) => {
              const spec =
                isRecord(tool) && isRecord(tool.toolSpecification) ? tool.toolSpecification : {}
              return String(spec.name)
            })
            .join(',')
        : '<stripped by sanitize-runs.ts>',
      match: prodTools
        ? (v0Ctx.tools ?? []).map((tool) => tool.toolSpecification.name).join(',') ===
          prodTools
            .map((tool) => {
              const spec =
                isRecord(tool) && isRecord(tool.toolSpecification) ? tool.toolSpecification : {}
              return String(spec.name)
            })
            .join(',')
        : true
    },
    {
      field: 'tool schemas sha256/16',
      v0: sha256(v0Ctx.tools ?? []),
      production: prodTools ? sha256(prodTools) : '<stripped by sanitize-runs.ts>',
      match: prodTools ? sha256(v0Ctx.tools ?? []) === sha256(prodTools) : true
    },
    {
      field: 'toolResults length',
      v0: String(v0ToolResults.length),
      production: String(prodToolResults.length),
      match: v0ToolResults.length === prodToolResults.length
    },
    {
      field: 'toolResults[0].status',
      v0: String(firstV0Result?.status),
      production: String(firstProdResult.status),
      match: firstV0Result?.status === firstProdResult.status
    },
    {
      field: 'toolResults[0].content shape',
      v0: `${firstV0Result?.content.length ?? 0} block(s), keys=${Object.keys(
        firstV0Result?.content?.[0] ?? {}
      ).join('+')}`,
      production: (() => {
        const blocks = Array.isArray(firstProdResult.content) ? firstProdResult.content : []
        return `${blocks.length} block(s), keys=${Object.keys(
          isRecord(blocks[0]) ? blocks[0] : {}
        ).join('+')}`
      })(),
      match:
        (firstV0Result?.content.length ?? 0) ===
        (Array.isArray(firstProdResult.content) ? firstProdResult.content.length : -1)
    },
    {
      field: 'conversationState extra keys',
      v0: Object.keys(v0).sort().join(','),
      production: Object.keys(prod.conversationState)
        .sort()
        .filter((key) => key !== 'historyLength')
        .concat('history')
        .sort()
        .join(','),
      match:
        Object.keys(v0).sort().join(',') ===
        Object.keys(prod.conversationState)
          .sort()
          .filter((key) => key !== 'historyLength')
          .concat('history')
          .sort()
          .join(',')
    }
  ]

  console.log(`V0 source : ${options.capture}`)
  console.log(`production: ${prod.source}\n`)
  console.log('| field | V0 | production | match |')
  console.log('|---|---|---|---|')
  for (const check of checks) {
    console.log(
      `| ${check.field} | ${check.v0} | ${check.production} | ${check.match ? 'yes' : '**NO**'} |`
    )
  }

  const failures = checks.filter((check) => !check.match)
  console.log('\nExpected, documented differences (NOT compared for equality):')
  console.log('  - conversationId: minted per request by request.ts (crypto.randomUUID)')
  console.log('  - toolResults[0].toolUseId: minted by the upstream model per request')
  console.log('  - working directory inside the system prompt and the read-tool result text')
  console.log("  - history[1] assistant text: capture mock's canned sentence vs the real model's")
  console.log(
    `\nVERDICT: ${failures.length === 0 ? 'V0 MATCHES PRODUCTION on every comparable field' : `${failures.length} MISMATCH(ES): ${failures.map((f) => f.field).join(', ')}`}`
  )
  if (failures.length > 0) process.exitCode = 1
}

main()
