// Pure, side-effect-free helpers for the account-distribution benchmark.
// Kept dependency-free so they can be unit-tested under bun:test without any
// network, filesystem, or child-process access. All IO/orchestration lives in
// benchmark-distribution.mjs.

/**
 * The three distribution modes under test. Each maps to a concrete plugin
 * config fragment written into the isolated project + user kiro.json.
 *   A "all-same-account"    : sticky, no cross-process spread, no per-request
 *   B "distributed"         : sticky, cross-process start-index spread (F1)
 *   C "per-request-spread"  : sticky base + per-request lowest-usage (F2)
 */
export const MODES = ['A', 'B', 'C']

export const MODE_LABELS = {
  A: 'all-same-account',
  B: 'distributed',
  C: 'per-request-spread'
}

/**
 * Stdout sentinel a child worker prefixes to its JSON result line so the parent
 * can pick that line out of arbitrary log noise. Shared here so parent + child
 * agree on one literal (no drift between two hard-coded copies).
 */
export const RESULT_MARKER = '__BENCH_RESULT__'

/**
 * Build the kiro.json fragment for a mode. `sticky` is the shared base strategy
 * across all three so the only variables are the two distribution flags.
 * enable_log_api_request is forced on so the plugin emits a per-request log we
 * can mine for the actually-selected account (email only, never tokens).
 * usage_tracking_enabled is off to avoid extra usage-API calls contaminating
 * the measured window.
 */
export function buildModeConfig(mode) {
  const flags = {
    A: { distribute_across_processes: false, per_request_spread: false },
    B: { distribute_across_processes: true, per_request_spread: false },
    C: { distribute_across_processes: true, per_request_spread: true }
  }[mode]
  if (!flags) throw new Error(`Unknown mode: ${mode}`)
  return {
    account_selection_strategy: 'sticky',
    ...flags,
    enable_log_api_request: true,
    usage_tracking_enabled: false,
    auto_sync_kiro_cli: false
  }
}

export function parseArgs(argv) {
  const o = {
    workers: 3,
    reqs: 2,
    model: 'claude-opus-4-8',
    region: 'us-east-1',
    portBase: 24100,
    prompt: 'Reply with the single word: ok',
    child: false,
    mode: null,
    worker: 0
  }
  for (const a of argv) {
    const m = /^--([a-zA-Z-]+)(?:=(.*))?$/.exec(a)
    if (!m) continue
    const [, k, v] = m
    if (k === 'child') o.child = true
    else if (k === 'workers') o.workers = Number(v)
    else if (k === 'reqs') o.reqs = Number(v)
    else if (k === 'model') o.model = v
    else if (k === 'region') o.region = v
    else if (k === 'port-base') o.portBase = Number(v)
    else if (k === 'prompt') o.prompt = v
    else if (k === 'mode') o.mode = v
    else if (k === 'worker') o.worker = Number(v)
  }
  return o
}

function isPositiveInt(n) {
  return Number.isInteger(n) && n > 0
}

/**
 * Validate parsed CLI args at the boundary, BEFORE any AWS/OpenCode call.
 * Returns a human-readable reason string on the first invalid field, or null
 * when every field is acceptable. `reqs=1` is intentionally allowed as a smoke
 * test (Mode C evidence quality is assessed separately by assessModeCEvidence).
 */
export function validateArgs(args) {
  if (!isPositiveInt(args.workers)) {
    return `--workers must be a positive integer, got ${JSON.stringify(args.workers)}`
  }
  if (!isPositiveInt(args.reqs)) {
    return `--reqs must be a positive integer, got ${JSON.stringify(args.reqs)}`
  }
  if (!isPositiveInt(args.portBase)) {
    return `--port-base must be a positive integer, got ${JSON.stringify(args.portBase)}`
  }
  if (typeof args.model !== 'string' || args.model.length === 0) {
    return `--model must be a non-empty string, got ${JSON.stringify(args.model)}`
  }
  return null
}

function accountLogTotal(perAccount) {
  return Object.values(perAccount || {}).reduce((s, n) => s + n, 0)
}

function distinctAccounts(perAccount) {
  return Object.keys(perAccount || {}).length
}

function checkModeCompletion(reasons, mode, r) {
  if (r.errors > 0) reasons.push(`mode ${mode}: ${r.errors} error(s)`)
  if (r.rateLimited > 0) {
    reasons.push(`mode ${mode}: ${r.rateLimited} rate-limited (429) request(s)`)
  }
  if (r.success !== r.totalReqs) {
    reasons.push(`mode ${mode}: ${r.success}/${r.totalReqs} succeeded (expected exactly ${r.totalReqs})`)
  }
  const logTotal = accountLogTotal(r.perAccount)
  if (logTotal !== r.totalReqs) {
    reasons.push(
      `mode ${mode}: account logs cover ${logTotal}/${r.totalReqs} request(s) (incomplete distribution evidence)`
    )
  }
}

function checkModeDistribution(reasons, mode, r, requireModeCSpread) {
  const distinct = distinctAccounts(r.perAccount)
  if (mode === 'A' && distinct !== 1) {
    reasons.push(`mode A: selected ${distinct} account(s) (all-same-account requires exactly 1)`)
  }
  if (mode === 'B' && r.totalReqs >= 2 && distinct < 2) {
    reasons.push(`mode B: selected ${distinct} account(s) (F1 distribution requires >=2)`)
  }
  if (mode === 'C' && requireModeCSpread && distinct < 2) {
    reasons.push(`mode C: selected ${distinct} account(s) (F2 per-request spread requires >=2)`)
  }
}

/**
 * Decide whether a completed benchmark run is trustworthy F1/F2 evidence.
 * A run is ok only when EVERY expected mode is present, each mode completed
 * EXACTLY its planned requests (no under- or over-count) with zero errors and
 * zero rate-limiting, each mode's per-account logs account for every request,
 * and the observed account spread matches each mode's contract:
 *   - A must pin exactly one account;
 *   - B must spread over >=2 accounts once there are >=2 planned requests (F1);
 *   - C must spread over >=2 accounts only when policy.requireModeCSpread is set
 *     (F2), which the caller derives from assessModeCEvidence(reqsPerWorker).
 * Pure: operates on the already-aggregated ModeResult list.
 */
export function evaluateRunOutcome(results, policy) {
  const requireModeCSpread = policy?.requireModeCSpread === true
  const reasons = []
  const byMode = new Map(results.map((r) => [r.mode, r]))
  for (const mode of MODES) {
    const r = byMode.get(mode)
    if (!r) {
      reasons.push(`mode ${mode}: missing result (mode did not run)`)
      continue
    }
    checkModeCompletion(reasons, mode, r)
    checkModeDistribution(reasons, mode, r, requireModeCSpread)
  }
  return { ok: reasons.length === 0, reasons }
}

/**
 * Assess whether Mode C (per-request spread, F2) produced meaningful evidence.
 * AccountManager increments its in-memory usedCount on every pick, so per-request
 * spread only becomes observable when each worker issues at least 2 sequential
 * requests. With reqs=1 the run is a valid smoke test but NOT F2 evidence.
 */
export function assessModeCEvidence(reqsPerWorker) {
  if (reqsPerWorker >= 2) {
    return { valid: true, note: 'per-request spread is observable (>=2 requests per worker)' }
  }
  return {
    valid: false,
    note: 'reqs=1 is a smoke test only — per-request spread needs >=2 requests per worker'
  }
}

export function percentile(sorted, p) {
  if (!sorted || sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

export function aggregateLatencies(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b)
  const count = sorted.length
  const mean = count === 0 ? 0 : sorted.reduce((s, x) => s + x, 0) / count
  return {
    count,
    mean: Math.round(mean),
    p50: Math.round(percentile(sorted, 50)),
    p95: Math.round(percentile(sorted, 95))
  }
}

/**
 * Classify one OpenCode session.prompt result (the hey-api `{ data, error,
 * response }` shape) into ok / error / rate-limited without exposing bodies.
 * A surfaced error means the plugin exhausted its internal retries.
 */
export function classifyPromptResult(result) {
  const parts = [
    result?.error ? stringifyError(result.error) : '',
    result?.data?.info?.error ? stringifyError(result.data.info.error) : ''
  ]
  const status = result?.response?.status ?? 0
  const message = parts.filter(Boolean).join(' | ')
  const ok = !message && status >= 200 && status < 300
  const rateLimited = /\b429\b|too\s*many|throttl/i.test(message) || status === 429
  return { ok, rateLimited, status, message: message.slice(0, 300) }
}

function stringifyError(err) {
  if (err == null) return ''
  if (typeof err === 'string') return err
  if (typeof err === 'object') {
    const name = err.name || err.__type || err.type || ''
    const msg = err.message || err.data || ''
    const joined = [name, typeof msg === 'string' ? msg : JSON.stringify(msg)]
      .filter(Boolean)
      .join(': ')
    return joined || JSON.stringify(err)
  }
  return String(err)
}

/**
 * Count per-account selections from mined plugin request logs. Input is the
 * list of parsed request-log objects; only the `email` field is read so no
 * credential material can leak into the report.
 */
export function summarizeEmails(logEntries) {
  const counts = {}
  for (const entry of logEntries) {
    const email = entry?.email
    if (typeof email === 'string' && email.length > 0) {
      counts[email] = (counts[email] || 0) + 1
    }
  }
  return counts
}

/**
 * Resolve the OpenCode-facing model id to its Kiro wire id using an injected
 * resolver (the real one comes from the built dist/plugin/models.js). Pure so
 * tests can pass a stub.
 */
export function buildModelReport(displayModel, resolveVariant) {
  const { wireId, effort } = resolveVariant(displayModel)
  return { displayModel, wireId, effort: effort ?? null }
}

export function aggregateWorkerResults(mode, workerResults, wallMs, totalReqs, perAccount) {
  const latencies = workerResults.flatMap((w) => w.latencies || [])
  let success = 0
  let errors = 0
  let rateLimited = 0
  for (const w of workerResults) {
    success += w.success || 0
    errors += w.errors || 0
    rateLimited += w.rateLimited || 0
  }
  const lat = aggregateLatencies(latencies)
  return {
    mode,
    label: MODE_LABELS[mode],
    wallMs: Math.round(wallMs),
    totalReqs,
    success,
    errors,
    rateLimited,
    throughputReqPerSec: wallMs > 0 ? +(totalReqs / (wallMs / 1000)).toFixed(3) : 0,
    latencyMs: { mean: lat.mean, p50: lat.p50, p95: lat.p95 },
    distinctAccountsSelected: Object.keys(perAccount).length,
    perAccount
  }
}
