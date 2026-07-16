#!/usr/bin/env node
/**
 * Account-distribution benchmark harness (dev tool — NOT shipped in dist).
 *
 * Exercises the REAL plugin under test end-to-end through real OpenCode runtime
 * sessions (`@opencode-ai/sdk` `createOpencode`) rather than hand-crafting
 * CodeWhisperer SDK calls. Each benchmark worker is a distinct OpenCode process
 * (a child of this script) that opens ONE session and sends REQS_PER_WORKER
 * sequential prompts through provider `kiro-auth`, so the plugin's account
 * selector, token refresher, model mapping, request transform, and SDK client
 * all run for real.
 *
 * Three modes, all sharing the SAME account dataset (a copy of the real
 * kiro.db) but each in an ISOLATED temporary OpenCode config that loads THIS
 * repository's plugin (not the globally-installed npm build):
 *   A "all-same-account"   : sticky, distribute_across_processes=false, per_request_spread=false
 *   B "distributed"        : sticky, distribute_across_processes=true,  per_request_spread=false (F1)
 *   C "per-request-spread" : sticky, distribute_across_processes=true,  per_request_spread=true  (F2)
 *
 * The real user config (~/.config/opencode/opencode.json, kiro.json, kiro.db)
 * is NEVER modified — everything runs against copies under a throwaway root.
 *
 * Usage:
 *   node scripts/benchmark-distribution.mjs --workers=3 --reqs=2 --model=claude-opus-4-8
 *
 * Requires a fresh `bun run build` (workers load the plugin from dist/). Writes
 * raw JSON results to .omo/reports/account-distribution-benchmark.json.
 */
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MODES,
  RESULT_MARKER,
  aggregateWorkerResults,
  assessModeCEvidence,
  buildModelReport,
  buildModeConfig,
  evaluateRunOutcome,
  parseArgs,
  summarizeEmails,
  validateArgs
} from './benchmark-lib.mjs'
import { realConfigDir, seedModeEnv } from './benchmark-env.mjs'
import { runWorkerEntry } from './benchmark-runtime.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')

// ---- parent: concurrent worker processes over the per-mode isolated env ----
function spawnWorker(args, env, cwd) {
  return new Promise((resolve) => {
    const childArgs = [
      fileURLToPath(import.meta.url),
      '--child',
      `--mode=${args.mode}`,
      `--worker=${args.worker}`,
      `--reqs=${args.reqs}`,
      `--model=${args.model}`,
      `--region=${args.region}`,
      `--port-base=${args.portBase}`,
      `--prompt=${args.prompt}`
    ]
    const child = spawn(process.execPath, childArgs, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => {
      out += d.toString()
    })
    child.stderr.on('data', (d) => {
      err += d.toString()
    })
    child.on('close', () => {
      const line = out.split('\n').find((l) => l.startsWith(RESULT_MARKER))
      let parseNote = `no result; stderr: ${err.slice(-300)}`
      if (line) {
        try {
          resolve(JSON.parse(line.slice(RESULT_MARKER.length)))
          return
        } catch (parseErr) {
          parseNote = `result line failed to parse: ${(parseErr?.message || String(parseErr)).slice(0, 200)}`
        }
      }
      resolve({
        worker: args.worker,
        mode: args.mode,
        latencies: [],
        success: 0,
        errors: 1,
        rateLimited: 0,
        messages: [{ ok: false, status: 0, ms: 0, note: parseNote }]
      })
    })
  })
}

function mineEmailCounts(opencodeConfigDir) {
  const logsDir = join(opencodeConfigDir, 'kiro-auth-plugin', 'logs')
  if (!existsSync(logsDir)) return {}
  const entries = []
  for (const f of readdirSync(logsDir)) {
    if (!f.endsWith('_request.json')) continue
    try {
      entries.push(JSON.parse(readFileSync(join(logsDir, f), 'utf-8')))
    } catch (readErr) {
      console.warn(`  skipped unreadable request log ${f}: ${(readErr?.message || String(readErr)).slice(0, 160)}`)
    }
  }
  return summarizeEmails(entries)
}

async function runMode(mode, baseRoot, sharedDbFiles, args) {
  const env0 = seedModeEnv(baseRoot, mode, sharedDbFiles, args.workers, ROOT)

  // Distinct port band per mode so a just-exited server's socket in TIME_WAIT
  // can't collide with the next mode's worker binding the same port.
  const modeIndex = MODES.indexOf(mode)
  const portBase = args.portBase + modeIndex * 100

  console.log(`\n--- mode ${mode} (${JSON.stringify(buildModeConfig(mode))}) ---`)
  const t0 = performance.now()
  const workerResults = await Promise.all(
    Array.from({ length: args.workers }, (_, w) => {
      const childEnv = {
        ...process.env,
        XDG_CONFIG_HOME: env0.xdgConfig,
        XDG_DATA_HOME: env0.workerDataDirs[w],
        KIRO_ACCOUNT_SELECTION_STRATEGY: 'sticky'
      }
      return spawnWorker({ ...args, mode, worker: w, portBase }, childEnv, env0.projectDir)
    })
  )
  const wallMs = performance.now() - t0

  // Actual per-account selection derived from the plugin's own request logs.
  const perAccount = mineEmailCounts(env0.opencodeConfigDir)
  const totalReqs = args.workers * args.reqs
  const res = aggregateWorkerResults(mode, workerResults, wallMs, totalReqs, perAccount)
  // Surface per-worker request notes (no tokens) so the report is diagnosable.
  res.workers = workerResults.map((w) => ({ worker: w.worker, messages: w.messages || [] }))
  console.log(
    `  wall=${res.wallMs}ms throughput=${res.throughputReqPerSec}req/s ` +
      `p50=${res.latencyMs.p50}ms p95=${res.latencyMs.p95}ms ` +
      `success=${res.success}/${res.totalReqs} errors=${res.errors} (429=${res.rateLimited}) ` +
      `accounts=${res.distinctAccountsSelected} ${JSON.stringify(res.perAccount)}`
  )
  return res
}

async function main(args) {
  console.log('=== account-distribution benchmark (real OpenCode sessions) ===')

  // Fail on invalid CLI input BEFORE spawning any OpenCode process or touching
  // AWS — a bad --workers/--reqs/--port-base should never reach the network.
  const argError = validateArgs(args)
  if (argError) {
    console.error(`invalid arguments: ${argError}`)
    process.exit(2)
  }

  // Resolve + report OpenCode-facing model -> Kiro wire id via the built plugin.
  const models = await import(join(DIST, 'plugin/models.js')).catch(() => null)
  if (!models) {
    console.error('dist/plugin/models.js not found — run `bun run build` first.')
    process.exit(1)
  }
  const modelReport = buildModelReport(args.model, models.resolveModelVariant)
  console.log(
    `model: ${modelReport.displayModel} -> wire ${modelReport.wireId}` +
      (modelReport.effort ? ` effort=${modelReport.effort}` : '')
  )
  console.log(
    `config: workers=${args.workers} reqs/worker=${args.reqs} region=${args.region} portBase=${args.portBase}`
  )

  // Mode C (per-request spread, F2) only produces observable evidence when each
  // worker issues >=2 sequential requests; reqs=1 is a valid smoke test but must
  // not be mistaken for F2 evidence. Recorded into the report so a smoke run is
  // never mislabeled as F2 evidence downstream.
  const modeCEvidence = assessModeCEvidence(args.reqs)
  console.log(
    `mode C evidence: ${modeCEvidence.valid ? 'valid' : 'SMOKE-ONLY'} — ${modeCEvidence.note}`
  )

  // Locate the real kiro.db (+ WAL sidecars) to copy into each mode's env.
  const realDir = realConfigDir()
  const sharedDbFiles = []
  for (const name of ['kiro.db', 'kiro.db-shm', 'kiro.db-wal']) {
    const src = join(realDir, name)
    if (existsSync(src)) sharedDbFiles.push([name, src])
  }
  if (!sharedDbFiles.some(([n]) => n === 'kiro.db')) {
    console.error(`No kiro.db found at ${realDir}. Aborting.`)
    process.exit(1)
  }

  const baseRoot = mkdtempSync(join('/tmp/opencode', 'bench-'))
  const results = []
  try {
    for (const mode of MODES) {
      results.push(await runMode(mode, baseRoot, sharedDbFiles, args))
    }
  } finally {
    try {
      rmSync(baseRoot, { recursive: true, force: true })
    } catch (cleanupErr) {
      console.warn(
        `failed to remove temp root ${baseRoot}: ${(cleanupErr?.message || String(cleanupErr)).slice(0, 160)}`
      )
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    harness: 'opencode-runtime-sessions',
    config: {
      workers: args.workers,
      reqsPerWorker: args.reqs,
      region: args.region,
      modeCEvidence
    },
    model: modelReport,
    results
  }
  const outPath = join(ROOT, '.omo/reports/account-distribution-benchmark.json')
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`)
  console.log(`\nresults written to ${outPath}`)

  // Decide trustworthiness AFTER the JSON artifact is on disk, so a failed run
  // still leaves the raw evidence for inspection but the process exits non-zero.
  // Mode C multi-account spread is only required when this run qualifies as F2
  // evidence (reqs>=2); a reqs=1 smoke run must not fail solely on C's count.
  const outcome = evaluateRunOutcome(results, { requireModeCSpread: modeCEvidence.valid })
  if (!outcome.ok) {
    console.error('\nbenchmark FAILED — run is not valid distribution evidence:')
    for (const reason of outcome.reasons) console.error(`  - ${reason}`)
    process.exit(1)
  }
  console.log('\nbenchmark OK — all modes completed every planned request with no errors.')
}

const args = parseArgs(process.argv.slice(2))
if (!existsSync('/tmp/opencode')) mkdirSync('/tmp/opencode', { recursive: true })

if (args.child) {
  if (!args.mode) {
    console.error('child mode requires --mode')
    process.exit(1)
  }
  runWorkerEntry(args).catch((e) => {
    process.stdout.write(
      `${RESULT_MARKER}${JSON.stringify({
        worker: args.worker,
        mode: args.mode,
        latencies: [],
        success: 0,
        errors: 1,
        rateLimited: 0,
        messages: [{ ok: false, status: 0, ms: 0, note: (e?.message || String(e)).slice(0, 300) }]
      })}\n`
    )
    process.exit(0)
  })
} else {
  main(args).catch((e) => {
    console.error('benchmark failed:', e)
    process.exit(1)
  })
}
