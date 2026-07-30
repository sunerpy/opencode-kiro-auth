/**
 * Recompute every table in `scripts/probes/PREMATURE-STOP-INVESTIGATION.md` from the raw
 * artifacts, so no number in that document is hand-copied.
 *
 * Two independent inputs, either or both:
 *   --phase1 <runsDir>   OpenCode provider-comparison runs written by
 *                        `ab-opencode/run-ab.ts --mode provider`
 *   --phase2 <file.json> a raw result file written by `turn2-variant-probe.ts`
 *
 * ZERO API calls.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseArgs(argv: readonly string[]): {
  phase1?: string
  phase2?: string
  baseline: string
} {
  let phase1: string | undefined
  let phase2: string | undefined
  let baseline = 'V0'
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--phase1' && value) {
      phase1 = value
      i += 1
    } else if (flag === '--phase2' && value) {
      phase2 = value
      i += 1
    } else if (flag === '--baseline' && value) {
      baseline = value
      i += 1
    }
  }
  return { ...(phase1 ? { phase1 } : {}), ...(phase2 ? { phase2 } : {}), baseline }
}

const LOG_FACTORIAL_CACHE: number[] = [0, 0]

function logFactorial(n: number): number {
  for (let i = LOG_FACTORIAL_CACHE.length; i <= n; i += 1) {
    const previous = LOG_FACTORIAL_CACHE[i - 1]
    if (previous === undefined) throw new Error('log-factorial cache corrupted')
    LOG_FACTORIAL_CACHE[i] = previous + Math.log(i)
  }
  const value = LOG_FACTORIAL_CACHE[n]
  if (value === undefined) throw new Error(`log-factorial undefined for ${n}`)
  return value
}

/**
 * Hypergeometric point probability of the 2x2 table [[a,b],[c,d]] under fixed margins.
 * Computed in log space because the factorials overflow well before n=100.
 */
function tableProbability(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d
  const logP =
    logFactorial(a + b) +
    logFactorial(c + d) +
    logFactorial(a + c) +
    logFactorial(b + d) -
    logFactorial(n) -
    logFactorial(a) -
    logFactorial(b) -
    logFactorial(c) -
    logFactorial(d)
  return Math.exp(logP)
}

/** Two-sided Fisher exact test: sum of all tables no more probable than the observed one. */
function fisherExact(a: number, b: number, c: number, d: number): number {
  const observed = tableProbability(a, b, c, d)
  const rowOne = a + b
  const colOne = a + c
  const n = a + b + c + d
  const low = Math.max(0, colOne - (n - rowOne))
  const high = Math.min(rowOne, colOne)
  let total = 0
  const epsilon = 1e-12
  for (let x = low; x <= high; x += 1) {
    const probability = tableProbability(x, rowOne - x, colOne - x, n - rowOne - colOne + x)
    if (probability <= observed * (1 + epsilon)) total += probability
  }
  return Math.min(1, total)
}

/** Wilson score interval, which stays inside [0,1] at the zero counts this data produces. */
function wilson(hits: number, total: number): string {
  if (total === 0) return 'n/a'
  const z = 1.959963984540054
  const p = hits / total
  const denominator = 1 + (z * z) / total
  const centre = p + (z * z) / (2 * total)
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))
  const low = Math.max(0, (centre - spread) / denominator)
  const high = Math.min(1, (centre + spread) / denominator)
  return `${(low * 100).toFixed(1)}–${(high * 100).toFixed(1)}%`
}

function pct(hits: number, total: number): string {
  return total === 0 ? 'n/a' : `${((hits / total) * 100).toFixed(1)}%`
}

interface ArmCount {
  readonly arm: string
  readonly model: string
  readonly runs: number
  readonly completed: number
  readonly announced: number
  readonly silent: number
  readonly other: number
}

function analysePhase1(runsDir: string): void {
  const byArm = new Map<string, { model: string; outcomes: string[] }>()
  for (const entry of readdirSync(runsDir).sort()) {
    const dir = join(runsDir, entry)
    if (!statSync(dir).isDirectory()) continue
    const metaPath = join(dir, 'meta.json')
    if (!existsSync(metaPath)) continue
    const meta: unknown = JSON.parse(readFileSync(metaPath, 'utf8'))
    const arm = isRecord(meta) && typeof meta.arm === 'string' ? meta.arm : 'unknown'
    const model = isRecord(meta) && typeof meta.model === 'string' ? meta.model : 'unknown'
    const outcome = classifyRun(dir)
    const slot = byArm.get(arm) ?? { model, outcomes: [] }
    slot.outcomes.push(outcome)
    byArm.set(arm, slot)
  }

  const counts: ArmCount[] = [...byArm.entries()]
    .map(([arm, slot]) => ({
      arm,
      model: slot.model,
      runs: slot.outcomes.length,
      completed: slot.outcomes.filter((o) => o === 'completed_correct').length,
      announced: slot.outcomes.filter((o) => o === 'announced_then_stopped').length,
      silent: slot.outcomes.filter((o) => o === 'silent_stop').length,
      other: slot.outcomes.filter((o) => o === 'other_failure').length
    }))
    .sort((left, right) => left.arm.localeCompare(right.arm))

  console.log('## Phase 1 — provider comparison on the same fixture\n')
  console.log(
    '| arm | model | runs | completed_correct | announced_then_stopped | silent_stop | other_failure | premature-stop rate | 95% CI |'
  )
  console.log(`|${'---|'.repeat(9)}`)
  for (const count of counts) {
    const stops = count.announced + count.silent
    console.log(
      `| ${count.arm} | ${count.model} | ${count.runs} | ${count.completed} | ${count.announced} | ` +
        `${count.silent} | ${count.other} | ${stops}/${count.runs} (${pct(stops, count.runs)}) | ${wilson(stops, count.runs)} |`
    )
  }

  console.log('\n### Pairwise two-sided Fisher exact on premature stop\n')
  console.log('| arm A | arm B | A stops/n | B stops/n | p |')
  console.log(`|${'---|'.repeat(5)}`)
  for (let i = 0; i < counts.length; i += 1) {
    for (let j = i + 1; j < counts.length; j += 1) {
      const a = counts[i]
      const b = counts[j]
      if (!a || !b) continue
      const aStops = a.announced + a.silent
      const bStops = b.announced + b.silent
      const p = fisherExact(aStops, a.runs - aStops, bStops, b.runs - bStops)
      console.log(
        `| ${a.arm} | ${b.arm} | ${aStops}/${a.runs} | ${bStops}/${b.runs} | ${p.toFixed(4)} |`
      )
    }
  }
}

const LEDGER_READ = /ledger\/(step\d{2})\.json/g
const FINAL_TOTAL = /FINAL_TOTAL\s*=\s*(-?\d+)/g
const FORWARD_LOOKING =
  /\b(next|now|then|proceed|continue|let me|i'?ll|i will|going to|step\s*\d)\b|接下来|下一步|继续/i

function collect(value: unknown, sink: string[]): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(LEDGER_READ)) {
      const name = match[1]
      if (name) sink.push(name)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, sink)
    return
  }
  if (isRecord(value)) for (const item of Object.values(value)) collect(item, sink)
}

/**
 * Deliberately mirrors `ab-opencode/analyze-ab.ts:classify` so Phase 1 is graded by exactly the
 * rule the committed 24-run baseline was graded by, rather than by a second, subtly different one.
 */
function classifyRun(runDir: string): string {
  const exportPath = join(runDir, 'export.json')
  if (!existsSync(exportPath)) return 'other_failure'
  const doc: unknown = JSON.parse(readFileSync(exportPath, 'utf8'))
  const messages = isRecord(doc) && Array.isArray(doc.messages) ? doc.messages : []
  const reads: string[] = []
  let lastTexts: string[] = []
  let lastHadTool = false
  let lastHadText = false
  let lastHadReasoning = false
  for (const message of messages) {
    if (!isRecord(message)) continue
    const info = isRecord(message.info) ? message.info : {}
    if (info.role !== 'assistant') continue
    const parts = Array.isArray(message.parts) ? message.parts : []
    const texts: string[] = []
    let tools = 0
    let reasoningChars = 0
    for (const part of parts) {
      if (!isRecord(part)) continue
      if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text)
      else if (part.type === 'tool') {
        tools += 1
        const state = isRecord(part.state) ? part.state : {}
        collect(state.input, reads)
      } else if (part.type === 'reasoning' && typeof part.text === 'string') {
        reasoningChars += part.text.length
      }
    }
    lastTexts = texts
    lastHadTool = tools > 0
    lastHadText = texts.join('').length > 0
    lastHadReasoning = reasoningChars > 0
  }

  const joined = lastTexts.join('\n')
  const claims = [...joined.matchAll(FINAL_TOTAL)].map((match) => Number(match[1]))
  const finalTotal = claims.length > 0 ? claims[claims.length - 1] : undefined
  const chainCompleted = new Set(reads).size >= 10
  if (chainCompleted && finalTotal === 231) return 'completed_correct'
  if (!lastHadText && !lastHadTool && !lastHadReasoning) return 'silent_stop'
  if (!chainCompleted && lastHadText && !lastHadTool && FORWARD_LOOKING.test(joined)) {
    return 'announced_then_stopped'
  }
  return 'other_failure'
}

interface Phase2Trial {
  readonly variant: string
  readonly outcome: string
}

function analysePhase2(paths: readonly string[], baselineName: string): void {
  const trials: Phase2Trial[] = []
  const hypotheses = new Map<string, string>()
  let realCalls = 0
  for (const path of paths) {
    const doc: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(doc)) continue
    if (typeof doc.realApiCalls === 'number') realCalls += doc.realApiCalls
    for (const variant of Array.isArray(doc.variants) ? doc.variants : []) {
      if (isRecord(variant) && typeof variant.name === 'string') {
        hypotheses.set(variant.name, String(variant.hypothesis ?? ''))
      }
    }
    for (const trial of Array.isArray(doc.trials) ? doc.trials : []) {
      if (!isRecord(trial)) continue
      if (typeof trial.variant !== 'string' || typeof trial.outcome !== 'string') continue
      trials.push({ variant: trial.variant, outcome: trial.outcome })
    }
  }

  const names = [...new Set(trials.map((trial) => trial.variant))].sort()
  const stats = names.map((name) => {
    const own = trials.filter((trial) => trial.variant === name)
    const valid = own.filter((trial) => trial.outcome !== 'error')
    return {
      name,
      hypothesis: hypotheses.get(name) ?? '',
      n: valid.length,
      stopped: valid.filter((trial) => trial.outcome === 'stopped').length,
      empty200: valid.filter((trial) => trial.outcome === 'empty200').length,
      continued: valid.filter((trial) => trial.outcome === 'continued').length,
      errors: own.length - valid.length
    }
  })

  console.log('\n## Phase 2 — turn-2 variant bisection\n')
  console.log(`real API calls across the loaded result files: ${realCalls}\n`)
  console.log(
    '| variant | hypothesis | n | stopped | rate | 95% CI | empty200 | continued | errors |'
  )
  console.log(`|${'---|'.repeat(9)}`)
  for (const row of stats) {
    console.log(
      `| ${row.name} | ${row.hypothesis} | ${row.n} | ${row.stopped} | ${pct(row.stopped, row.n)} | ` +
        `${wilson(row.stopped, row.n)} | ${row.empty200} | ${row.continued} | ${row.errors} |`
    )
  }

  const baseline = stats.find((row) => row.name === baselineName)
  if (!baseline) return
  console.log(
    `\n### Two-sided Fisher exact vs ${baselineName} (outcome: stopped, errors excluded)\n`
  )
  console.log(`| variant | stops/n | ${baselineName} stops/n | p |`)
  console.log(`|${'---|'.repeat(4)}`)
  for (const row of stats) {
    if (row.name === baselineName) continue
    const p = fisherExact(
      row.stopped,
      row.n - row.stopped,
      baseline.stopped,
      baseline.n - baseline.stopped
    )
    console.log(
      `| ${row.name} | ${row.stopped}/${row.n} | ${baseline.stopped}/${baseline.n} | ${p.toFixed(4)} |`
    )
  }

  console.log('\n### Detectable effect at this N (two-sided Fisher, alpha=0.05)\n')
  console.log(
    `With ${baselineName} at ${baseline.stopped}/${baseline.n}, the smallest number of stops in an ` +
      `n=${baseline.n} variant that would reach p<0.05 against ${baselineName} is reported below.`
  )
  for (const target of [baseline.n]) {
    let smallestSignificantDrop: number | null = null
    for (let hits = 0; hits <= baseline.stopped; hits += 1) {
      const p = fisherExact(hits, target - hits, baseline.stopped, baseline.n - baseline.stopped)
      if (p < 0.05) smallestSignificantDrop = hits
    }
    console.log(
      smallestSignificantDrop === null
        ? `  n=${target}: NO number of stops, not even 0, reaches p<0.05 — this N cannot resolve ` +
            'a complete elimination of the effect.'
        : `  n=${target}: at most ${smallestSignificantDrop} stops reaches p<0.05.`
    )
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2))
  if (!options.phase1 && !options.phase2) {
    console.error('nothing to do: pass --phase1 <runsDir> and/or --phase2 <file.json>')
    process.exitCode = 1
    return
  }
  if (options.phase1) analysePhase1(options.phase1)
  if (options.phase2) {
    const target = options.phase2
    const paths = statSync(target).isDirectory()
      ? readdirSync(target)
          .filter((name) => name.endsWith('.json'))
          .map((name) => join(target, name))
          .sort()
      : [target]
    analysePhase2(paths, options.baseline)
  }
}

main()
