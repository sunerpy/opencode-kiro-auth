/**
 * Turn-2 variant probe: isolate WHICH element of this plugin's request translation makes the
 * model end its turn after a single successful tool call.
 *
 * All three premature stops observed in the committed 24-run OpenCode A/B happened at the
 * turn-1 -> turn-2 transition, so a whole 10-hop run is not needed to study them. This probe
 * replays exactly that transition: it loads the inbound OpenAI-shaped body captured for free
 * by `capture-inbound.ts`, drives the REAL `transformToSdkRequest` over it (so V0 is
 * production output rather than a hand-written approximation), then patches exactly ONE
 * element per variant and measures the rate of "HTTP 200, no tool call" over N trials.
 *
 * One trial costs ONE real request (two for `stableConvId`, which needs a priming call), so a
 * statistically useful N is affordable.
 *
 * Outcome vocabulary, kept deliberately separate because they are different failures:
 *   continued  - the model emitted a tool call, i.e. the loop would have carried on
 *   stopped    - HTTP 200, no tool call, but real assistant text (the reported symptom)
 *   empty200   - HTTP 200 with no tool call, no text and no reasoning (a known distinct bug)
 *   error      - non-200 or a network failure
 *
 * Usage:
 *   DRY=1 bun run scripts/probes/premature-stop/turn2-variant-probe.ts
 *   KIRO_PROBE_ACCOUNT='you@example.com' CONFIRM=1 \
 *     bun run scripts/probes/premature-stop/turn2-variant-probe.ts --n 30 --variants V0,V1
 */

import { GenerateAssistantResponseCommand } from '@aws/codewhisperer-streaming-client'
import { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { extractRegionFromArn } from '../../../src/constants.js'
import { transformToSdkRequest } from '../../../src/plugin/request.js'
import { createSdkClient } from '../../../src/plugin/sdk-client.js'
import type { CodeWhispererRequest, Effort, KiroAuthDetails } from '../../../src/plugin/types.js'
import { fetchUsageLimits } from '../../../src/plugin/usage.js'

const MODEL = 'claude-opus-5-high'
const WIRE_MODEL = 'claude-opus-5'
const EFFORT: Effort = 'high'
const DRY = process.env.DRY === '1'
const CONFIRMED = process.env.CONFIRM === '1'
const PINNED_ACCOUNT = process.env.KIRO_PROBE_ACCOUNT
const THINKING_BUDGET = 20000

type ConversationState = CodeWhispererRequest['conversationState']

interface Options {
  readonly trials: number
  readonly concurrency: number
  readonly variants: readonly string[]
  readonly capturePath: string
  readonly outDir: string
  readonly turn: number
  /**
   * Per-variant overrides of `--n`, so an in-batch control can carry a larger N than the
   * candidates it controls **without leaving the batch**. Screening needs exactly that: n=30 is
   * enough to reject a candidate (any single stop rejects it), but a V0 control at n=30 could not
   * distinguish its established 10-25% band from noise, and a turn-5 V1 control at n=30 would
   * miss its own 7.8% trap 9% of the time.
   */
  readonly perVariantTrials: ReadonlyMap<string, number>
}

function parseArgs(argv: readonly string[]): Options {
  let trials = 16
  let concurrency = 4
  let variants: string[] = []
  let capturePath = join(import.meta.dir, 'captured-inbound.json')
  let outDir = join(import.meta.dir, 'results')
  let turn = 2
  const perVariantTrials = new Map<string, number>()
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--n' && value) {
      trials = Number(value)
      i += 1
    } else if (flag === '--n-for' && value) {
      for (const pair of value.split(',')) {
        const [name = '', count = ''] = pair.split('=')
        const parsed = Number(count)
        if (!name || !Number.isInteger(parsed) || parsed < 1) {
          throw new Error(`--n-for expects NAME=N pairs, got ${JSON.stringify(pair)}`)
        }
        perVariantTrials.set(name, parsed)
      }
      i += 1
    } else if (flag === '--concurrency' && value) {
      concurrency = Number(value)
      i += 1
    } else if (flag === '--variants' && value) {
      variants = value.split(',').filter((name) => name.length > 0)
      i += 1
    } else if (flag === '--capture' && value) {
      capturePath = value
      i += 1
    } else if (flag === '--out' && value) {
      outDir = value
      i += 1
    } else if (flag === '--turn' && value) {
      turn = Number(value)
      i += 1
    }
  }
  if (!Number.isInteger(turn) || turn < 2) throw new Error('--turn must be an integer >= 2')
  if (!Number.isInteger(trials) || trials < 1) throw new Error(`--n must be a positive integer`)
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error(`--concurrency invalid`)
  return { trials, concurrency, variants, capturePath, outDir, turn, perVariantTrials }
}

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

function loadAccount(): AccountRow | null {
  const db = new Database(dbPath(), { readonly: true })
  try {
    const columns = `id,email,region,profile_arn,access_token,refresh_token,expires_at,used_count,limit_count`
    if (PINNED_ACCOUNT) {
      const row: unknown = db
        .query(`SELECT ${columns} FROM accounts WHERE email = ? LIMIT 1`)
        .get(PINNED_ACCOUNT)
      return row === null ? null : (row as AccountRow)
    }
    const row: unknown = db
      .query(
        `SELECT ${columns} FROM accounts
          WHERE is_healthy=1 AND used_count < limit_count
          ORDER BY (limit_count - used_count) DESC LIMIT 1`
      )
      .get()
    return row === null ? null : (row as AccountRow)
  } finally {
    db.close()
  }
}

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@')
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readCapturedTurn(path: string, turn: number): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const turns = isRecord(parsed) && Array.isArray(parsed.turns) ? parsed.turns : []
  const body = turns[turn - 1] ?? (turn === 2 && isRecord(parsed) ? parsed.turn2 : undefined)
  if (!isRecord(body)) {
    throw new Error(`${path} has no turn ${turn}; re-run capture-inbound.ts --hops ${turn - 1}`)
  }
  const messages = Array.isArray(body.messages) ? body.messages : []
  const roles = messages.map((m) => (isRecord(m) ? String(m.role) : '?'))
  if (roles.slice(0, 4).join(',') !== 'system,user,assistant,tool' || roles.at(-1) !== 'tool') {
    throw new Error(`turn ${turn} roles ${roles.join(',')} is not a tool-loop continuation`)
  }
  return body
}

function baselineState(turn2: Record<string, unknown>, auth: KiroAuthDetails): ConversationState {
  const prepared = transformToSdkRequest(
    structuredClone(turn2),
    MODEL,
    auth,
    false,
    THINKING_BUDGET,
    undefined,
    { effort: undefined, autoEffortMapping: true, disableReasoningReplay: false }
  )
  if (prepared.effectiveModel !== WIRE_MODEL) {
    throw new Error(`expected wire model ${WIRE_MODEL}, got ${prepared.effectiveModel}`)
  }
  if (prepared.effort !== EFFORT)
    throw new Error(`expected effort ${EFFORT}, got ${prepared.effort}`)
  return prepared.conversationState
}

function currentUser(
  state: ConversationState
): NonNullable<ConversationState['currentMessage']['userInputMessage']> {
  const uim = state.currentMessage.userInputMessage
  if (!uim) throw new Error('current message has no userInputMessage')
  return uim
}

function historyEntry(state: ConversationState, index: number) {
  const entry = state.history?.[index]
  if (!entry) throw new Error(`history[${index}] missing`)
  return entry
}

interface PatchContext {
  readonly systemPrompt: string
  readonly userPrompt: string
  readonly assistantTexts: readonly string[]
}

/**
 * The machine-tag filler measured as V2/V10. It was **never shipped** — the replication batch
 * recorded in `PREMATURE-STOP-INVESTIGATION.md` §11 measured 24/256 = 9.4% at turn 2 against its
 * own 0/120, so production still sends `'Tool results provided.'`.
 *
 * Deliberately a literal rather than an import: this file is evidence of WHICH string was
 * measured, so it must not silently follow a later edit of any production constant.
 */
const MACHINE_TAG_FILLER = '[tool results]'

/**
 * The value the real Kiro IDE sends, and the value eight independent third-party Kiro proxies
 * converge on: the **empty string**.
 *
 * Primary evidence: a captured real-client request body
 * (`caidaoli/kiro2api` `doc/req2.json` @ `f794fdb`) whose tool-result continuation carries
 * `currentMessage.userInputMessage.content === ""`. Provenance of that capture is verifiable
 * from its own bytes — it contains `tooluse_fileTree`, the Kiro-only tool names
 * `listDirectory` / `fsWrite` / `openFolders`, the `# Identity\nYou are Kiro` system prompt and
 * `"I will follow these instructions."`, none of which appear in that proxy's source.
 * Corroborated twice inside the official `aws/amazon-q-developer-cli` Rust client:
 * `UserMessage::new_tool_use_results` yields no prompt text, and the newer `rts` backend's
 * `Message::text()` filters `ContentBlock::Text` only, so a tool-result-only message serializes
 * to `""`.
 *
 * Already measured here as `V1`: turn 2 = 0/120 then 0/128 (both replicate), but turn 5 =
 * 6.7% then 7.8% (the trap replicates too). So `''` alone is NOT clean; the candidates below
 * combine it with a structural change.
 */
const OFFICIAL_EMPTY_FILLER = ''

/**
 * `TsinHzl/kiro2cc-proxy`'s filler — the only NON-empty string a third party adopted
 * specifically to address this symptom family. No quantified before/after was published, hence
 * it is screened here rather than trusted.
 *
 * The same repo asserts the backend rejects empty content. Our own 248 successful turn-2 `V1`
 * continuations falsify that assertion, so it is NOT re-tested.
 */
const TSINHZL_FILLER = '(tool result above)'

/** RFC3339 with the machine's real local UTC offset, which is what Q CLI's context block carries. */
function rfc3339Local(now: Date): string {
  const pad = (value: number, width = 2): string => String(Math.abs(value)).padStart(width, '0')
  const offsetMinutes = -now.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const offset =
    offsetMinutes === 0
      ? 'Z'
      : `${sign}${pad(Math.trunc(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `.${pad(now.getMilliseconds(), 3)}${offset}`
  )
}

/**
 * The context block `aws/amazon-q-developer-cli` sends as real, non-empty `content` on its
 * tool-results-plus-images path. Delimiters are reproduced exactly; the timestamp is this
 * machine's real local time, as it is in the official client.
 */
function qCliTimestampContext(now: Date): string {
  return `--- CONTEXT ENTRY BEGIN ---\nCurrent time: ${rfc3339Local(now)}\n--- CONTEXT ENTRY END ---`
}

/**
 * Kiro IDE's synthetic priming pair, transcribed from `doc/req2.json` history entries `[0..3]`:
 *
 *   [0] user      `# Identity\nYou are Kiro…`   (14143 chars in the capture)
 *   [1] assistant content `""`  + toolUses `[{ listDirectory, toolUseId: 'tooluse_fileTree' }]`
 *   [2] user      `You are operating in a workspace…<fileTree>…`
 *                 + toolResults `[{ tooluse_fileTree, success, 'I will list the files…' }]`
 *   [3] assistant `"I will follow these instructions."`
 *
 * DECLARED DEVIATION, so nobody reads this as byte-faithful: entry `[0]`'s content is truncated
 * to its identity header. The captured 14143-char body is Kiro's OWN system prompt and it
 * instructs the model to call `listDirectory` / `fsWrite` / `openFolders` — tools this request
 * does not expose — so replaying it verbatim would inject a second, competing agent
 * specification (a confound) and add ~14 kB to every request (a cost). Entries `[1]`–`[3]` are
 * transcribed verbatim apart from the `<fileTree>` body, which lists this probe's real fixture
 * workspace instead of the capture author's.
 */
const PRIMING_IDENTITY_HEADER =
  '# Identity\nYou are Kiro, an AI assistant and IDE built to assist developers.'
const PRIMING_TOOL_USE_ID = 'tooluse_fileTree'
const PRIMING_TOOL_RESULT_TEXT = 'I will list the files in current directory.'
const PRIMING_ACK = 'I will follow these instructions.'
const PRIMING_WORKSPACE_PREFIX =
  'You are operating in a workspace with files and folders. Below is the known structure of the ' +
  "workspace. If a directory is marked closed, you can use the 'openFolders' tool to dig in " +
  'deeper.'

/**
 * `<fileTree>` for the priming turn, built from the committed fixture directory that
 * `capture-inbound.ts` copies into its scratch run dir — so the tree describes the workspace the
 * captured conversation actually ran in, rather than a fabricated one.
 */
function primingFileTree(): string {
  const ledger = join(import.meta.dir, '..', 'ab-opencode', 'fixture', 'ledger')
  const files = readdirSync(ledger)
    .filter((name) => name.endsWith('.json'))
    .sort()
  const lines = [
    '<fileTree>',
    "<folder name='ledger' >",
    ...files.map((name) => `  <file name='ledger/${name}' />`),
    '</folder>',
    '</fileTree>'
  ]
  return lines.join('\n')
}

/** The four history entries Kiro IDE prepends, ready to splice in front of a real conversation. */
function primingTurns(
  identity: string,
  modelId: string,
  origin: string
): NonNullable<ConversationState['history']> {
  return [
    { userInputMessage: { content: identity, modelId, origin } },
    {
      assistantResponseMessage: {
        content: '',
        toolUses: [{ toolUseId: PRIMING_TOOL_USE_ID, name: 'listDirectory', input: { path: '.' } }]
      }
    },
    {
      userInputMessage: {
        content: `${PRIMING_WORKSPACE_PREFIX}\n\n${primingFileTree()}\n`,
        modelId,
        origin,
        userInputMessageContext: {
          toolResults: [
            {
              toolUseId: PRIMING_TOOL_USE_ID,
              content: [{ text: PRIMING_TOOL_RESULT_TEXT }],
              status: 'success'
            }
          ]
        }
      }
    },
    { assistantResponseMessage: { content: PRIMING_ACK } }
  ]
}

/** Every history turn that carries tool results, i.e. every site `history-builder.ts` fills. */
function historyToolResultTurns(
  state: ConversationState
): Array<NonNullable<ConversationState['currentMessage']['userInputMessage']>> {
  const turns: Array<NonNullable<ConversationState['currentMessage']['userInputMessage']>> = []
  for (const entry of state.history ?? []) {
    const uim = entry.userInputMessage
    if (uim?.userInputMessageContext?.toolResults?.length) turns.push(uim)
  }
  return turns
}

function setEveryToolResultFiller(state: ConversationState, filler: string): void {
  const current = currentUser(state)
  if (!current.userInputMessageContext?.toolResults?.length) {
    throw new Error('current message carries no toolResults; not a tool-loop continuation')
  }
  current.content = filler
  for (const uim of historyToolResultTurns(state)) uim.content = filler
}

function restoreCollapsedAssistantText(state: ConversationState, context: PatchContext): void {
  let restored = 0
  let index = 0
  for (const entry of state.history ?? []) {
    const arm = entry.assistantResponseMessage
    if (!arm) continue
    const original = context.assistantTexts[index]
    index += 1
    if (arm.content !== '[system: tool calling continues]') continue
    if (original === undefined) throw new Error('no original text for a collapsed turn')
    arm.content = original
    restored += 1
  }
  if (restored === 0) throw new Error('no collapsed turn found; use --turn 4 or later')
}

interface Variant {
  readonly name: string
  readonly hypothesis: string
  readonly primingCall: boolean
  readonly patch: (state: ConversationState, context: PatchContext) => void
}

const VARIANTS: readonly Variant[] = [
  {
    name: 'V0',
    hypothesis: 'baseline: byte-identical to what the plugin sends today',
    primingCall: false,
    patch: () => {}
  },
  {
    name: 'V1',
    hypothesis: 'tool-result filler removed entirely (no user utterance at all)',
    primingCall: false,
    patch: (state) => {
      currentUser(state).content = ''
    }
  },
  {
    name: 'V2',
    hypothesis: 'tool-result filler is a machine tag rather than a sentence',
    primingCall: false,
    patch: (state) => {
      currentUser(state).content = '[tool results]'
    }
  },
  {
    name: 'V3',
    hypothesis: 'tool-result filler explicitly signals continuation',
    primingCall: false,
    patch: (state) => {
      currentUser(state).content =
        'Tool results provided. Continue with the next tool call now; do not summarize.'
    }
  },
  {
    name: 'V4',
    hypothesis: 'the <thinking_mode> system prefix the fork never sends (think is always false)',
    primingCall: false,
    patch: (state) => {
      const uim = historyEntry(state, 0).userInputMessage
      if (!uim) throw new Error('history[0] is not a user message')
      uim.content = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${THINKING_BUDGET}</max_thinking_length>\n${uim.content}`
    }
  },
  {
    name: 'V5',
    hypothesis: "collapseAgenticLoops's placeholder replaces the assistant's visible text",
    primingCall: false,
    patch: (state) => {
      const arm = historyEntry(state, 1).assistantResponseMessage
      if (!arm) throw new Error('history[1] is not an assistant message')
      arm.content = '[system: tool calling continues]'
    }
  },
  {
    name: 'V6',
    hypothesis: 'the agent-task fields the SDK exposes but the plugin never sets',
    primingCall: false,
    patch: (state) => {
      const extended: Record<string, unknown> = state
      extended.agentTaskType = 'vibe'
      extended.agentContinuationId = randomUUID()
    }
  },
  {
    name: 'V7',
    hypothesis: 'a conversationId shared with a real preceding turn instead of a fresh one',
    primingCall: true,
    patch: () => {}
  },
  {
    name: 'V9',
    hypothesis:
      "undo collapseAgenticLoops: restore every assistant turn's real text that the plugin replaced with a placeholder",
    primingCall: false,
    patch: (state, context) => {
      restoreCollapsedAssistantText(state, context)
    }
  },
  {
    name: 'V8',
    hypothesis:
      'system prompt kept as its own history turn (turn-1 shape) instead of glued to the user prompt',
    primingCall: false,
    patch: (state, context) => {
      const first = historyEntry(state, 0).userInputMessage
      if (!first) throw new Error('history[0] is not a user message')
      const glued = `${context.systemPrompt}\n\n${context.userPrompt}`
      if (first.content !== glued) {
        throw new Error('history[0] is not the glued system+user content injectSystemPrompt makes')
      }
      const rest = (state.history ?? []).slice(1)
      state.history = [
        {
          userInputMessage: {
            content: context.systemPrompt,
            modelId: first.modelId,
            origin: first.origin
          }
        },
        { assistantResponseMessage: { content: '[system: conversation continues]' } },
        {
          userInputMessage: {
            content: context.userPrompt,
            modelId: first.modelId,
            origin: first.origin
          }
        },
        ...rest
      ]
    }
  },
  {
    name: 'V10',
    hypothesis:
      'as-implemented fix: machine-tag filler at BOTH tool-result sites (history turns and the ' +
      'current message), i.e. what the plugin sends after the fix',
    primingCall: false,
    patch: (state) => {
      setEveryToolResultFiller(state, MACHINE_TAG_FILLER)
    }
  },
  {
    name: 'C1',
    hypothesis:
      "V1's empty content PLUS Kiro IDE's synthetic priming pair prepended to history " +
      '(identity header truncated — see PRIMING_IDENTITY_HEADER)',
    primingCall: false,
    patch: (state) => {
      const first = historyEntry(state, 0).userInputMessage
      if (!first) throw new Error('history[0] is not a user message')
      currentUser(state).content = OFFICIAL_EMPTY_FILLER
      state.history = [
        ...primingTurns(PRIMING_IDENTITY_HEADER, first.modelId, first.origin),
        ...(state.history ?? [])
      ]
    }
  },
  {
    name: 'C1b',
    hypothesis:
      "V1's empty content PLUS the priming pair in the real client's FULL turn layout: our own " +
      'system prompt becomes history[0] and the user prompt follows the priming pair',
    primingCall: false,
    patch: (state, context) => {
      const first = historyEntry(state, 0).userInputMessage
      if (!first) throw new Error('history[0] is not a user message')
      const glued = `${context.systemPrompt}\n\n${context.userPrompt}`
      if (first.content !== glued) {
        throw new Error('history[0] is not the glued system+user content injectSystemPrompt makes')
      }
      first.content = context.userPrompt
      currentUser(state).content = OFFICIAL_EMPTY_FILLER
      state.history = [
        ...primingTurns(context.systemPrompt, first.modelId, first.origin),
        ...(state.history ?? [])
      ]
    }
  },
  {
    name: 'C2',
    hypothesis:
      "V1's empty content PLUS undo collapseAgenticLoops (never tested as a combination; " +
      'degenerates to V1 wherever no turn was collapsed, i.e. before turn 4)',
    primingCall: false,
    patch: (state, context) => {
      restoreCollapsedAssistantText(state, context)
      currentUser(state).content = OFFICIAL_EMPTY_FILLER
    }
  },
  {
    name: 'C3',
    hypothesis:
      'the Q CLI timestamp context block as content: non-empty, unambiguously not a user ' +
      'utterance, and a string the service demonstrably receives from a first-party client',
    primingCall: false,
    patch: (state) => {
      setEveryToolResultFiller(state, qCliTimestampContext(new Date()))
    }
  },
  {
    name: 'C4',
    hypothesis: `third-party filler adopted for this symptom family: ${JSON.stringify(TSINHZL_FILLER)}`,
    primingCall: false,
    patch: (state) => {
      setEveryToolResultFiller(state, TSINHZL_FILLER)
    }
  },
  {
    name: 'C5',
    hypothesis:
      'empty content at EVERY tool-result site, i.e. what a client that natively sends the ' +
      'official value produces once earlier turns age into history (V1 empties only the current ' +
      'message, so the two differ from turn 4 on)',
    primingCall: false,
    patch: (state) => {
      setEveryToolResultFiller(state, OFFICIAL_EMPTY_FILLER)
    }
  }
]

function patchContext(turn2: Record<string, unknown>): PatchContext {
  const messages = Array.isArray(turn2.messages) ? turn2.messages : []
  const pick = (role: string): string => {
    const found = messages.find((m) => isRecord(m) && m.role === role)
    return isRecord(found) && typeof found.content === 'string' ? found.content : ''
  }
  const systemPrompt = pick('system')
  const userPrompt = pick('user')
  if (!systemPrompt || !userPrompt) throw new Error('capture lacks a system or user message')
  const assistantTexts = messages
    .filter((m) => isRecord(m) && m.role === 'assistant')
    .map((m) => (isRecord(m) && typeof m.content === 'string' ? m.content : ''))
  return { systemPrompt, userPrompt, assistantTexts }
}

interface Drained {
  readonly toolUses: number
  readonly textChars: number
  readonly reasoningFrames: number
  readonly reasoningChars: number
  readonly text: string
  readonly requestId?: string
}

interface StreamEvent {
  readonly reasoningContentEvent?: { text?: string; signature?: string }
  readonly assistantResponseEvent?: { content?: string }
  readonly toolUseEvent?: { toolUseId?: string; name?: string; input?: string; stop?: boolean }
}

interface SdkResponse {
  readonly $metadata?: { httpStatusCode?: number; requestId?: string }
  readonly generateAssistantResponseResponse?: AsyncIterable<StreamEvent>
}

async function drain(response: SdkResponse): Promise<Drained> {
  let toolUses = 0
  let textChars = 0
  let reasoningFrames = 0
  let reasoningChars = 0
  let text = ''
  const stream = response.generateAssistantResponseResponse
  if (stream) {
    for await (const event of stream) {
      if (event.reasoningContentEvent) {
        reasoningFrames += 1
        reasoningChars += (event.reasoningContentEvent.text ?? '').length
        continue
      }
      if (event.assistantResponseEvent?.content) {
        text += event.assistantResponseEvent.content
        textChars += event.assistantResponseEvent.content.length
        continue
      }
      if (event.toolUseEvent?.stop) toolUses += 1
    }
  }
  return {
    toolUses,
    textChars,
    reasoningFrames,
    reasoningChars,
    text,
    ...(response.$metadata?.requestId ? { requestId: response.$metadata.requestId } : {})
  }
}

type Outcome = 'continued' | 'stopped' | 'empty200' | 'error'

interface Trial {
  readonly variant: string
  readonly trial: number
  readonly outcome: Outcome
  readonly http: number | string
  readonly toolUses: number
  readonly textChars: number
  readonly reasoningFrames: number
  readonly reasoningChars: number
  readonly finalText: string
  readonly latencyMs: number
  readonly calls: number
  readonly errorName?: string
  readonly errorMessage?: string
  readonly requestId?: string
}

interface SdkClient {
  send(command: GenerateAssistantResponseCommand): Promise<SdkResponse>
}

async function runTrial(
  variant: Variant,
  trial: number,
  base: ConversationState,
  context: PatchContext,
  auth: KiroAuthDetails,
  client: SdkClient
): Promise<Trial> {
  const state = structuredClone(base)
  state.conversationId = randomUUID()
  variant.patch(state, context)
  const startedAt = Date.now()
  let calls = 0

  const payload = (body: ConversationState): Record<string, unknown> => ({
    conversationState: body,
    ...(auth.profileArn ? { profileArn: auth.profileArn } : {})
  })

  try {
    if (variant.primingCall) {
      const priming = structuredClone(base)
      priming.conversationId = state.conversationId
      const opening = priming.history?.[0]
      const openingUser = opening?.userInputMessage
      if (!openingUser) throw new Error('history[0] is not a user message')
      priming.history = []
      priming.currentMessage = { userInputMessage: openingUser }
      calls += 1
      const primed = await client.send(
        new GenerateAssistantResponseCommand(payload(priming) as never)
      )
      await drain(primed)
    }

    calls += 1
    const response = await client.send(
      new GenerateAssistantResponseCommand(payload(state) as never)
    )
    const got = await drain(response)
    const http = response.$metadata?.httpStatusCode ?? 'unknown'
    const outcome: Outcome =
      got.toolUses > 0
        ? 'continued'
        : got.textChars === 0 && got.reasoningChars === 0
          ? 'empty200'
          : 'stopped'
    return {
      variant: variant.name,
      trial,
      outcome,
      http,
      toolUses: got.toolUses,
      textChars: got.textChars,
      reasoningFrames: got.reasoningFrames,
      reasoningChars: got.reasoningChars,
      finalText: got.text.slice(0, 400),
      latencyMs: Date.now() - startedAt,
      calls,
      ...(got.requestId ? { requestId: got.requestId } : {})
    }
  } catch (error: unknown) {
    const err = isRecord(error) ? error : {}
    const metadata = isRecord(err.$metadata) ? err.$metadata : {}
    return {
      variant: variant.name,
      trial,
      outcome: 'error',
      http: typeof metadata.httpStatusCode === 'number' ? metadata.httpStatusCode : 'network/none',
      toolUses: 0,
      textChars: 0,
      reasoningFrames: 0,
      reasoningChars: 0,
      finalText: '',
      latencyMs: Date.now() - startedAt,
      calls,
      errorName: typeof err.name === 'string' ? err.name : 'Error',
      errorMessage: String(err.message ?? error).slice(0, 400),
      ...(typeof metadata.requestId === 'string' ? { requestId: metadata.requestId } : {})
    }
  }
}

async function runPool<T>(
  count: number,
  concurrency: number,
  worker: (index: number) => Promise<T>
): Promise<T[]> {
  const results: T[] = new Array<T>(count)
  let next = 0
  const lanes = Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= count) return
      results[index] = await worker(index)
    }
  })
  await Promise.all(lanes)
  return results
}

function rate(trials: readonly Trial[], outcome: Outcome): string {
  const valid = trials.filter((t) => t.outcome !== 'error')
  const hits = valid.filter((t) => t.outcome === outcome).length
  const pct = valid.length === 0 ? 0 : (hits / valid.length) * 100
  return `${hits}/${valid.length} (${pct.toFixed(1)}%)`
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const selected =
    options.variants.length === 0
      ? VARIANTS
      : VARIANTS.filter((variant) => options.variants.includes(variant.name))
  if (selected.length === 0) throw new Error(`no variant matched ${options.variants.join(',')}`)

  const account = loadAccount()
  if (!account) {
    console.log(
      PINNED_ACCOUNT
        ? `CANNOT AUTHENTICATE: no account matching KIRO_PROBE_ACCOUNT=${maskEmail(PINNED_ACCOUNT)}`
        : 'CANNOT AUTHENTICATE: no healthy account with remaining quota'
    )
    process.exit(1)
  }

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
  const headroom =
    account.limit_count !== null && account.used_count !== null
      ? account.limit_count - account.used_count
      : null
  const trialsFor = (variant: Variant): number =>
    options.perVariantTrials.get(variant.name) ?? options.trials
  const plannedCalls = selected.reduce(
    (total, variant) => total + trialsFor(variant) * (variant.primingCall ? 2 : 1),
    0
  )

  const turn2 = readCapturedTurn(options.capturePath, options.turn)
  const context = patchContext(turn2)
  const base = baselineState(turn2, auth)
  const historyLength = base.history?.length ?? 0
  const toolCount = currentUser(base).userInputMessageContext?.tools?.length ?? 0
  const toolResults = currentUser(base).userInputMessageContext?.toolResults?.length ?? 0

  console.log(
    `account=${maskEmail(account.email)} region=${region} model=${MODEL} wire=${WIRE_MODEL} ` +
      `effort=${EFFORT} headroom=${headroom ?? 'unknown'} plannedCalls=${plannedCalls} dry=${DRY}`
  )
  console.log(
    `V0 shape: chatTriggerType=${base.chatTriggerType} historyLength=${historyLength} ` +
      `toolCount=${toolCount} toolResults=${toolResults} ` +
      `content=${JSON.stringify(currentUser(base).content)} ` +
      `modelId=${currentUser(base).modelId} origin=${currentUser(base).origin}`
  )
  console.log(
    `V0 history roles: ${(base.history ?? [])
      .map((entry) => (entry.userInputMessage ? 'user' : 'assistant'))
      .join(',')}`
  )

  if (DRY) {
    const baseBytes = Buffer.byteLength(JSON.stringify(base), 'utf8')
    console.log(`\nV0 serialized conversationState: ${baseBytes} bytes`)
    for (const variant of selected) {
      const state = structuredClone(base)
      variant.patch(state, context)
      const extended: Record<string, unknown> = state
      const bytes = Buffer.byteLength(JSON.stringify(state), 'utf8')
      const delta = bytes - baseBytes
      console.log(
        `\n[${variant.name}] ${variant.hypothesis}\n` +
          `  historyLength=${state.history?.length ?? 0} roles=${(state.history ?? [])
            .map((entry) => (entry.userInputMessage ? 'user' : 'assistant'))
            .join(',')}\n` +
          `  priming=${variant.primingCall} content=${JSON.stringify(currentUser(state).content)}\n` +
          `  bytes=${bytes} deltaVsV0=${delta >= 0 ? '+' : ''}${delta} ` +
          `(~${Math.round(delta / 4)} tokens at 4 bytes/token)\n` +
          `  history[0] head=${JSON.stringify(
            (historyEntry(state, 0).userInputMessage?.content ?? '').slice(0, 90)
          )}\n` +
          `  history[1] content=${JSON.stringify(
            historyEntry(state, 1).assistantResponseMessage?.content ?? ''
          )}\n` +
          `  historyToolResultTurns=${historyToolResultTurns(state).length} fillers=${JSON.stringify(
            historyToolResultTurns(state).map((uim) => uim.content)
          )}\n` +
          `  agentTaskType=${String(extended.agentTaskType)} ` +
          `agentContinuationId=${extended.agentContinuationId ? 'set' : 'unset'}`
      )
    }
    return
  }

  if (!CONFIRMED) {
    console.log(
      `REFUSING: this run spends ${plannedCalls} real requests. Re-run with CONFIRM=1 ` +
        '(or DRY=1 to inspect every variant payload for free).'
    )
    process.exit(2)
  }
  if (headroom !== null && headroom < plannedCalls) {
    console.log(`REFUSING: account headroom ${headroom} < plannedCalls ${plannedCalls}.`)
    process.exit(2)
  }
  if (account.expires_at - Date.now() < 120_000) {
    console.log(
      'CANNOT AUTHENTICATE: access token expired or near expiry. Start OpenCode once to refresh ' +
        'it, then re-run (this probe never writes to kiro.db).'
    )
    process.exit(1)
  }

  let usageBefore: number | null = null
  try {
    usageBefore = (await fetchUsageLimits(auth)).usedCount ?? null
  } catch {
    usageBefore = null
  }
  console.log(`USAGE BEFORE: used=${usageBefore ?? 'unavailable'}`)

  const client: SdkClient = createSdkClient(auth, region, EFFORT)
  const all: Trial[] = []
  for (const variant of selected) {
    const variantTrials = trialsFor(variant)
    console.log(`\n=== ${variant.name} (n=${variantTrials}) ${variant.hypothesis} ===`)
    const trials = await runPool(variantTrials, options.concurrency, (index) =>
      runTrial(variant, index + 1, base, context, auth, client).then((trial) => {
        console.log(
          `  [${variant.name}] trial ${trial.trial}: ${trial.outcome} http=${trial.http} ` +
            `tools=${trial.toolUses} textChars=${trial.textChars} ` +
            `reasonFrames=${trial.reasoningFrames} ${trial.latencyMs}ms` +
            (trial.errorMessage ? ` ${trial.errorName}: ${trial.errorMessage}` : '')
        )
        return trial
      })
    )
    all.push(...trials)
    console.log(
      `  ${variant.name}: stopped=${rate(trials, 'stopped')} empty200=${rate(trials, 'empty200')} ` +
        `continued=${rate(trials, 'continued')} errors=${trials.filter((t) => t.outcome === 'error').length}`
    )
  }

  console.log('\n================ RATE TABLE ================')
  console.log('variant\tn\tstopped\tempty200\tcontinued\terrors')
  for (const variant of selected) {
    const trials = all.filter((trial) => trial.variant === variant.name)
    const valid = trials.filter((trial) => trial.outcome !== 'error')
    console.log(
      [
        variant.name,
        valid.length,
        rate(trials, 'stopped'),
        rate(trials, 'empty200'),
        rate(trials, 'continued'),
        trials.length - valid.length
      ].join('\t')
    )
  }

  let usageAfter: number | null = null
  try {
    usageAfter = (await fetchUsageLimits(auth)).usedCount ?? null
  } catch {
    usageAfter = null
  }
  const realCalls = all.reduce((total, trial) => total + trial.calls, 0)
  console.log(`\nREAL API CALLS THIS RUN: ${realCalls}`)
  console.log(`USAGE AFTER: used=${usageAfter ?? 'unavailable'}`)

  const finishedAt = new Date().toISOString()
  const result = {
    schemaVersion: 1,
    probe: 'turn2-variant-probe',
    finishedAt,
    model: MODEL,
    wireModel: WIRE_MODEL,
    effort: EFFORT,
    region,
    capturePath: options.capturePath,
    turn: options.turn,
    trialsPerVariant: options.trials,
    trialsPerVariantOverrides: Object.fromEntries(options.perVariantTrials),
    concurrency: options.concurrency,
    account: { masked: maskEmail(account.email), headroomBefore: headroom },
    usage: { before: usageBefore, after: usageAfter },
    realApiCalls: realCalls,
    v0Shape: {
      chatTriggerType: base.chatTriggerType,
      historyLength,
      toolCount,
      toolResults,
      currentContent: currentUser(base).content,
      modelId: currentUser(base).modelId,
      origin: currentUser(base).origin
    },
    variants: selected.map((variant) => ({
      name: variant.name,
      hypothesis: variant.hypothesis,
      primingCall: variant.primingCall,
      trials: trialsFor(variant)
    })),
    trials: all
  }
  const serialized = JSON.stringify(result, null, 2)
  if (serialized.includes(account.email)) throw new Error('refusing to write an unmasked email')
  if (serialized.includes(auth.access) || serialized.includes(auth.refresh)) {
    throw new Error('refusing to write a token')
  }
  if (auth.profileArn && serialized.includes(auth.profileArn)) {
    throw new Error('refusing to write a profileArn')
  }
  const outPath = join(options.outDir, `turn2-variant-${finishedAt.replace(/[:.]/g, '-')}.json`)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${serialized}\n`, 'utf8')
  console.log(`\nRAW RESULTS: ${outPath}`)
}

main().catch((error: unknown) => {
  console.error('PROBE CRASHED', error)
  process.exit(1)
})
