/**
 * End-to-end A/B runner: the SAME long dependent tool chain, through the SAME OpenCode
 * binary and the SAME Kiro model, differing ONLY in which kiro-auth build is loaded.
 *
 *   OLD arm = published `@sunerpy/opencode-kiro-auth@0.15.4` (== pre-fix commit 80782f9)
 *   NEW arm = this working tree (Waves 1-6: signed reasoning replay)
 *
 * Isolation mechanism (empirically established, see AB-OPENCODE-COMPARISON.md §1):
 * `OPENCODE_CONFIG` MERGES with the user's global config and therefore cannot remove a
 * plugin. `XDG_CONFIG_HOME` DOES relocate config resolution wholesale, so each arm gets
 * its own `$XDG_CONFIG_HOME/opencode/opencode.json` declaring exactly one kiro-auth build.
 *
 * The plugin resolves `kiro.db`, `kiro-auth-plugin/kiro.json`, its logs and its
 * per-account refresh locks off the same `XDG_CONFIG_HOME`, so each arm symlinks those
 * back to the real ones. Symlinking (rather than copying) is deliberate: a rotated
 * refresh token is single-use, so a copied database would strand the real one with a
 * consumed token, and a private lock directory would defeat cross-process refresh
 * exclusion.
 *
 * Usage:
 *   CONFIRM=1 bun run scripts/probes/ab-opencode/run-ab.ts [--runs 3] [--model kiro-auth/claude-opus-5-high]
 */

import { spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

function fixtureDirFor(variant: string): string {
  return join(HERE, variant === 'baseline' ? 'fixture' : `fixture-${variant}`)
}

const OPENCODE_BIN =
  process.env.AB_OPENCODE_BIN ?? '/config/.local/share/mise/installs/opencode/1.18.5/opencode'
const REAL_CONFIG_DIR =
  process.env.AB_REAL_CONFIG_DIR ?? join(process.env.HOME ?? '/root', '.config', 'opencode')
const LOCAL_PLUGIN_PATH = process.env.AB_LOCAL_PLUGIN ?? join(HERE, '..', '..', '..')
const OLD_PLUGIN_SPEC = process.env.AB_OLD_PLUGIN ?? '@sunerpy/opencode-kiro-auth@0.15.4'
const SCRATCH = process.env.AB_SCRATCH ?? '/tmp/opencode/ab-arms'
const RUN_TIMEOUT_MS = Number(process.env.AB_RUN_TIMEOUT_MS ?? 900_000)

type Arm = 'old' | 'new'
const ARMS: readonly Arm[] = ['old', 'new']

interface Options {
  readonly runsPerArm: number
  readonly model: string
  readonly outDir: string
  readonly variant: string
  readonly startIndex: number
}

function parseArgs(argv: readonly string[]): Options {
  let runsPerArm = 3
  let model = 'kiro-auth/claude-opus-5-high'
  let outDir = join(HERE, 'runs')
  let variant = 'baseline'
  let startIndex = 1

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--runs' && value) {
      runsPerArm = Number(value)
      i += 1
    } else if (flag === '--model' && value) {
      model = value
      i += 1
    } else if (flag === '--out' && value) {
      outDir = value
      i += 1
    } else if (flag === '--variant' && value) {
      variant = value
      i += 1
    } else if (flag === '--start' && value) {
      startIndex = Number(value)
      i += 1
    }
  }

  if (!Number.isInteger(runsPerArm) || runsPerArm < 1) {
    throw new Error(`--runs must be a positive integer, got ${runsPerArm}`)
  }
  if (!Number.isInteger(startIndex) || startIndex < 1) {
    throw new Error(`--start must be a positive integer, got ${startIndex}`)
  }
  return { runsPerArm, model, outDir, variant, startIndex }
}

function pluginSpecFor(arm: Arm): string {
  return arm === 'old' ? OLD_PLUGIN_SPEC : LOCAL_PLUGIN_PATH
}

/** One XDG_CONFIG_HOME per arm; everything except opencode.json is shared with the real config. */
function prepareArm(arm: Arm): string {
  const root = join(SCRATCH, arm)
  const cfgDir = join(root, 'opencode')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(cfgDir, { recursive: true })

  for (const entry of ['kiro.db', 'kiro.db-wal', 'kiro.db-shm', 'kiro-auth-plugin']) {
    const target = join(REAL_CONFIG_DIR, entry)
    if (existsSync(target)) symlinkSync(target, join(cfgDir, entry))
  }

  writeFileSync(
    join(cfgDir, 'opencode.json'),
    `${JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        plugin: [pluginSpecFor(arm)],
        compaction: { auto: false, prune: false }
      },
      null,
      2
    )}\n`,
    'utf8'
  )

  return root
}

/** A fresh copy of the fixture per run, outside the repo, so no repo AGENTS.md leaks in. */
function prepareRunDir(arm: Arm, index: number, fixtureDir: string): string {
  const dir = join(SCRATCH, 'runs', `${arm}-${String(index).padStart(2, '0')}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  cpSync(join(fixtureDir, 'ledger'), join(dir, 'ledger'), { recursive: true })
  return dir
}

/**
 * Plugin settings are forced through env overrides rather than a project `.opencode/kiro.json`
 * because `KIRO_*` env handling is byte-identical in both builds (`dist/plugin/config/loader.js`
 * is the same file in 0.15.4 and at HEAD), so it cannot introduce an arm-specific difference.
 * `KIRO_ENABLE_LOG_API_REQUEST` turns on the per-process `api-*.ndjson` request log, which is
 * the channel that reveals whether signed reasoning was actually replayed on the wire.
 */
const PLUGIN_ENV: Readonly<Record<string, string>> = {
  KIRO_ENABLE_LOG_API_REQUEST: 'true',
  KIRO_ACCOUNT_SELECTION_STRATEGY: 'sticky'
}

interface SpawnResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

function runOpencode(args: readonly string[], cwd: string, xdg: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(OPENCODE_BIN, [...args], {
      cwd,
      env: {
        ...process.env,
        ...PLUGIN_ENV,
        XDG_CONFIG_HOME: xdg,
        OPENCODE_DISABLE_AUTOUPDATE: '1'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, RUN_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    })
  })
}

function extractSessionId(streamJsonl: string): string | undefined {
  for (const line of streamJsonl.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed === 'object' && parsed !== null && 'sessionID' in parsed) {
        const id = Reflect.get(parsed, 'sessionID')
        if (typeof id === 'string' && id) return id
      }
    } catch {
      // Non-JSON noise on stdout is recorded verbatim; it just cannot yield a session id.
    }
  }
  return undefined
}

function newestApiLogSince(logsDir: string, sinceMs: number): string | undefined {
  if (!existsSync(logsDir)) return undefined
  const candidates = readdirSync(logsDir)
    .filter((name) => name.startsWith('api-') && name.endsWith('.ndjson'))
    .map((name) => join(logsDir, name))
    .filter((path) => statSync(path).mtimeMs >= sinceMs)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return candidates[0]
}

interface RunMeta {
  readonly arm: Arm
  readonly variant: string
  readonly armPluginSpec: string
  readonly index: number
  readonly model: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly sessionId?: string
  readonly runDir: string
  readonly streamBytes: number
  readonly apiLogFile?: string
}

async function main(): Promise<void> {
  if (process.env.CONFIRM !== '1') {
    console.error('Refusing to run: this makes REAL Kiro API calls. Re-run with CONFIRM=1.')
    process.exitCode = 1
    return
  }

  const options = parseArgs(process.argv.slice(2))
  const fixtureDir = fixtureDirFor(options.variant)
  const prompt = readFileSync(join(fixtureDir, 'PROMPT.md'), 'utf8')
  const logsDir = join(REAL_CONFIG_DIR, 'kiro-auth-plugin', 'logs')

  mkdirSync(options.outDir, { recursive: true })
  const armRoots = new Map<Arm, string>()
  for (const arm of ARMS) armRoots.set(arm, prepareArm(arm))

  const metas: RunMeta[] = []

  const lastIndex = options.startIndex + options.runsPerArm - 1
  for (let index = options.startIndex; index <= lastIndex; index += 1) {
    for (const arm of ARMS) {
      const xdg = armRoots.get(arm)
      if (!xdg) throw new Error(`arm ${arm} was not prepared`)

      const runDir = prepareRunDir(arm, index, fixtureDir)
      const outDir = join(options.outDir, `${arm}-${String(index).padStart(2, '0')}`)
      rmSync(outDir, { recursive: true, force: true })
      mkdirSync(outDir, { recursive: true })

      const startedMs = Date.now()
      const startedAt = new Date(startedMs).toISOString()
      console.log(`[${startedAt}] arm=${arm} run=${index} model=${options.model} ...`)

      const result = await runOpencode(
        [
          'run',
          '--format',
          'json',
          '--auto',
          '--agent',
          'build',
          '--title',
          `ab-${arm}-${index}`,
          '--dir',
          runDir,
          '-m',
          options.model,
          prompt
        ],
        runDir,
        xdg
      )

      const finishedMs = Date.now()
      writeFileSync(join(outDir, 'stream.jsonl'), result.stdout, 'utf8')
      writeFileSync(join(outDir, 'stderr.log'), result.stderr, 'utf8')

      const sessionId = extractSessionId(result.stdout)
      if (sessionId) {
        const exported = await runOpencode(['export', sessionId], runDir, xdg)
        writeFileSync(join(outDir, 'export.json'), exported.stdout, 'utf8')
      }

      const apiLog = newestApiLogSince(logsDir, startedMs)
      if (apiLog) cpSync(apiLog, join(outDir, 'api.ndjson'))

      const meta: RunMeta = {
        arm,
        variant: options.variant,
        armPluginSpec: pluginSpecFor(arm),
        index,
        model: options.model,
        startedAt,
        finishedAt: new Date(finishedMs).toISOString(),
        durationMs: finishedMs - startedMs,
        exitCode: result.code,
        timedOut: result.timedOut,
        ...(sessionId ? { sessionId } : {}),
        runDir,
        streamBytes: result.stdout.length,
        ...(apiLog ? { apiLogFile: apiLog } : {})
      }
      metas.push(meta)
      writeFileSync(join(outDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')

      console.log(
        `  exit=${result.code} timedOut=${result.timedOut} ${meta.durationMs}ms session=${sessionId ?? 'n/a'}`
      )
    }
  }

  writeFileSync(
    join(options.outDir, 'index.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), options, runs: metas }, null, 2)}\n`,
    'utf8'
  )
  console.log(`\nwrote ${metas.length} runs to ${options.outDir}`)
}

await main()
