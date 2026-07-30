/**
 * A/B probe: does replaying signed reasoning in `conversationState.history` keep the
 * model REASONING on later tool-loop turns? This is the measurement behind §3.1 of
 * `.omo/plans/reasoning-signature-roundtrip.md`.
 *
 * Arm A: every prior assistant turn in history carries the nested wire form
 *        `reasoningContent:{reasoningText:{text,signature}}`, using the signature
 *        genuinely captured from that turn's OWN response.
 * Arm B: identical conversation with NO `reasoningContent` in history.
 *
 * Prompts, tools, tool results, model, effort, region and conversationId strategy are
 * identical between arms. Tool results are canned BY TURN INDEX, not by what the model
 * asked for, so the arms cannot diverge on content.
 *
 * SPENDS REAL QUOTA. Every non-DRY run costs `(TURNS + 1) * 2` requests. See README.md.
 *
 * Credentials are read from the local kiro.db at runtime; nothing is embedded. Emails
 * are masked and signatures are reduced to `length + sha256Prefix` on every output
 * path, including the result JSON.
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
import { fetchUsageLimits } from '../../src/plugin/usage.js'

const MODEL = 'claude-opus-5'
const EFFORT: Effort = 'high'
const TURNS = Number(process.env.TURNS ?? 4)
const DRY = process.env.DRY === '1'
const ORDER = (process.env.ORDER ?? 'AB').toUpperCase()
const PINNED_ACCOUNT = process.env.KIRO_PROBE_ACCOUNT
const CONFIRMED = process.env.CONFIRM === '1'
const OUT_DIR = process.env.OUT_DIR ?? join(import.meta.dir, 'results')

// Mirrors src/plugin/storage/sqlite.ts:getBaseDir. Deliberately NOT imported: importing
// that module constructs the `kiroDb` singleton and runs migrations, and this probe must
// stay read-only with respect to the database.
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

function loadAccount(): AccountRow | null {
  const db = new Database(dbPath(), { readonly: true })
  try {
    if (PINNED_ACCOUNT) {
      const row = db
        .query(
          `SELECT id,email,region,profile_arn,access_token,refresh_token,expires_at,used_count,limit_count
             FROM accounts WHERE email = ? LIMIT 1`
        )
        .get(PINNED_ACCOUNT) as AccountRow | null
      return row
    }
    return db
      .query(
        `SELECT id,email,region,profile_arn,access_token,refresh_token,expires_at,used_count,limit_count
           FROM accounts
          WHERE is_healthy=1 AND used_count < limit_count
          ORDER BY (limit_count - used_count) DESC
          LIMIT 1`
      )
      .get() as AccountRow | null
  } finally {
    db.close()
  }
}

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@')
  const head = local.slice(0, 2)
  return `${head}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`
}

// Every signature this probe ever holds, kept only so the result writer can PROVE
// none of them reached the JSON file.
const observedSignatures: string[] = []

function maskArn(arn: string): string {
  const profile = arn.split('/').pop() ?? ''
  return `arn:<redacted>/${profile.slice(0, 2)}${'*'.repeat(Math.max(1, profile.length - 2))}`
}

function sigFingerprint(signature: string | undefined): string | undefined {
  if (!signature) return undefined
  const described = describeSignatureForLog(signature)
  return `${described.length}c sha256:${described.sha256Prefix}`
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
  '   op="seed" -> total = value; op="multiply" -> total = total * value;',
  '   op="add" -> total = total + value; op="divide" -> total = total / value.',
  '4. BEFORE each call, reason step by step about the current running total and show',
  '   your arithmetic. Re-verify the running total from scratch each time.',
  '5. When next_key is null, stop calling tools and state the final total.',
  'Begin by reasoning about the plan, then fetch "step1".'
].join('\n')

// ((17 * 23) + 149) / 6 = (391 + 149) / 6 = 540 / 6 = 90
const CANNED_RESULTS = [
  { key: 'step1', value: 17, op: 'seed', next_key: 'step2' },
  { key: 'step2', value: 23, op: 'multiply', next_key: 'step3' },
  { key: 'step3', value: 149, op: 'add', next_key: 'step4' },
  { key: 'step4', value: 6, op: 'divide', next_key: null }
]
const EXPECTED_FINAL = 90
const NUDGE = 'Continue following the ledger rules.'

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
  http: number | string
  errorName?: string
  errorMessage?: string
  reasoningFrames: number
  reasoningTextFrames: number
  reasoningSigFrames: number
  reasoningChars: number
  signaturePresent: boolean
  signatureLen: number
  signatureFingerprint?: string
  toolKeys: string[]
  textChars: number
  text: string
  latencyMs: number
  historyReasoningTurns: number
  requestId?: string
}

async function drain(response: any): Promise<Drained> {
  const out: Drained = {
    reasoningFrames: 0,
    reasoningTextFrames: 0,
    reasoningSigFrames: 0,
    reasoningText: '',
    content: '',
    toolUses: [],
    requestId: response?.$metadata?.requestId
  }
  const partial = new Map<string, { name: string; input: string }>()
  for await (const event of response.generateAssistantResponseResponse) {
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
  const ctx: Record<string, unknown> = { tools: [TOOL_SPEC] }
  if (toolResults && toolResults.length > 0) ctx.toolResults = toolResults
  return {
    userInputMessage: {
      content,
      modelId: MODEL,
      origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
      userInputMessageContext: ctx
    }
  }
}

function assistantMessage(
  drained: Drained,
  withReasoning: boolean
): { assistantResponseMessage: Record<string, unknown> } {
  const message: Record<string, unknown> = { content: drained.content || '[continuing]' }
  if (drained.toolUses.length > 0) {
    message.toolUses = drained.toolUses.map((tool) => ({
      input: tool.input,
      name: tool.name,
      toolUseId: tool.toolUseId
    }))
  }
  if (withReasoning && drained.reasoningText && drained.signature) {
    message.reasoningContent = {
      reasoningText: { text: drained.reasoningText, signature: drained.signature }
    }
  }
  return { assistantResponseMessage: message }
}

interface Exchange {
  user: Record<string, unknown>
  assistant: Drained
}

interface ArmResult {
  label: string
  turns: TurnObs[]
  sigInvalid?: string
  strippedRetryAt?: number
  calls: number
}

async function runArm(
  label: string,
  withReasoning: boolean,
  auth: KiroAuthDetails,
  region: string
): Promise<ArmResult> {
  const client = DRY ? null : createSdkClient(auth, region, EFFORT)
  const conversationId = randomUUID()
  const done: Exchange[] = []
  const turns: TurnObs[] = []
  let replay = withReasoning
  let sigInvalid: string | undefined
  let strippedRetryAt: number | undefined
  let calls = 0

  for (let turn = 0; turn <= TURNS; turn++) {
    let current: Record<string, unknown>
    if (turn === 0) {
      current = userMessage(OPENING_PROMPT)
    } else {
      const previous = done[done.length - 1]?.assistant
      const canned = CANNED_RESULTS[turn - 1]
      const firstToolUse = previous?.toolUses[0]
      if (firstToolUse && canned) {
        current = userMessage('Tool results provided.', [
          {
            toolUseId: firstToolUse.toolUseId,
            content: [
              {
                text: JSON.stringify({
                  value: canned.value,
                  op: canned.op,
                  next_key: canned.next_key
                })
              }
            ],
            status: 'success'
          }
        ])
      } else {
        current = userMessage(NUDGE)
      }
    }

    const history: Record<string, unknown>[] = []
    let historyReasoningTurns = 0
    for (const exchange of done) {
      history.push(exchange.user)
      const assistant = assistantMessage(exchange.assistant, replay)
      if (assistant.assistantResponseMessage.reasoningContent) historyReasoningTurns++
      history.push(assistant)
    }

    const conversationState: Record<string, unknown> = {
      chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL,
      conversationId,
      currentMessage: current
    }
    if (history.length > 0) conversationState.history = history
    const payload: Record<string, unknown> = { conversationState }
    if (auth.profileArn) payload.profileArn = auth.profileArn

    if (DRY) {
      // The DRY dump is meant to be pasteable into an issue, so it must not carry the
      // signature, the signed reasoning text, or the account's profile ARN.
      const shape = JSON.stringify(payload, (key, value) => {
        if (key === 'signature') return `<sig ${String(value).length}c>`
        if (key === 'profileArn' && typeof value === 'string') return maskArn(value)
        if (key === 'text' && typeof value === 'string' && value.length > 60) {
          return `<text ${value.length}c>`
        }
        return value
      })
      console.log(
        `  [${label}] DRY turn ${turn}: histTurnsWithReasoning=${historyReasoningTurns} len=${shape.length}`
      )
      console.log(`    ${shape.slice(0, 1400)}`)
      done.push({
        user: current,
        assistant: {
          reasoningFrames: 3,
          reasoningTextFrames: 2,
          reasoningSigFrames: 1,
          reasoningText: 'synthetic reasoning '.repeat(10),
          signature: 'S'.repeat(560),
          content: 'synthetic content',
          toolUses: [{ toolUseId: `tu-${turn}`, name: 'db_get', input: { key: `step${turn + 1}` } }]
        }
      })
      continue
    }

    const startedAt = Date.now()
    try {
      calls++
      const response = await client!.send(new GenerateAssistantResponseCommand(payload as never))
      const got = await drain(response)
      const observation: TurnObs = {
        turn,
        http:
          (response as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ??
          'unknown',
        reasoningFrames: got.reasoningFrames,
        reasoningTextFrames: got.reasoningTextFrames,
        reasoningSigFrames: got.reasoningSigFrames,
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
        historyReasoningTurns,
        requestId: got.requestId
      }
      turns.push(observation)
      done.push({ user: current, assistant: got })
      console.log(
        `  [${label}] turn ${turn}: http=${observation.http} frames=${observation.reasoningFrames}` +
          ` (text=${got.reasoningTextFrames}/sig=${got.reasoningSigFrames})` +
          ` reasonChars=${observation.reasoningChars} sig=${observation.signatureFingerprint ?? 'NONE'}` +
          ` tools=${JSON.stringify(observation.toolKeys)} textChars=${observation.textChars}` +
          ` histReplay=${historyReasoningTurns} ${observation.latencyMs}ms`
      )
      if (turn > 0 && got.toolUses.length === 0) {
        console.log(`  [${label}] model finished at turn ${turn} (no tool call)`)
        break
      }
    } catch (e: unknown) {
      const err = e as {
        message?: string
        name?: string
        $metadata?: { httpStatusCode?: number; requestId?: string }
      }
      const message = String(err?.message ?? e)
      const observation: TurnObs = {
        turn,
        http: err?.$metadata?.httpStatusCode ?? 'network/none',
        errorName: err?.name ?? 'Error',
        errorMessage: message.slice(0, 600),
        reasoningFrames: 0,
        reasoningTextFrames: 0,
        reasoningSigFrames: 0,
        reasoningChars: 0,
        signaturePresent: false,
        signatureLen: 0,
        toolKeys: [],
        textChars: 0,
        text: '',
        latencyMs: Date.now() - startedAt,
        historyReasoningTurns,
        requestId: err?.$metadata?.requestId
      }
      turns.push(observation)
      console.log(
        `  [${label}] turn ${turn}: ERROR http=${observation.http} ${observation.errorName}: ${observation.errorMessage}`
      )
      const looksLikeSignature =
        /THINKING_SIGNATURE_INVALID/i.test(message) || /signature/i.test(message)
      if (looksLikeSignature && replay && strippedRetryAt === undefined) {
        sigInvalid = `turn ${turn}: ${observation.errorName}: ${message.slice(0, 400)}`
        strippedRetryAt = turn
        replay = false
        console.log(`  !! signature rejected — stripping history reasoning, retrying turn ${turn}`)
        turn--
        continue
      }
      break
    }
  }

  return { label, turns, sigInvalid, strippedRetryAt, calls }
}

function answerVerdict(turn: TurnObs): string {
  if (!turn.text) return '-'
  return new RegExp(`\\b${EXPECTED_FINAL}\\b`).test(turn.text)
    ? `CORRECT(${EXPECTED_FINAL})`
    : 'no-90'
}

function sumFrom(turns: TurnObs[], pick: (turn: TurnObs) => number, from: number): number {
  return turns.filter((turn) => turn.turn >= from).reduce((total, turn) => total + pick(turn), 0)
}

async function main(): Promise<void> {
  const account = loadAccount()
  if (!account) {
    console.log(
      PINNED_ACCOUNT
        ? `CANNOT AUTHENTICATE: no account matching KIRO_PROBE_ACCOUNT=${maskEmail(PINNED_ACCOUNT)}`
        : 'CANNOT AUTHENTICATE: no healthy account with remaining quota'
    )
    process.exit(1)
  }

  const plannedCalls = (TURNS + 1) * 2
  const headroom =
    account.limit_count !== null && account.used_count !== null
      ? account.limit_count - account.used_count
      : null
  const auth: KiroAuthDetails = {
    refresh: account.refresh_token,
    access: account.access_token,
    expires: account.expires_at,
    authMethod: 'idc',
    region: account.region as KiroAuthDetails['region'],
    profileArn: account.profile_arn ?? undefined,
    email: account.email
  }
  const region = extractRegionFromArn(auth.profileArn) ?? account.region
  console.log(
    `account=${maskEmail(account.email)} region=${region} model=${MODEL} effort=${EFFORT} ` +
      `plannedCalls=${plannedCalls} headroom=${headroom ?? 'unknown'} order=${ORDER} dry=${DRY}`
  )

  if (!DRY) {
    if (!CONFIRMED) {
      console.log(
        `REFUSING: this run spends ${plannedCalls} real requests. Re-run with CONFIRM=1 ` +
          '(or DRY=1 to inspect wire shapes for free).'
      )
      process.exit(2)
    }
    if (headroom !== null && headroom < plannedCalls) {
      console.log(`REFUSING: account headroom ${headroom} < plannedCalls ${plannedCalls}.`)
      process.exit(2)
    }
    if (account.expires_at - Date.now() < 120_000) {
      console.log(
        'CANNOT AUTHENTICATE: access token expired or near expiry. Start OpenCode once to ' +
          'refresh it, then re-run (this probe never writes to kiro.db).'
      )
      process.exit(1)
    }
  }

  let before: { usedCount?: number; limitCount?: number } | null = null
  if (!DRY) {
    try {
      before = await fetchUsageLimits(auth)
      console.log(`USAGE BEFORE: used=${before.usedCount} limit=${before.limitCount}`)
    } catch (e: unknown) {
      console.log(`USAGE BEFORE: unavailable (${(e as Error)?.message})`)
    }
  }

  let armA: ArmResult
  let armB: ArmResult
  if (ORDER === 'BA') {
    console.log("\n=== ARM B first: today's behavior (no reasoningContent in history) ===")
    armB = await runArm('B', false, auth, region)
    console.log('\n=== ARM A: native replay (nested reasoningContent + real signature) ===')
    armA = await runArm('A', true, auth, region)
  } else {
    console.log('\n=== ARM A: native replay (nested reasoningContent + real signature) ===')
    armA = await runArm('A', true, auth, region)
    console.log("\n=== ARM B: today's behavior (no reasoningContent in history) ===")
    armB = await runArm('B', false, auth, region)
  }

  console.log('\n================ PER-TURN TABLE ================')
  console.log('turn\tarm\thttp\tframes\treasonChars\tsigLen\ttools\tanswer\thistReplay')
  const rows: Array<[number, string, TurnObs]> = []
  const maxTurn = Math.max(armA.turns.length, armB.turns.length)
  for (let i = 0; i < maxTurn; i++) {
    const a = armA.turns[i]
    const b = armB.turns[i]
    if (a) rows.push([i, 'A', a])
    if (b) rows.push([i, 'B', b])
  }
  for (const [index, arm, turn] of rows) {
    console.log(
      [
        index,
        arm,
        turn.http,
        turn.reasoningFrames,
        turn.reasoningChars,
        turn.signaturePresent ? turn.signatureLen : 0,
        turn.toolKeys.join(',') || '-',
        answerVerdict(turn),
        turn.historyReasoningTurns
      ].join('\t')
    )
  }

  console.log('\n================ AGGREGATES ================')
  for (const [label, arm] of [
    ['A', armA],
    ['B', armB]
  ] as const) {
    console.log(
      `Arm ${label}: turn>=1 frames=${sumFrom(arm.turns, (t) => t.reasoningFrames, 1)} ` +
        `chars=${sumFrom(arm.turns, (t) => t.reasoningChars, 1)} | ` +
        `turn>=2 frames=${sumFrom(arm.turns, (t) => t.reasoningFrames, 2)} ` +
        `chars=${sumFrom(arm.turns, (t) => t.reasoningChars, 2)} | ` +
        `all frames=${sumFrom(arm.turns, (t) => t.reasoningFrames, 0)} ` +
        `chars=${sumFrom(arm.turns, (t) => t.reasoningChars, 0)}`
    )
  }
  if (armA.sigInvalid) console.log(`Arm A SIGNATURE REJECTION: ${armA.sigInvalid}`)
  if (armA.strippedRetryAt !== undefined) {
    console.log(`Arm A stripped-history retry at turn ${armA.strippedRetryAt}`)
  }

  console.log('\n================ FINAL TEXT (last turn per arm) ================')
  for (const [label, arm] of [
    ['A', armA],
    ['B', armB]
  ] as const) {
    const last = arm.turns[arm.turns.length - 1]
    console.log(`${label}: ${(last?.text ?? '').slice(0, 300).replace(/\n/g, ' | ')}`)
  }

  console.log(`\nREAL API CALLS THIS RUN: ${armA.calls + armB.calls}`)
  let after: { usedCount?: number; limitCount?: number } | null = null
  if (!DRY) {
    try {
      after = await fetchUsageLimits(auth)
      console.log(
        `USAGE AFTER: used=${after.usedCount} limit=${after.limitCount}` +
          (before?.usedCount !== undefined && after.usedCount !== undefined
            ? ` (delta=${after.usedCount - before.usedCount})`
            : '')
      )
    } catch (e: unknown) {
      console.log(`USAGE AFTER: unavailable (${(e as Error)?.message})`)
    }
  }

  const startedIso = new Date().toISOString()
  const result = {
    schemaVersion: 1,
    probe: 'ab-reasoning-probe',
    finishedAt: startedIso,
    dry: DRY,
    order: ORDER,
    model: MODEL,
    effort: EFFORT,
    region,
    turnsConfigured: TURNS,
    account: { masked: maskEmail(account.email), headroomBefore: headroom },
    usage: { before: before?.usedCount ?? null, after: after?.usedCount ?? null },
    realApiCalls: armA.calls + armB.calls,
    arms: {
      A: { turns: armA.turns, sigInvalid: armA.sigInvalid, strippedRetryAt: armA.strippedRetryAt },
      B: { turns: armB.turns, sigInvalid: armB.sigInvalid, strippedRetryAt: armB.strippedRetryAt }
    }
  }
  const outPath = join(
    OUT_DIR,
    `ab-reasoning-${startedIso.replace(/[:.]/g, '-')}-${ORDER}${DRY ? '-dry' : ''}.json`
  )
  mkdirSync(dirname(outPath), { recursive: true })
  const serialized = JSON.stringify(result, null, 2)
  if (serialized.includes(account.email)) throw new Error('refusing to write an unmasked email')
  for (const signature of observedSignatures) {
    if (signature.length > 0 && serialized.includes(signature)) {
      throw new Error('refusing to write a raw reasoning signature')
    }
  }
  if (serialized.includes(auth.access) || serialized.includes(auth.refresh)) {
    throw new Error('refusing to write a token')
  }
  if (auth.profileArn && serialized.includes(auth.profileArn)) {
    throw new Error('refusing to write a profileArn')
  }
  writeFileSync(outPath, `${serialized}\n`)
  console.log(`\nRAW RESULTS: ${outPath}`)
}

main().catch((e) => {
  console.error('PROBE CRASHED', e)
  process.exit(1)
})
