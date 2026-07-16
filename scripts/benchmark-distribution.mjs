#!/usr/bin/env node
/**
 * Account-distribution benchmark harness (dev tool — NOT shipped in dist).
 *
 * Measures real request throughput across 3 account-distribution modes by hitting
 * the REAL CodeWhisperer API using the tokens already in kiro.db:
 *   A "all-same"     : every worker+request forced onto ONE account (current pain)
 *   B "distributed"  : worker w uses ample account w % numAmple (F1 cross-process)
 *   C "spread"       : each request picks the currently-lowest in-run count (F2)
 *
 * Usage:
 *   node scripts/benchmark-distribution.mjs --workers=6 --reqs=3 --model=claude-sonnet-4-5
 *   node scripts/benchmark-distribution.mjs --dry-run           # validate + print plan, NO AWS
 *
 * Imports the BUILT dist/ (run `bun run build` first). Writes raw JSON results to
 * .omo/reports/account-distribution-benchmark.json for the analysis report.
 */
import { GenerateAssistantResponseCommand } from '@aws/codewhisperer-streaming-client'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')

// ---- args ----
function parseArgs(argv) {
  const o = { workers: 6, reqs: 3, model: 'claude-opus-4-8', region: 'us-east-1', dryRun: false }
  for (const a of argv.slice(2)) {
    const m = /^--([a-zA-Z-]+)(?:=(.*))?$/.exec(a)
    if (!m) continue
    const [, k, v] = m
    if (k === 'dry-run') o.dryRun = true
    else if (k === 'workers') o.workers = Number(v)
    else if (k === 'reqs') o.reqs = Number(v)
    else if (k === 'model') o.model = v
    else if (k === 'region') o.region = v
  }
  return o
}

const args = parseArgs(process.argv)

// ---- dynamic imports from built dist ----
async function loadDeps() {
  const sqlite = await import(join(DIST, 'plugin/storage/sqlite.js'))
  const request = await import(join(DIST, 'plugin/request.js'))
  const sdkClient = await import(join(DIST, 'plugin/sdk-client.js'))
  const token = await import(join(DIST, 'plugin/token.js'))
  const auth = await import(join(DIST, 'kiro/auth.js'))
  return { sqlite, request, sdkClient, token, auth }
}

function rowToAuth(r, encodeRefreshToken) {
  const p = {
    refreshToken: r.refresh_token,
    profileArn: r.profile_arn,
    clientId: r.client_id,
    clientSecret: r.client_secret,
    authMethod: r.auth_method
  }
  return {
    refresh: encodeRefreshToken(p),
    access: r.access_token,
    expires: r.expires_at,
    authMethod: r.auth_method,
    region: r.region,
    oidcRegion: r.oidc_region || undefined,
    profileArn: r.profile_arn,
    clientId: r.client_id,
    clientSecret: r.client_secret,
    email: r.email
  }
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

async function runOneRequest(deps, authDetails, model, region) {
  const { request, sdkClient } = deps
  const body = {
    model,
    messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    max_tokens: 16,
    stream: false
  }
  const sdkPrep = request.transformToSdkRequest(body, model, authDetails, false, 20000, undefined)
  const client = sdkClient.createSdkClient(authDetails, sdkPrep.region || region, sdkPrep.effort)
  const command = new GenerateAssistantResponseCommand({
    conversationState: sdkPrep.conversationState,
    profileArn: sdkPrep.profileArn
  })
  const t0 = performance.now()
  try {
    const resp = await client.send(command)
    // drain the stream so latency reflects full response
    const es = resp.generateAssistantResponseResponse
    if (es) {
      for await (const _ of es) {
        void _
      }
    }
    return { ok: true, ms: performance.now() - t0, status: 200 }
  } catch (e) {
    const status = e?.$metadata?.httpStatusCode || 0
    return { ok: false, ms: performance.now() - t0, status, error: e?.name || String(e) }
  }
}

async function ensureFresh(deps, authDetails) {
  const { token, auth } = deps
  if (!auth.accessTokenExpired(authDetails, 120000)) return authDetails
  try {
    return await token.refreshAccessToken(authDetails)
  } catch (e) {
    console.warn(`  [warn] refresh failed for ${authDetails.email}: ${e?.message || e} — skipping`)
    return null
  }
}

async function benchMode(deps, mode, ampleAuths, args) {
  // assign an account per (worker, reqIndex) based on mode
  const perAccountCount = {}
  const latencies = []
  let success = 0
  let errors = 0
  let rateLimited = 0
  const runCount = new Map(ampleAuths.map((a) => [a.email, 0]))

  const pickAccount = (worker) => {
    if (mode === 'A') return ampleAuths[0]
    if (mode === 'B') return ampleAuths[worker % ampleAuths.length]
    // mode C: lowest in-run count
    let best = ampleAuths[0]
    for (const a of ampleAuths) if (runCount.get(a.email) < runCount.get(best.email)) best = a
    return best
  }

  const worker = async (w) => {
    for (let i = 0; i < args.reqs; i++) {
      const acc = pickAccount(w)
      runCount.set(acc.email, runCount.get(acc.email) + 1)
      perAccountCount[acc.email] = (perAccountCount[acc.email] || 0) + 1
      const r = await runOneRequest(deps, acc, args.model, args.region)
      latencies.push(r.ms)
      if (r.ok) success++
      else {
        errors++
        if (r.status === 429) rateLimited++
      }
    }
  }

  const t0 = performance.now()
  await Promise.all(Array.from({ length: args.workers }, (_, w) => worker(w)))
  const wallMs = performance.now() - t0

  const sorted = [...latencies].sort((a, b) => a - b)
  const mean = latencies.reduce((s, x) => s + x, 0) / (latencies.length || 1)
  const totalReqs = args.workers * args.reqs
  return {
    mode,
    label: mode === 'A' ? 'all-same-account' : mode === 'B' ? 'distributed' : 'per-request-spread',
    wallMs: Math.round(wallMs),
    totalReqs,
    success,
    errors,
    rateLimited,
    throughputReqPerSec: +(totalReqs / (wallMs / 1000)).toFixed(3),
    latencyMs: {
      mean: Math.round(mean),
      p50: Math.round(pct(sorted, 50)),
      p95: Math.round(pct(sorted, 95))
    },
    perAccount: perAccountCount
  }
}

async function main() {
  console.log('=== account-distribution benchmark ===')
  console.log(
    `config: workers=${args.workers} reqs/worker=${args.reqs} model=${args.model} region=${args.region} dryRun=${args.dryRun}`
  )

  const deps = await loadDeps()
  const { sqlite, auth } = deps
  const db = sqlite.kiroDb
  const rows = db.getAccounts()

  // ample = healthy, not over quota, has room
  const ample = rows.filter(
    (r) =>
      r.is_healthy === 1 &&
      (r.overage_count || 0) === 0 &&
      (r.limit_count ? (r.used_count || 0) < r.limit_count : true)
  )

  console.log(`\naccounts: ${rows.length} total, ${ample.length} ample (healthy, under quota):`)
  for (const r of ample)
    console.log(`  - ${r.email}  ${r.used_count}/${r.limit_count}  ${r.region}`)

  if (ample.length < 2) {
    console.error('\nNeed >=2 ample accounts to compare distribution modes. Aborting.')
    process.exit(1)
  }

  console.log('\nplanned modes:')
  console.log(`  A all-same-account : ${args.workers}x${args.reqs} reqs all on ${ample[0].email}`)
  console.log(`  B distributed      : worker w -> ample[w % ${ample.length}]`)
  console.log(`  C per-request-spread: each request -> current lowest-count ample account`)

  if (args.dryRun) {
    console.log('\n[dry-run] wiring validated, no AWS calls made. Exit 0.')
    process.exit(0)
  }

  // build + refresh auths for ample accounts
  const authList = []
  for (const r of ample) {
    let a = rowToAuth(r, auth.encodeRefreshToken)
    a = await ensureFresh(deps, a)
    if (a) authList.push(a)
  }
  if (authList.length < 2) {
    console.error('Not enough refreshable accounts. Aborting.')
    process.exit(1)
  }

  const results = []
  for (const mode of ['A', 'B', 'C']) {
    console.log(`\n--- running mode ${mode} ---`)
    const res = await benchMode(deps, mode, mode === 'A' ? [authList[0]] : authList, args)
    console.log(
      `  wall=${res.wallMs}ms throughput=${res.throughputReqPerSec}req/s p50=${res.latencyMs.p50}ms p95=${res.latencyMs.p95}ms success=${res.success}/${res.totalReqs} errors=${res.errors} (429=${res.rateLimited})`
    )
    results.push(res)
  }

  const out = {
    generatedAt: new Date().toISOString(),
    config: {
      workers: args.workers,
      reqsPerWorker: args.reqs,
      model: args.model,
      region: args.region
    },
    ampleAccounts: ample.map((r) => ({ email: r.email, used: r.used_count, limit: r.limit_count })),
    results
  }
  const outPath = join(ROOT, '.omo/reports/account-distribution-benchmark.json')
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(out, null, 2))
  console.log(`\nresults written to ${outPath}`)
}

main().catch((e) => {
  console.error('benchmark failed:', e)
  process.exit(1)
})
