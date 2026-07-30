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
 *
 * `--mode provider` reuses the exact same isolation, fixture, `--dir` handling and artifact
 * layout, but swaps the independent variable: instead of two kiro-auth BUILDS it compares two
 * PROVIDERS reaching the same Claude Opus 5 — `kiro-auth` (this plugin's CodeWhisperer
 * translation) against `myopenai` (an OpenAI-protocol Bedrock gateway, i.e. standard
 * `tool`-role tool results). That isolates "is the premature stop specific to this plugin's
 * request translation?" from "is it the model".
 *
 *   CONFIRM=1 bun run scripts/probes/ab-opencode/run-ab.ts --mode provider --runs 14
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

type Arm = string
type Mode = 'build' | 'provider'

/** One isolated OpenCode configuration: which plugin(s) load, which model, which provider. */
interface ArmSpec {
  readonly name: Arm
  readonly plugins: readonly string[]
  readonly model: string
  readonly provider?: Readonly<Record<string, unknown>>
}

interface Options {
  readonly runsPerArm: number
  readonly model: string
  readonly outDir: string
  readonly variant: string
  readonly startIndex: number
  readonly mode: Mode
  readonly dry: boolean
}

function parseArgs(argv: readonly string[]): Options {
  let runsPerArm = 3
  let model = 'kiro-auth/claude-opus-5-high'
  let outDir = join(HERE, 'runs')
  let variant = 'baseline'
  let startIndex = 1
  let mode: Mode = 'build'
  let dry = false

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
    } else if (flag === '--mode' && value) {
      if (value !== 'build' && value !== 'provider') {
        throw new Error(`--mode must be build|provider, got ${value}`)
      }
      mode = value
      i += 1
    } else if (flag === '--dry') {
      dry = true
    }
  }

  if (!Number.isInteger(runsPerArm) || runsPerArm < 1) {
    throw new Error(`--runs must be a positive integer, got ${runsPerArm}`)
  }
  if (!Number.isInteger(startIndex) || startIndex < 1) {
    throw new Error(`--start must be a positive integer, got ${startIndex}`)
  }
  return { runsPerArm, model, outDir, variant, startIndex, mode, dry }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Lift ONE model of the user's real `myopenai` provider into a self-contained provider block
 * for an isolated arm. Only the non-secret shape is copied: the API key lives in
 * `auth.json` under `XDG_DATA_HOME`, which this runner never relocates and never writes.
 */
function myopenaiProvider(model: string, reasoningEffort: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(readFileSync(join(REAL_CONFIG_DIR, 'opencode.json'), 'utf8'))
  const providers = isRecord(raw) ? raw.provider : undefined
  const myopenai = isRecord(providers) ? providers.myopenai : undefined
  if (!isRecord(myopenai)) {
    throw new Error(`provider.myopenai not found in ${join(REAL_CONFIG_DIR, 'opencode.json')}`)
  }
  const models = isRecord(myopenai.models) ? myopenai.models : {}
  const entry = models[model]
  if (!isRecord(entry)) throw new Error(`provider.myopenai.models[${model}] not found`)

  const shape: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(myopenai)) {
    if (key !== 'models') shape[key] = value
  }
  const modelShape: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(entry)) {
    if (key !== 'options' && key !== 'variants') modelShape[key] = value
  }
  const baseOptions = isRecord(entry.options) ? entry.options : {}
  modelShape.options = { ...baseOptions, reasoningEffort }
  shape.models = { [model]: modelShape }
  return { myopenai: shape }
}

function armsFor(mode: Mode, model: string): readonly ArmSpec[] {
  if (mode === 'build') {
    return [
      { name: 'old', plugins: [OLD_PLUGIN_SPEC], model },
      { name: 'new', plugins: [LOCAL_PLUGIN_PATH], model }
    ]
  }
  const myopenaiModel = process.env.AB_MYOPENAI_MODEL ?? 'us.anthropic.claude-opus-5'
  return [
    { name: 'kiro', plugins: [LOCAL_PLUGIN_PATH], model },
    {
      name: 'myopenai',
      plugins: [],
      model: `myopenai/${myopenaiModel}`,
      provider: myopenaiProvider(myopenaiModel, 'max')
    },
    {
      name: 'myohigh',
      plugins: [],
      model: `myopenai/${myopenaiModel}`,
      provider: myopenaiProvider(myopenaiModel, 'high')
    }
  ]
}

/** One XDG_CONFIG_HOME per arm; everything except opencode.json is shared with the real config. */
function prepareArm(spec: ArmSpec): string {
  const root = join(SCRATCH, spec.name)
  const cfgDir = join(root, 'opencode')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(cfgDir, { recursive: true })

  // Only an arm that actually loads the plugin needs the plugin's own state; a
  // provider-comparison arm without it must not even see the account database.
  if (spec.plugins.length > 0) {
    for (const entry of ['kiro.db', 'kiro.db-wal', 'kiro.db-shm', 'kiro-auth-plugin']) {
      const target = join(REAL_CONFIG_DIR, entry)
      if (existsSync(target)) symlinkSync(target, join(cfgDir, entry))
    }
  }

  writeFileSync(
    join(cfgDir, 'opencode.json'),
    `${JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        plugin: [...spec.plugins],
        compaction: { auto: false, prune: false },
        ...(spec.provider ? { provider: spec.provider } : {})
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
  KIRO_ACCOUNT_SELECTION_STRATEGY: process.env.KIRO_ACCOUNT_SELECTION_STRATEGY ?? 'sticky'
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
  readonly armPlugins: readonly string[]
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
  const options = parseArgs(process.argv.slice(2))
  if (!options.dry && process.env.CONFIRM !== '1') {
    console.error(
      'Refusing to run: this makes REAL API calls. Re-run with CONFIRM=1, or --dry to ' +
        "inspect each arm's isolated config and model list for free."
    )
    process.exitCode = 1
    return
  }

  if (options.dry) {
    for (const spec of armsFor(options.mode, options.model)) {
      const root = prepareArm(spec)
      const cfg = readFileSync(join(root, 'opencode', 'opencode.json'), 'utf8')
      const models = await runOpencode(['models'], root, root)
      const visible = models.stdout.split('\n').filter((line) => line.trim().length > 0)
      const provider = spec.model.split('/')[0] ?? ''
      console.log(`\n=== arm ${spec.name} (model ${spec.model}) ===`)
      console.log(cfg.trim())
      console.log(
        `models total=${visible.length} matching '${provider}/'=` +
          visible.filter((line) => line.startsWith(`${provider}/`)).length +
          ` exactModelPresent=${visible.includes(spec.model)}`
      )
    }
    return
  }

  const fixtureDir = fixtureDirFor(options.variant)
  const prompt = readFileSync(join(fixtureDir, 'PROMPT.md'), 'utf8')
  const logsDir = join(REAL_CONFIG_DIR, 'kiro-auth-plugin', 'logs')

  mkdirSync(options.outDir, { recursive: true })
  const arms = armsFor(options.mode, options.model)
  const armRoots = new Map<Arm, string>()
  for (const spec of arms) armRoots.set(spec.name, prepareArm(spec))

  const metas: RunMeta[] = []

  const lastIndex = options.startIndex + options.runsPerArm - 1
  for (let index = options.startIndex; index <= lastIndex; index += 1) {
    for (const spec of arms) {
      const arm = spec.name
      const xdg = armRoots.get(arm)
      if (!xdg) throw new Error(`arm ${arm} was not prepared`)

      const runDir = prepareRunDir(arm, index, fixtureDir)
      const outDir = join(options.outDir, `${arm}-${String(index).padStart(2, '0')}`)
      rmSync(outDir, { recursive: true, force: true })
      mkdirSync(outDir, { recursive: true })

      const startedMs = Date.now()
      const startedAt = new Date(startedMs).toISOString()
      console.log(`[${startedAt}] arm=${arm} run=${index} model=${spec.model} ...`)

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
          spec.model,
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
        armPluginSpec: spec.plugins.join(','),
        armPlugins: spec.plugins,
        index,
        model: spec.model,
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
