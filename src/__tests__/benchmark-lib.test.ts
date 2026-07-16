import { describe, expect, test } from 'bun:test'
import type { ModeOutcomeInput } from '../../scripts/benchmark-lib.mjs'
import {
  MODES,
  MODE_LABELS,
  RESULT_MARKER,
  aggregateLatencies,
  aggregateWorkerResults,
  assessModeCEvidence,
  buildModeConfig,
  buildModelReport,
  classifyPromptResult,
  evaluateRunOutcome,
  parseArgs,
  percentile,
  summarizeEmails,
  validateArgs
} from '../../scripts/benchmark-lib.mjs'

describe('benchmark parseArgs', () => {
  test('Given no flags When parsed Then returns opus-4-8 defaults', () => {
    const o = parseArgs([])
    expect(o.model).toBe('claude-opus-4-8')
    expect(o.workers).toBe(3)
    expect(o.reqs).toBe(2)
    expect(o.child).toBe(false)
    expect(o.region).toBe('us-east-1')
  })

  test('Given flags When parsed Then overrides applied', () => {
    const o = parseArgs([
      '--workers=6',
      '--reqs=4',
      '--model=claude-sonnet-4-5',
      '--child',
      '--mode=B',
      '--worker=2',
      '--port-base=25000'
    ])
    expect(o.workers).toBe(6)
    expect(o.reqs).toBe(4)
    expect(o.model).toBe('claude-sonnet-4-5')
    expect(o.child).toBe(true)
    expect(o.mode).toBe('B')
    expect(o.worker).toBe(2)
    expect(o.portBase).toBe(25000)
  })
})

describe('benchmark buildModeConfig', () => {
  test('Given mode A When built Then sticky with both spread flags off', () => {
    const c = buildModeConfig('A')
    expect(c.account_selection_strategy).toBe('sticky')
    expect(c.distribute_across_processes).toBe(false)
    expect(c.per_request_spread).toBe(false)
    expect(c.enable_log_api_request).toBe(true)
  })

  test('Given mode B When built Then distribute on, per-request off', () => {
    const c = buildModeConfig('B')
    expect(c.distribute_across_processes).toBe(true)
    expect(c.per_request_spread).toBe(false)
  })

  test('Given mode C When built Then both spread flags on', () => {
    const c = buildModeConfig('C')
    expect(c.distribute_across_processes).toBe(true)
    expect(c.per_request_spread).toBe(true)
  })

  test('Given unknown mode When built Then throws', () => {
    expect(() => buildModeConfig('Z')).toThrow('Unknown mode: Z')
  })

  test('MODES and MODE_LABELS are aligned', () => {
    expect(MODES).toEqual(['A', 'B', 'C'])
    expect(MODE_LABELS.A).toBe('all-same-account')
    expect(MODE_LABELS.B).toBe('distributed')
    expect(MODE_LABELS.C).toBe('per-request-spread')
  })
})

describe('benchmark percentile / aggregateLatencies', () => {
  test('Given empty When percentile Then 0', () => {
    expect(percentile([], 50)).toBe(0)
  })

  test('Given sorted values When p50/p95 Then indexed correctly', () => {
    const s = [10, 20, 30, 40, 100]
    expect(percentile(s, 50)).toBe(30)
    expect(percentile(s, 95)).toBe(100)
  })

  test('Given latencies When aggregated Then mean/p50/p95 rounded', () => {
    const a = aggregateLatencies([10, 20, 30])
    expect(a.count).toBe(3)
    expect(a.mean).toBe(20)
    expect(a.p50).toBe(20)
  })
})

describe('benchmark classifyPromptResult', () => {
  test('Given clean data with explicit 2xx When classified Then ok', () => {
    const c = classifyPromptResult({ data: { info: {} }, response: { status: 200 } })
    expect(c.ok).toBe(true)
    expect(c.rateLimited).toBe(false)
  })

  test('Given empty result with no response When classified Then not ok (status 0 is not success)', () => {
    expect(classifyPromptResult({}).ok).toBe(false)
    expect(classifyPromptResult(undefined).ok).toBe(false)
    expect(classifyPromptResult({ data: { info: {} } }).ok).toBe(false)
  })

  test('Given transport error When classified Then error, no token leak', () => {
    const c = classifyPromptResult({ error: { name: 'ApiError', message: 'boom' } })
    expect(c.ok).toBe(false)
    expect(c.message).toContain('ApiError')
  })

  test('Given 429 message When classified Then rateLimited', () => {
    const c = classifyPromptResult({
      data: { info: { error: { name: 'Throttled', message: 'HTTP 429 too many requests' } } }
    })
    expect(c.ok).toBe(false)
    expect(c.rateLimited).toBe(true)
  })

  test('Given assistant message error When classified Then error', () => {
    const c = classifyPromptResult({
      data: { info: { error: { name: 'ProviderAuthError', message: 'bad' } } },
      response: { status: 200 }
    })
    expect(c.ok).toBe(false)
  })
})

describe('benchmark summarizeEmails', () => {
  test('Given request-log entries When summarized Then per-email counts', () => {
    const counts = summarizeEmails([
      { email: 'a@x.com' },
      { email: 'a@x.com' },
      { email: 'b@x.com' },
      { notEmail: 1 },
      {}
    ])
    expect(counts).toEqual({ 'a@x.com': 2, 'b@x.com': 1 })
  })

  test('Given no emails When summarized Then empty object', () => {
    expect(summarizeEmails([{}, { email: '' }])).toEqual({})
  })
})

describe('benchmark buildModelReport', () => {
  test('Given resolver When built Then reports display + wire id', () => {
    const stub = (m: string) => ({ wireId: `${m}.wire`, effort: undefined })
    const r = buildModelReport('claude-opus-4-8', stub)
    expect(r.displayModel).toBe('claude-opus-4-8')
    expect(r.wireId).toBe('claude-opus-4-8.wire')
    expect(r.effort).toBeNull()
  })

  test('Given effort variant When built Then effort surfaced', () => {
    const stub = () => ({ wireId: 'claude-opus-4.8', effort: 'high' })
    const r = buildModelReport('claude-opus-4-8-high', stub)
    expect(r.wireId).toBe('claude-opus-4.8')
    expect(r.effort).toBe('high')
  })
})

describe('benchmark aggregateWorkerResults', () => {
  test('Given worker results When aggregated Then totals + throughput + distinct accounts', () => {
    const workerResults = [
      { latencies: [100, 200], success: 2, errors: 0, rateLimited: 0 },
      { latencies: [150], success: 0, errors: 1, rateLimited: 1 }
    ]
    const res = aggregateWorkerResults('B', workerResults, 2000, 3, {
      'a@x.com': 2,
      'b@x.com': 1
    })
    expect(res.mode).toBe('B')
    expect(res.label).toBe('distributed')
    expect(res.success).toBe(2)
    expect(res.errors).toBe(1)
    expect(res.rateLimited).toBe(1)
    expect(res.totalReqs).toBe(3)
    expect(res.throughputReqPerSec).toBe(1.5)
    expect(res.distinctAccountsSelected).toBe(2)
    expect(res.latencyMs.p50).toBeGreaterThan(0)
  })

  test('Given zero wall time When aggregated Then throughput 0 (no divide-by-zero)', () => {
    const res = aggregateWorkerResults('A', [{ latencies: [], success: 0, errors: 0 }], 0, 0, {})
    expect(res.throughputReqPerSec).toBe(0)
  })
})

describe('benchmark RESULT_MARKER', () => {
  test('Given the shared marker When read Then it is a stable non-empty token', () => {
    expect(RESULT_MARKER).toBe('__BENCH_RESULT__')
  })
})

describe('benchmark validateArgs', () => {
  test('Given valid defaults When validated Then no error', () => {
    expect(validateArgs(parseArgs([]))).toBeNull()
  })

  test('Given reqs=1 When validated Then allowed as a smoke test', () => {
    expect(validateArgs(parseArgs(['--reqs=1']))).toBeNull()
  })

  test('Given zero workers When validated Then rejected', () => {
    const err = validateArgs(parseArgs(['--workers=0']))
    expect(err).toContain('workers')
  })

  test('Given negative reqs When validated Then rejected', () => {
    const err = validateArgs(parseArgs(['--reqs=-2']))
    expect(err).toContain('reqs')
  })

  test('Given fractional workers When validated Then rejected', () => {
    const err = validateArgs(parseArgs(['--workers=2.5']))
    expect(err).toContain('workers')
  })

  test('Given NaN reqs When validated Then rejected', () => {
    const err = validateArgs(parseArgs(['--reqs=abc']))
    expect(err).toContain('reqs')
  })

  test('Given zero port-base When validated Then rejected', () => {
    const err = validateArgs(parseArgs(['--port-base=0']))
    expect(err).toContain('port')
  })

  test('Given fractional port-base When validated Then rejected', () => {
    const err = validateArgs(parseArgs(['--port-base=24100.5']))
    expect(err).toContain('port')
  })

  test('Given empty model When validated Then rejected', () => {
    const err = validateArgs(parseArgs(['--model=']))
    expect(err).toContain('model')
  })
})

describe('benchmark evaluateRunOutcome', () => {
  const modeResult = (
    mode: string,
    totalReqs: number,
    perAccount: Record<string, number>,
    over: Partial<ModeOutcomeInput> = {}
  ): ModeOutcomeInput => ({
    mode,
    totalReqs,
    success: totalReqs,
    errors: 0,
    rateLimited: 0,
    perAccount,
    ...over
  })

  const validF2Run = (): ModeOutcomeInput[] => [
    modeResult('A', 4, { 'a@x.com': 4 }),
    modeResult('B', 4, { 'a@x.com': 2, 'b@x.com': 2 }),
    modeResult('C', 4, { 'a@x.com': 2, 'b@x.com': 2 })
  ]
  const F2_POLICY = { requireModeCSpread: true }
  const SMOKE_POLICY = { requireModeCSpread: false }

  test('Given a fully valid F2 run When evaluated Then ok with no reasons', () => {
    const o = evaluateRunOutcome(validF2Run(), F2_POLICY)
    expect(o.ok).toBe(true)
    expect(o.reasons).toEqual([])
  })

  test('Given a mode with errors When evaluated Then not ok and reason cites errors', () => {
    const run = validF2Run()
    run[1] = modeResult('B', 4, { 'a@x.com': 2, 'b@x.com': 1 }, { success: 3, errors: 1 })
    const o = evaluateRunOutcome(run, F2_POLICY)
    expect(o.ok).toBe(false)
    expect(o.reasons.join(' ')).toContain('B')
  })

  test('Given a rate-limited mode When evaluated Then not ok and reason cites 429', () => {
    const run = validF2Run()
    run[2] = modeResult(
      'C',
      4,
      { 'a@x.com': 2, 'b@x.com': 1 },
      {
        success: 3,
        errors: 1,
        rateLimited: 1
      }
    )
    const o = evaluateRunOutcome(run, F2_POLICY)
    expect(o.ok).toBe(false)
    expect(o.reasons.join(' ')).toMatch(/429|rate/i)
  })

  test('Given fewer successes than planned When evaluated Then not ok (missing requests)', () => {
    const run = validF2Run()
    run[0] = modeResult('A', 4, { 'a@x.com': 2 }, { success: 2 })
    const o = evaluateRunOutcome(run, F2_POLICY)
    expect(o.ok).toBe(false)
    expect(o.reasons.join(' ')).toContain('A')
  })

  test('Given more successes than planned When evaluated Then not ok (over-count rejected)', () => {
    const run = validF2Run()
    run[0] = modeResult('A', 4, { 'a@x.com': 4 }, { success: 5 })
    const o = evaluateRunOutcome(run, F2_POLICY)
    expect(o.ok).toBe(false)
    expect(o.reasons.join(' ')).toContain('A')
  })

  test('Given incomplete account logs When evaluated Then not ok (log sum < totalReqs)', () => {
    const run = validF2Run()
    run[1] = modeResult('B', 4, { 'a@x.com': 1 })
    const o = evaluateRunOutcome(run, F2_POLICY)
    expect(o.ok).toBe(false)
    expect(o.reasons.join(' ')).toMatch(/log|account/i)
  })

  test('Given zero account logs When evaluated Then not ok (no distribution evidence)', () => {
    const run = validF2Run()
    run[1] = modeResult('B', 4, {})
    const o = evaluateRunOutcome(run, F2_POLICY)
    expect(o.ok).toBe(false)
    expect(o.reasons.join(' ')).toContain('B')
  })

  test('Given Mode A with two accounts When evaluated Then not ok (A must pin one account)', () => {
    const run = validF2Run()
    run[0] = modeResult('A', 4, { 'a@x.com': 2, 'b@x.com': 2 })
    const o = evaluateRunOutcome(run, F2_POLICY)
    expect(o.ok).toBe(false)
    expect(o.reasons.join(' ')).toContain('A')
  })

  test('Given Mode B with one account and >=2 planned reqs When evaluated Then not ok (F1 undemonstrated)', () => {
    const run = validF2Run()
    run[1] = modeResult('B', 4, { 'a@x.com': 4 })
    const o = evaluateRunOutcome(run, F2_POLICY)
    expect(o.ok).toBe(false)
    expect(o.reasons.join(' ')).toContain('B')
  })

  test('Given Mode C with two accounts under F2 policy When evaluated Then ok', () => {
    const o = evaluateRunOutcome(validF2Run(), F2_POLICY)
    expect(o.ok).toBe(true)
  })

  test('Given Mode C with one account under F2 policy When evaluated Then not ok (F2 undemonstrated)', () => {
    const run = validF2Run()
    run[2] = modeResult('C', 4, { 'a@x.com': 4 })
    const o = evaluateRunOutcome(run, F2_POLICY)
    expect(o.ok).toBe(false)
    expect(o.reasons.join(' ')).toContain('C')
  })

  test('Given a 1x1 smoke run under smoke policy When evaluated Then ok (C not failed on account count)', () => {
    const smokeRun: ModeOutcomeInput[] = [
      modeResult('A', 1, { 'a@x.com': 1 }),
      modeResult('B', 1, { 'a@x.com': 1 }),
      modeResult('C', 1, { 'a@x.com': 1 })
    ]
    const o = evaluateRunOutcome(smokeRun, SMOKE_POLICY)
    expect(o.ok).toBe(true)
  })

  test('Given a missing mode result When evaluated Then not ok', () => {
    const run = validF2Run().slice(0, 2)
    const o = evaluateRunOutcome(run, F2_POLICY)
    expect(o.ok).toBe(false)
    expect(o.reasons.join(' ')).toContain('C')
  })

  test('Given no results When evaluated Then not ok', () => {
    const o = evaluateRunOutcome([], F2_POLICY)
    expect(o.ok).toBe(false)
  })
})

describe('benchmark assessModeCEvidence', () => {
  test('Given >=2 reqs per worker When assessed Then Mode C is valid F2 evidence', () => {
    const a = assessModeCEvidence(2)
    expect(a.valid).toBe(true)
  })

  test('Given 1 req per worker When assessed Then Mode C is smoke-only, not F2 evidence', () => {
    const a = assessModeCEvidence(1)
    expect(a.valid).toBe(false)
    expect(a.note).toMatch(/smoke|per-request/i)
  })
})
