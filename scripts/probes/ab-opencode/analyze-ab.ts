/**
 * Turns the raw OpenCode run artifacts written by `run-ab.ts` into the tables quoted in
 * AB-OPENCODE-COMPARISON.md, so every number in the report is reproducible from the
 * committed evidence rather than hand-copied.
 *
 * Usage:
 *   bun run scripts/probes/ab-opencode/analyze-ab.ts [--in <runsDir>] [--json <out.json>]
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

interface Expected {
  readonly variant?: string
  readonly hops: number
  readonly expectedFinalTotal: number
  readonly expectedFinalChecksum?: number
  readonly traversalOrder: readonly string[]
}

function loadExpected(variant: string): Expected {
  const dir = variant === 'baseline' ? 'fixture' : `fixture-${variant}`
  return JSON.parse(readFileSync(join(HERE, dir, 'expected.json'), 'utf8')) as Expected
}

let EXPECTED: Expected = loadExpected('baseline')

interface Options {
  readonly inDir: string
  readonly variant?: string
  readonly jsonOut?: string
}

function parseArgs(argv: readonly string[]): Options {
  let inDir = join(HERE, 'runs')
  let jsonOut: string | undefined
  let variant: string | undefined

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--in' && value) {
      inDir = value
      i += 1
    } else if (flag === '--json' && value) {
      jsonOut = value
      i += 1
    } else if (flag === '--variant' && value) {
      variant = value
      i += 1
    }
  }
  return {
    inDir,
    ...(variant === undefined ? {} : { variant }),
    ...(jsonOut === undefined ? {} : { jsonOut })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' ? value : undefined
}

function readArray(source: Record<string, unknown>, key: string): unknown[] {
  const value = source[key]
  return Array.isArray(value) ? value : []
}

interface TurnStats {
  readonly turn: number
  readonly reasoningParts: number
  readonly reasoningChars: number
  readonly textParts: number
  readonly textChars: number
  readonly toolCalls: number
  readonly ledgerReads: readonly string[]
  readonly finishReason?: string
}

interface RunAnalysis {
  readonly runId: string
  readonly arm: string
  readonly index: number
  readonly model: string
  readonly startedAt: string
  readonly durationMs: number
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly stderrBytes: number
  readonly streamErrorEvents: number
  readonly assistantTurns: number
  readonly totalToolCalls: number
  readonly ledgerReadCount: number
  readonly uniqueLedgerReads: number
  readonly chainCompleted: boolean
  readonly finalTotalClaimed?: number
  readonly finalTotalCorrect: boolean
  readonly finalChecksumClaimed?: number
  readonly finalChecksumCorrect: boolean
  readonly turnsWithReasoning: number
  readonly totalReasoningChars: number
  readonly firstZeroReasoningTurn?: number
  readonly lastTurnHadText: boolean
  readonly lastTurnHadToolCall: boolean
  readonly lastTurnEmpty: boolean
  readonly announcedNextThenStopped: boolean
  readonly silentStop: boolean
  readonly outcome: 'completed_correct' | 'announced_then_stopped' | 'silent_stop' | 'other_failure'
  readonly sdkRequests: number
  readonly sdkRequestsWithHistoryReasoning: number
  readonly replayedEnvelopes: number
  readonly turns: readonly TurnStats[]
}

const LEDGER_READ = /ledger\/(step\d{2})\.json/g
const FINAL_TOTAL = /FINAL_TOTAL\s*=\s*(-?\d+)/g
const FINAL_CHECKSUM = /FINAL_CHECKSUM\s*=\s*(-?\d+)/g

/**
 * "The agent said what it would do next and then stopped" is only meaningful if the phrase
 * actually points forward. The structural test (a trailing text-only turn on an incomplete
 * chain) is the primary signal; this lexical test is reported alongside it so a reader can
 * see whether the wording matches the user's reported symptom rather than trusting a label.
 */
const FORWARD_LOOKING =
  /\b(next|now|then|proceed|continue|let me|i'?ll|i will|going to|step\s*\d)\b|接下来|下一步|继续/i

function collectLedgerReads(value: unknown, sink: string[]): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(LEDGER_READ)) {
      const name = match[1]
      if (name) sink.push(name)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLedgerReads(item, sink)
    return
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) collectLedgerReads(item, sink)
  }
}

function analyseTurns(exportDoc: unknown): { turns: TurnStats[]; lastTexts: string[] } {
  const turns: TurnStats[] = []
  const lastTexts: string[] = []
  if (!isRecord(exportDoc)) return { turns, lastTexts }

  let turnIndex = 0
  for (const message of readArray(exportDoc, 'messages')) {
    if (!isRecord(message)) continue
    const info = isRecord(message.info) ? message.info : {}
    if (readString(info, 'role') !== 'assistant') continue

    turnIndex += 1
    let reasoningParts = 0
    let reasoningChars = 0
    let textParts = 0
    let textChars = 0
    let toolCalls = 0
    let finishReason: string | undefined
    const ledgerReads: string[] = []
    const texts: string[] = []

    for (const part of readArray(message, 'parts')) {
      if (!isRecord(part)) continue
      const type = readString(part, 'type')
      if (type === 'reasoning') {
        reasoningParts += 1
        reasoningChars += (readString(part, 'text') ?? '').length
      } else if (type === 'text') {
        textParts += 1
        const text = readString(part, 'text') ?? ''
        textChars += text.length
        texts.push(text)
      } else if (type === 'tool') {
        toolCalls += 1
        const state = isRecord(part.state) ? part.state : {}
        collectLedgerReads(state.input, ledgerReads)
      } else if (type === 'step-finish') {
        finishReason = readString(part, 'reason') ?? finishReason
      }
    }

    turns.push({
      turn: turnIndex,
      reasoningParts,
      reasoningChars,
      textParts,
      textChars,
      toolCalls,
      ledgerReads,
      ...(finishReason === undefined ? {} : { finishReason })
    })
    lastTexts.length = 0
    lastTexts.push(...texts)
  }

  return { turns, lastTexts }
}

function countStreamErrors(streamPath: string): number {
  if (!existsSync(streamPath)) return 0
  let errors = 0
  for (const line of readFileSync(streamPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (isRecord(parsed) && readString(parsed, 'type') === 'error') errors += 1
    } catch {
      errors += 1
    }
  }
  return errors
}

interface ApiStats {
  readonly requests: number
  readonly requestsWithHistoryReasoning: number
  readonly replayedEnvelopes: number
}

function analyseApiLog(apiPath: string): ApiStats {
  if (!existsSync(apiPath))
    return { requests: 0, requestsWithHistoryReasoning: 0, replayedEnvelopes: 0 }

  let requests = 0
  let requestsWithHistoryReasoning = 0
  let replayedEnvelopes = 0

  for (const line of readFileSync(apiPath, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isRecord(parsed) || readString(parsed, 'type') !== 'request') continue
    requests += 1

    const data = isRecord(parsed.data) ? parsed.data : {}
    const body = isRecord(data.body) ? data.body : {}
    const state = isRecord(body.conversationState) ? body.conversationState : {}
    const summaries = readArray(state, 'historyReasoning')
    if (summaries.length > 0) {
      requestsWithHistoryReasoning += 1
      replayedEnvelopes += summaries.length
    }
  }

  return { requests, requestsWithHistoryReasoning, replayedEnvelopes }
}

function classify(
  chainCompleted: boolean,
  finalTotalCorrect: boolean,
  failedTechnically: boolean,
  announcedNextThenStopped: boolean,
  silentStop: boolean
): RunAnalysis['outcome'] {
  if (failedTechnically) return 'other_failure'
  if (chainCompleted && finalTotalCorrect) return 'completed_correct'
  if (silentStop) return 'silent_stop'
  if (announcedNextThenStopped) return 'announced_then_stopped'
  return 'other_failure'
}

function analyseRun(runDir: string, runId: string): RunAnalysis | undefined {
  const metaPath = join(runDir, 'meta.json')
  if (!existsSync(metaPath)) return undefined
  const metaRaw: unknown = JSON.parse(readFileSync(metaPath, 'utf8'))
  const meta = isRecord(metaRaw) ? metaRaw : {}

  const exportPath = join(runDir, 'export.json')
  const exportDoc: unknown = existsSync(exportPath)
    ? JSON.parse(readFileSync(exportPath, 'utf8'))
    : undefined
  const { turns, lastTexts } = analyseTurns(exportDoc)

  const allLedgerReads = turns.flatMap((t) => t.ledgerReads)
  const uniqueLedgerReads = new Set(allLedgerReads).size
  const chainCompleted = uniqueLedgerReads >= EXPECTED.hops

  const joinedLast = lastTexts.join('\n')
  const claims = [...joinedLast.matchAll(FINAL_TOTAL)].map((m) => Number(m[1]))
  const finalTotalClaimed = claims.length > 0 ? claims[claims.length - 1] : undefined
  const finalTotalCorrect = finalTotalClaimed === EXPECTED.expectedFinalTotal

  const checksumClaims = [...joinedLast.matchAll(FINAL_CHECKSUM)].map((m) => Number(m[1]))
  const finalChecksumClaimed =
    checksumClaims.length > 0 ? checksumClaims[checksumClaims.length - 1] : undefined
  const finalChecksumCorrect =
    EXPECTED.expectedFinalChecksum === undefined
      ? true
      : finalChecksumClaimed === EXPECTED.expectedFinalChecksum

  const lastTurn = turns[turns.length - 1]
  const lastTurnHadText = (lastTurn?.textChars ?? 0) > 0
  const lastTurnHadToolCall = (lastTurn?.toolCalls ?? 0) > 0
  const lastTurnEmpty =
    lastTurn !== undefined &&
    lastTurn.textChars === 0 &&
    lastTurn.toolCalls === 0 &&
    lastTurn.reasoningChars === 0

  const rawStderr = join(runDir, 'stderr.log')
  const stderrPath = existsSync(rawStderr) ? rawStderr : join(runDir, 'stderr.txt')
  const stderrBytes = existsSync(stderrPath) ? statSync(stderrPath).size : -1
  const streamErrorEvents = countStreamErrors(join(runDir, 'stream.jsonl'))
  const exitCode = readNumber(meta, 'exitCode') ?? null
  const timedOut = meta.timedOut === true
  const failedTechnically = exitCode !== 0 || timedOut || streamErrorEvents > 0

  const announcedNextThenStopped =
    !chainCompleted && lastTurnHadText && !lastTurnHadToolCall && FORWARD_LOOKING.test(joinedLast)
  const silentStop =
    !chainCompleted && (lastTurnEmpty || (!lastTurnHadText && !lastTurnHadToolCall))

  const firstZero = turns.find((t) => t.reasoningChars === 0)

  const rawApiPath = join(runDir, 'api.ndjson')
  const api = analyseApiLog(
    existsSync(rawApiPath) ? rawApiPath : join(runDir, 'api-filtered.ndjson')
  )

  return {
    runId,
    arm: readString(meta, 'arm') ?? 'unknown',
    index: readNumber(meta, 'index') ?? 0,
    model: readString(meta, 'model') ?? 'unknown',
    startedAt: readString(meta, 'startedAt') ?? '',
    durationMs: readNumber(meta, 'durationMs') ?? 0,
    exitCode,
    timedOut,
    stderrBytes,
    streamErrorEvents,
    assistantTurns: turns.length,
    totalToolCalls: turns.reduce((sum, t) => sum + t.toolCalls, 0),
    ledgerReadCount: allLedgerReads.length,
    uniqueLedgerReads,
    chainCompleted,
    ...(finalTotalClaimed === undefined ? {} : { finalTotalClaimed }),
    finalTotalCorrect,
    ...(finalChecksumClaimed === undefined ? {} : { finalChecksumClaimed }),
    finalChecksumCorrect,
    turnsWithReasoning: turns.filter((t) => t.reasoningChars > 0).length,
    totalReasoningChars: turns.reduce((sum, t) => sum + t.reasoningChars, 0),
    ...(firstZero === undefined ? {} : { firstZeroReasoningTurn: firstZero.turn }),
    lastTurnHadText,
    lastTurnHadToolCall,
    lastTurnEmpty,
    announcedNextThenStopped,
    silentStop,
    outcome: classify(
      chainCompleted,
      finalTotalCorrect && finalChecksumCorrect,
      failedTechnically,
      announcedNextThenStopped,
      silentStop
    ),
    sdkRequests: api.requests,
    sdkRequestsWithHistoryReasoning: api.requestsWithHistoryReasoning,
    replayedEnvelopes: api.replayedEnvelopes,
    turns
  }
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length)
}

function renderRunTable(runs: readonly RunAnalysis[]): string {
  const header =
    '| run | arm | tool calls | unique ledger reads | chain done | FINAL_TOTAL | correct | turns | turns w/ reasoning | reasoning chars | first 0-reasoning turn | outcome | duration |'
  const sep = `|${'---|'.repeat(13)}`
  const rows = runs.map((r) =>
    [
      r.runId,
      r.arm,
      String(r.totalToolCalls),
      `${r.uniqueLedgerReads}/${EXPECTED.hops}`,
      r.chainCompleted ? 'yes' : 'NO',
      r.finalTotalClaimed === undefined ? '-' : String(r.finalTotalClaimed),
      r.finalTotalCorrect ? 'yes' : 'NO',
      String(r.assistantTurns),
      `${r.turnsWithReasoning}/${r.assistantTurns}`,
      String(r.totalReasoningChars),
      r.firstZeroReasoningTurn === undefined ? '-' : String(r.firstZeroReasoningTurn),
      r.outcome,
      `${(r.durationMs / 1000).toFixed(1)}s`
    ].join(' | ')
  )
  return [header, sep, ...rows.map((row) => `| ${row} |`)].join('\n')
}

function renderReasoningTable(runs: readonly RunAnalysis[]): string {
  const maxTurns = runs.reduce((max, r) => Math.max(max, r.turns.length), 0)
  const header = ['| run    ', ...Array.from({ length: maxTurns }, (_, i) => ` t${i + 1} `)].join(
    '|'
  )
  const sep = `|${'---|'.repeat(maxTurns + 1)}`
  const rows = runs.map((r) => {
    const cells = Array.from({ length: maxTurns }, (_, i) => {
      const turn = r.turns[i]
      return turn === undefined ? ' - ' : ` ${turn.reasoningChars} `
    })
    return [`| ${pad(r.runId, 6)} `, ...cells].join('|')
  })
  return [header, sep, ...rows.map((row) => `${row}|`)].join('\n')
}

function renderWireTable(runs: readonly RunAnalysis[]): string {
  const header =
    '| run | arm | outbound SDK requests | requests carrying historyReasoning | replayed signed envelopes |'
  const sep = `|${'---|'.repeat(5)}`
  const rows = runs.map(
    (r) =>
      `| ${r.runId} | ${r.arm} | ${r.sdkRequests} | ${r.sdkRequestsWithHistoryReasoning} | ${r.replayedEnvelopes} |`
  )
  return [header, sep, ...rows].join('\n')
}

function renderOutcomeCounts(runs: readonly RunAnalysis[]): string {
  const arms = [...new Set(runs.map((r) => r.arm))].sort()
  const outcomes: readonly RunAnalysis['outcome'][] = [
    'completed_correct',
    'announced_then_stopped',
    'silent_stop',
    'other_failure'
  ]
  const header = `| outcome | ${arms.join(' | ')} |`
  const sep = `|${'---|'.repeat(arms.length + 1)}`
  const rows = outcomes.map((outcome) => {
    const cells = arms.map(
      (arm) => runs.filter((r) => r.arm === arm && r.outcome === outcome).length
    )
    return `| ${outcome} | ${cells.join(' | ')} |`
  })
  return [header, sep, ...rows].join('\n')
}

function main(): void {
  const options = parseArgs(process.argv.slice(2))
  if (!existsSync(options.inDir)) {
    console.error(`no such runs directory: ${options.inDir}`)
    process.exitCode = 1
    return
  }

  const firstMeta = readdirSync(options.inDir)
    .sort()
    .map((entry) => join(options.inDir, entry, 'meta.json'))
    .find((path) => existsSync(path))
  const metaVariant =
    firstMeta === undefined
      ? undefined
      : (() => {
          const parsed: unknown = JSON.parse(readFileSync(firstMeta, 'utf8'))
          return isRecord(parsed) ? readString(parsed, 'variant') : undefined
        })()
  EXPECTED = loadExpected(options.variant ?? metaVariant ?? 'baseline')

  const runs: RunAnalysis[] = []
  for (const entry of readdirSync(options.inDir).sort()) {
    const dir = join(options.inDir, entry)
    if (!statSync(dir).isDirectory()) continue
    const analysis = analyseRun(dir, entry)
    if (analysis) runs.push(analysis)
  }

  runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt))

  console.log(
    `variant=${EXPECTED.variant ?? 'baseline'} expected FINAL_TOTAL=${EXPECTED.expectedFinalTotal}` +
      (EXPECTED.expectedFinalChecksum === undefined
        ? ''
        : ` FINAL_CHECKSUM=${EXPECTED.expectedFinalChecksum}`) +
      ` over ${EXPECTED.hops} hops`
  )
  console.log(`traversal: ${EXPECTED.traversalOrder.join(' -> ')}\n`)
  console.log('### Per-run summary\n')
  console.log(renderRunTable(runs))
  console.log('\n### Reasoning characters per assistant turn\n')
  console.log(renderReasoningTable(runs))
  console.log('\n### Signed reasoning on the wire (from the plugin api log)\n')
  console.log(renderWireTable(runs))
  console.log('\n### Outcome counts\n')
  console.log(renderOutcomeCounts(runs))

  if (options.jsonOut) {
    writeFileSync(
      options.jsonOut,
      `${JSON.stringify({ expected: EXPECTED, runs }, null, 2)}\n`,
      'utf8'
    )
    console.log(`\nwrote ${options.jsonOut}`)
  }
}

main()
