/**
 * Cross-account replay probe: does a signed reasoning envelope produced under ONE account
 * still work when the follow-up request is sent with a DIFFERENT account's token, and does
 * the model keep reasoning across that rotation?
 *
 * This is the live half of the Wave 6 checkbox "confirm multi-account rotation still works
 * with replay active" in `.omo/plans/reasoning-signature-roundtrip.md`. Plan §3.2 already
 * measured, at the AWS level, that account A's signature + account B's token returns 200.
 * What this probe adds is the multi-turn continuation shape the plugin actually produces,
 * including a history whose turns were signed by two DIFFERENT accounts.
 *
 * Turn 0 runs on account A. Turns 1 and 2 run on account B, replaying every prior turn's own
 * signature. So turn 2's history is mixed-producer: one block signed by A, one by B.
 *
 * SCOPE CAVEAT: like `ab-reasoning-probe.ts`, this builds its CodeWhisperer payloads itself.
 * It proves the MECHANISM against the real API. The plugin's own rotation + request rebuild is
 * covered offline by `src/__tests__/reasoning-replay-account-rotation.test.ts`. Neither alone
 * is sufficient; together they cover the checkbox.
 *
 * SPENDS REAL QUOTA: 3 requests. Both accounts must be pinned explicitly — there is no
 * auto-selection, so it can never land on an over-quota account by accident.
 *
 * Credentials are read from the local kiro.db at runtime (read-only). Emails are masked,
 * ARNs are masked, and signatures are reduced to `length + sha256Prefix` on every output path.
 */
import { GenerateAssistantResponseCommand } from '@aws/codewhisperer-streaming-client'
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { KIRO_CONSTANTS, extractRegionFromArn } from '../../src/constants.js'
import { describeSignatureForLog } from '../../src/plugin/log-redaction.js'
import { createSdkClient } from '../../src/plugin/sdk-client.js'
import type { Effort, KiroAuthDetails } from '../../src/plugin/types.js'

const MODEL = 'claude-opus-5'
const EFFORT: Effort = 'high'
const DRY = process.env.DRY === '1'
const CONFIRMED = process.env.CONFIRM === '1'
const ACCOUNT_A = process.env.KIRO_PROBE_ACCOUNT_A
const ACCOUNT_B = process.env.KIRO_PROBE_ACCOUNT_B
const OUT_DIR = process.env.OUT_DIR ?? join(import.meta.dir, 'results')
const PLANNED_CALLS = 3

// Mirrors src/plugin/storage/sqlite.ts:getBaseDir. Deliberately NOT imported: importing that
// module constructs the `kiroDb` singleton and runs migrations, and this probe must stay
// read-only with respect to the database.
function dbPath(): string {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'opencode', 'kiro.db')
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode', 'kiro.db')
}

interface AccountRow {
  id: string
  email: string
  region: string
  profile_arn: string | null
  access_token: string
  refresh_token: string
  expires_at: number
  used_count: number | null
  limit_count: number | null
}

function loadAccounts(emails: readonly string[]): Array<AccountRow | null> {
  const db = new Database(dbPath(), { readonly: true })
  try {
    const query = db.query(
      `SELECT id,email,region,profile_arn,access_token,refresh_token,expires_at,used_count,limit_count
         FROM accounts WHERE email = ? LIMIT 1`
    )
    return emails.map((email) => (query.get(email) as AccountRow | null) ?? null)
  } finally {
    db.close()
  }
}

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@')
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`
}

function maskArn(arn: string): string {
  const profile = arn.split('/').pop() ?? ''
  return `arn:<redacted>/${profile.slice(0, 2)}${'*'.repeat(Math.max(1, profile.length - 2))}`
}

// Every signature this probe ever holds, kept only so the result writer can PROVE none of
// them reached the JSON file.
const observedSignatures: string[] = []

function sigFingerprint(signature: string | undefined): string | undefined {
  if (!signature) return undefined
  const described = describeSignatureForLog(signature)
  return `${described.length}c sha256:${described.sha256Prefix}`
}

function headroomOf(account: AccountRow): number | null {
  if (account.limit_count === null || account.used_count === null) return null
  return account.limit_count - account.used_count
}

function toAuth(account: AccountRow): KiroAuthDetails {
  return {
    refresh: account.refresh_token,
    access: account.access_token,
    expires: account.expires_at,
    authMethod: 'idc',
    region: account.region as KiroAuthDetails['region'],
    profileArn: account.profile_arn ?? undefined,
    email: account.email
  }
}

const TOOL_SPEC = {
  toolSpecification: {
    name: 'db_get',
    description:
      'Fetch one record from the chained ledger by key. Returns {value, op, next_key}. ' +
      'You may only fetch ONE key per response.',
    inputSchema: {
      json: {
        type: 'object',
        properties: { key: { type: 'string', description: 'Record key, e.g. "step1"' } },
        required: ['key']
      }
    }
  }
}

const OPENING_PROMPT = [
  'You are walking a chained ledger. Rules you must follow exactly:',
  '1. Call db_get for exactly ONE key per response. Never batch two calls.',
  '2. Start with key "step1". Each record tells you the next_key to fetch.',
  '3. Each record has an "op" that says how to fold its "value" into the running total:',
  '   op="seed" -> total = value; op="multiply" -> total = total * value.',
  '4. BEFORE each call, reason step by step about the current running total and show',
  '   your arithmetic. Re-verify the running total from scratch each time.',
  '5. When next_key is null, stop calling tools and state the final total.',
  'Begin by reasoning about the plan, then fetch "step1".'
].join('\n')

// 17 * 3 = 51
const CANNED_RESULTS = [
  { value: 17, op: 'seed', next_key: 'step2' },
  { value: 3, op: 'multiply', next_key: null }
]
const EXPECTED_FINAL = 51

interface ToolUse {
  toolUseId: string
  name: string
  input: Record<string, unknown> | string
}

interface Drained {
  reasoningFrames: number
  reasoningTextFrames: number
  reasoningSigFrames: number
  reasoningText: string
  signature?: string
  content: string
  toolUses: ToolUse[]
  requestId?: string
}

interface TurnObs {
  turn: number
  accountLabel: 'A' | 'B'
  accountMasked: string
  http: number | string
  errorName?: string
  errorMessage?: string
  reasoningFrames: number
  reasoningChars: number
  signaturePresent: boolean
  signatureLen: number
  signatureFingerprint?: string
  toolKeys: string[]
  textChars: number
  text: string
  latencyMs: number
  /** How many history turns carried a replayed signature, and which account signed each. */
  historyReplay: Array<{ signedBy: 'A' | 'B'; signatureFingerprint: string }>
  requestId?: string
}

async function drain(response: unknown): Promise<Drained> {
  const stream = (response as { generateAssistantResponseResponse: AsyncIterable<any> })
    .generateAssistantResponseResponse
  const out: Drained = {
    reasoningFrames: 0,
    reasoningTextFrames: 0,
    reasoningSigFrames: 0,
    reasoningText: '',
    content: '',
    toolUses: [],
    requestId: (response as { $metadata?: { requestId?: string } })?.$metadata?.requestId
  }
  const partial = new Map<string, { name: string; input: string }>()
  for await (const event of stream) {
    if (event.reasoningContentEvent) {
      const reasoning = event.reasoningContentEvent
      out.reasoningFrames++
      if (typeof reasoning.text === 'string' && reasoning.text.length > 0) {
        out.reasoningTextFrames++
        out.reasoningText += reasoning.text
      }
      if (reasoning.signature) {
        out.reasoningSigFrames++
        out.signature = (out.signature ?? '') + reasoning.signature
        observedSignatures.push(String(reasoning.signature))
      }
      continue
    }
    if (event.assistantResponseEvent?.content) {
      out.content += event.assistantResponseEvent.content
      continue
    }
    if (event.toolUseEvent) {
      const toolEvent = event.toolUseEvent
      const id: string = toolEvent.toolUseId ?? 'unknown'
      const current = partial.get(id) ?? { name: toolEvent.name ?? '', input: '' }
      if (toolEvent.name) current.name = toolEvent.name
      if (typeof toolEvent.input === 'string') current.input += toolEvent.input
      partial.set(id, current)
      if (toolEvent.stop) {
        let parsed: Record<string, unknown> | string = current.input
        try {
          parsed = current.input ? JSON.parse(current.input) : {}
        } catch {
          /* keep the raw fragment */
        }
        out.toolUses.push({ toolUseId: id, name: current.name, input: parsed })
      }
    }
  }
  return out
}

function userMessage(content: string, toolResults?: unknown[]): Record<string, unknown> {
  const context: Record<string, unknown> = { tools: [TOOL_SPEC] }
  if (toolResults && toolResults.length > 0) context.toolResults = toolResults
  return {
    userInputMessage: {
      content,
      modelId: MODEL,
      origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
      userInputMessageContext: context
    }
  }
}

interface Exchange {
  user: Record<string, unknown>
  assistant: Drained
  signedBy: 'A' | 'B'
}

function assistantMessage(exchange: Exchange): Record<string, unknown> {
  const message: Record<string, unknown> = {
    content: exchange.assistant.content || '[continuing]'
  }
  if (exchange.assistant.toolUses.length > 0) {
    message.toolUses = exchange.assistant.toolUses.map((tool) => ({
      input: tool.input,
      name: tool.name,
      toolUseId: tool.toolUseId
    }))
  }
  if (exchange.assistant.reasoningText && exchange.assistant.signature) {
    message.reasoningContent = {
      reasoningText: {
        text: exchange.assistant.reasoningText,
        signature: exchange.assistant.signature
      }
    }
  }
  return { assistantResponseMessage: message }
}

function syntheticDrained(turn: number): Drained {
  return {
    reasoningFrames: 3,
    reasoningTextFrames: 2,
    reasoningSigFrames: 1,
    reasoningText: 'synthetic reasoning '.repeat(5),
    signature: 'S'.repeat(340),
    content: 'synthetic content',
    toolUses: [{ toolUseId: `tu-${turn}`, name: 'db_get', input: { key: `step${turn + 1}` } }]
  }
}

async function main(): Promise<void> {
  if (!ACCOUNT_A || !ACCOUNT_B) {
    console.log(
      'REFUSING: both KIRO_PROBE_ACCOUNT_A and KIRO_PROBE_ACCOUNT_B must be set. This probe ' +
        'never auto-selects, so it cannot land on an over-quota account by accident.'
    )
    process.exit(2)
  }
  if (ACCOUNT_A === ACCOUNT_B) {
    console.log('REFUSING: the two accounts must differ — otherwise nothing is cross-account.')
    process.exit(2)
  }

  const [rowA, rowB] = loadAccounts([ACCOUNT_A, ACCOUNT_B])
  if (!rowA || !rowB) {
    console.log(
      `CANNOT AUTHENTICATE: no account matching ${!rowA ? maskEmail(ACCOUNT_A) : maskEmail(ACCOUNT_B)}`
    )
    process.exit(1)
  }
  if (rowA.id === rowB.id) {
    console.log('REFUSING: both emails resolved to the same stored account id.')
    process.exit(2)
  }

  const authA = toAuth(rowA)
  const authB = toAuth(rowB)
  const regionA = extractRegionFromArn(authA.profileArn) ?? rowA.region
  const regionB = extractRegionFromArn(authB.profileArn) ?? rowB.region
  const headroomA = headroomOf(rowA)
  const headroomB = headroomOf(rowB)

  console.log(
    `A=${maskEmail(rowA.email)} region=${regionA} headroom=${headroomA ?? 'unknown'} | ` +
      `B=${maskEmail(rowB.email)} region=${regionB} headroom=${headroomB ?? 'unknown'}`
  )
  console.log(
    `model=${MODEL} effort=${EFFORT} plannedCalls=${PLANNED_CALLS} dry=${DRY} ` +
      `arnA=${authA.profileArn ? maskArn(authA.profileArn) : 'none'} ` +
      `arnB=${authB.profileArn ? maskArn(authB.profileArn) : 'none'}`
  )

  if (!DRY) {
    if (!CONFIRMED) {
      console.log(
        `REFUSING: this run spends ${PLANNED_CALLS} real requests. Re-run with CONFIRM=1 ` +
          '(or DRY=1 to inspect wire shapes for free).'
      )
      process.exit(2)
    }
    for (const [label, headroom] of [
      ['A', headroomA],
      ['B', headroomB]
    ] as const) {
      if (headroom !== null && headroom < PLANNED_CALLS) {
        console.log(
          `REFUSING: account ${label} headroom ${headroom} < plannedCalls ${PLANNED_CALLS}.`
        )
        process.exit(2)
      }
    }
    for (const [label, row] of [
      ['A', rowA],
      ['B', rowB]
    ] as const) {
      if (row.expires_at - Date.now() < 120_000) {
        console.log(
          `CANNOT AUTHENTICATE: account ${label}'s access token is expired or near expiry. ` +
            'Start OpenCode once to refresh it, then re-run (this probe never writes to kiro.db).'
        )
        process.exit(1)
      }
    }
  }

  const clientA = DRY ? null : createSdkClient(authA, regionA, EFFORT)
  const clientB = DRY ? null : createSdkClient(authB, regionB, EFFORT)
  const done: Exchange[] = []
  const turns: TurnObs[] = []
  let calls = 0

  for (let turn = 0; turn < PLANNED_CALLS; turn++) {
    // Turn 0 produces the first signature on account A; every later turn runs on account B
    // while replaying it, so the rotation is what is under test.
    const accountLabel: 'A' | 'B' = turn === 0 ? 'A' : 'B'
    const client = accountLabel === 'A' ? clientA : clientB
    const auth = accountLabel === 'A' ? authA : authB
    const masked = maskEmail(accountLabel === 'A' ? rowA.email : rowB.email)

    let current: Record<string, unknown>
    if (turn === 0) {
      current = userMessage(OPENING_PROMPT)
    } else {
      const previous = done[done.length - 1]
      const canned = CANNED_RESULTS[turn - 1]
      const firstToolUse = previous?.assistant.toolUses[0]
      if (!firstToolUse || !canned) {
        console.log(`STOPPING at turn ${turn}: previous turn requested no tool.`)
        break
      }
      current = userMessage('Tool results provided.', [
        {
          toolUseId: firstToolUse.toolUseId,
          content: [{ text: JSON.stringify(canned) }],
          status: 'success'
        }
      ])
    }

    const history: Record<string, unknown>[] = []
    const historyReplay: TurnObs['historyReplay'] = []
    for (const exchange of done) {
      history.push(exchange.user)
      const assistant = assistantMessage(exchange)
      const reasoning = (assistant.assistantResponseMessage as { reasoningContent?: unknown })
        .reasoningContent
      if (reasoning) {
        historyReplay.push({
          signedBy: exchange.signedBy,
          signatureFingerprint: sigFingerprint(exchange.assistant.signature) ?? 'none'
        })
      }
      history.push(assistant)
    }

    const conversationState: Record<string, unknown> = {
      chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL,
      // Fresh per request, exactly like the plugin (`request.ts`). §3.2 measured that the
      // signature is not bound to it.
      conversationId: randomUUID(),
      currentMessage: current
    }
    if (history.length > 0) conversationState.history = history
    const payload: Record<string, unknown> = { conversationState }
    if (auth.profileArn) payload.profileArn = auth.profileArn

    if (DRY) {
      const shape = JSON.stringify(payload, (key, value) => {
        if (key === 'signature') return `<sig ${String(value).length}c>`
        if (key === 'profileArn' && typeof value === 'string') return maskArn(value)
        if (key === 'text' && typeof value === 'string' && value.length > 60) {
          return `<text ${value.length}c>`
        }
        return value
      })
      console.log(
        `  DRY turn ${turn} on account ${accountLabel} (${masked}): ` +
          `historyReplay=${JSON.stringify(historyReplay)} len=${shape.length}`
      )
      console.log(`    ${shape.slice(0, 900)}`)
      done.push({ user: current, assistant: syntheticDrained(turn), signedBy: accountLabel })
      continue
    }

    const startedAt = Date.now()
    try {
      calls++
      if (!client) throw new Error('internal: a non-dry turn reached the send with no client')
      const response = await client.send(new GenerateAssistantResponseCommand(payload as never))
      const got = await drain(response)
      const observation: TurnObs = {
        turn,
        accountLabel,
        accountMasked: masked,
        http:
          (response as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ??
          'unknown',
        reasoningFrames: got.reasoningFrames,
        reasoningChars: got.reasoningText.length,
        signaturePresent: Boolean(got.signature),
        signatureLen: got.signature?.length ?? 0,
        signatureFingerprint: sigFingerprint(got.signature),
        toolKeys: got.toolUses.map((tool) =>
          typeof tool.input === 'object' && tool.input !== null
            ? String((tool.input as Record<string, unknown>).key ?? tool.name)
            : tool.name
        ),
        textChars: got.content.length,
        text: got.content,
        latencyMs: Date.now() - startedAt,
        historyReplay,
        requestId: got.requestId
      }
      turns.push(observation)
      done.push({ user: current, assistant: got, signedBy: accountLabel })
      console.log(
        `  turn ${turn} acct=${accountLabel} http=${observation.http} ` +
          `frames=${observation.reasoningFrames} reasonChars=${observation.reasoningChars} ` +
          `sig=${observation.signatureFingerprint ?? 'NONE'} ` +
          `tools=${JSON.stringify(observation.toolKeys)} textChars=${observation.textChars} ` +
          `histReplay=${JSON.stringify(historyReplay.map((entry) => entry.signedBy))} ` +
          `${observation.latencyMs}ms`
      )
      if (turn > 0 && got.toolUses.length === 0) {
        console.log(`  model finished at turn ${turn} (no tool call)`)
        break
      }
    } catch (e: unknown) {
      const err = e as {
        message?: string
        name?: string
        $metadata?: { httpStatusCode?: number; requestId?: string }
      }
      const message = String(err?.message ?? e)
      turns.push({
        turn,
        accountLabel,
        accountMasked: masked,
        http: err?.$metadata?.httpStatusCode ?? 'network/none',
        errorName: err?.name ?? 'Error',
        errorMessage: message.slice(0, 600),
        reasoningFrames: 0,
        reasoningChars: 0,
        signaturePresent: false,
        signatureLen: 0,
        toolKeys: [],
        textChars: 0,
        text: '',
        latencyMs: Date.now() - startedAt,
        historyReplay,
        requestId: err?.$metadata?.requestId
      })
      console.log(
        `  turn ${turn} acct=${accountLabel}: ERROR http=${err?.$metadata?.httpStatusCode ?? 'none'} ` +
          `${err?.name}: ${message.slice(0, 400)}`
      )
      break
    }
  }

  console.log('\n================ PER-TURN TABLE ================')
  console.log('turn\tacct\thttp\tframes\treasonChars\tsigLen\ttools\thistSignedBy')
  for (const turn of turns) {
    console.log(
      [
        turn.turn,
        turn.accountLabel,
        turn.http,
        turn.reasoningFrames,
        turn.reasoningChars,
        turn.signaturePresent ? turn.signatureLen : 0,
        turn.toolKeys.join(',') || '-',
        turn.historyReplay.map((entry) => entry.signedBy).join(',') || '-'
      ].join('\t')
    )
  }

  const crossAccountTurns = turns.filter(
    (turn) =>
      turn.accountLabel === 'B' && turn.historyReplay.some((entry) => entry.signedBy === 'A')
  )
  // An empty `every` is vacuously true, which is exactly the kind of false positive this
  // project refuses elsewhere: with zero cross-account turns the run proves nothing.
  const crossAccountAccepted =
    crossAccountTurns.length > 0 && crossAccountTurns.every((turn) => turn.http === 200)
  const reasoningContinued =
    crossAccountTurns.length > 0 && crossAccountTurns.every((turn) => turn.reasoningFrames > 0)
  const finalTurn = turns[turns.length - 1]
  const finalCorrect = finalTurn
    ? new RegExp(`\\b${EXPECTED_FINAL}\\b`).test(finalTurn.text)
    : false

  console.log('\n================ VERDICT ================')
  console.log(`cross-account replay turns: ${crossAccountTurns.length}`)
  console.log(`all accepted (HTTP 200):    ${crossAccountAccepted}`)
  console.log(`reasoning continued:        ${reasoningContinued}`)
  console.log(`final answer ${EXPECTED_FINAL}:            ${finalCorrect}`)
  console.log(`\nREAL API CALLS THIS RUN: ${calls}`)
  console.log(`FINAL TEXT: ${(finalTurn?.text ?? '').slice(0, 300).replace(/\n/g, ' | ')}`)

  const finishedAt = new Date().toISOString()
  const result = {
    schemaVersion: 1,
    probe: 'cross-account-replay-probe',
    finishedAt,
    dry: DRY,
    model: MODEL,
    effort: EFFORT,
    plannedCalls: PLANNED_CALLS,
    realApiCalls: calls,
    accounts: {
      A: { masked: maskEmail(rowA.email), region: regionA, headroomBefore: headroomA },
      B: { masked: maskEmail(rowB.email), region: regionB, headroomBefore: headroomB }
    },
    verdict: {
      crossAccountReplayTurns: crossAccountTurns.length,
      allAcceptedHttp200: crossAccountAccepted,
      reasoningContinued,
      finalAnswerCorrect: finalCorrect,
      expectedFinal: EXPECTED_FINAL
    },
    turns
  }
  const outPath = join(
    OUT_DIR,
    `cross-account-replay-${finishedAt.replace(/[:.]/g, '-')}${DRY ? '-dry' : ''}.json`
  )
  mkdirSync(dirname(outPath), { recursive: true })
  const serialized = JSON.stringify(result, null, 2)
  for (const row of [rowA, rowB]) {
    if (serialized.includes(row.email)) throw new Error('refusing to write an unmasked email')
    if (serialized.includes(row.access_token) || serialized.includes(row.refresh_token)) {
      throw new Error('refusing to write a token')
    }
    if (row.profile_arn && serialized.includes(row.profile_arn)) {
      throw new Error('refusing to write a profileArn')
    }
  }
  for (const signature of observedSignatures) {
    if (signature.length > 0 && serialized.includes(signature)) {
      throw new Error('refusing to write a raw reasoning signature')
    }
  }
  writeFileSync(outPath, `${serialized}\n`)
  console.log(`\nRAW RESULTS: ${outPath}`)
}

main().catch((e) => {
  console.error('PROBE CRASHED', e)
  process.exit(1)
})
