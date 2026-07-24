import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../plugin/config/loader.js'
import { DEFAULT_CONFIG } from '../plugin/config/schema.js'
import { getUserConfigPath } from '../plugin/paths.js'

// loadConfig reads:
//   - user config:   $XDG_CONFIG_HOME/opencode/kiro-auth-plugin/kiro.json
//   - project config: <directory>/.opencode/kiro.json
// then applies KIRO_* env overrides. We isolate BOTH by pointing
// XDG_CONFIG_HOME at a throwaway temp dir per test (getConfigDir reads the env
// at call time) and passing a throwaway project directory. No real ~/.config.

const KIRO_ENV_KEYS = [
  'KIRO_ACCOUNT_SELECTION_STRATEGY',
  'KIRO_QUOTA_AVOIDANCE_ENABLED',
  'KIRO_QUOTA_RESERVE_THRESHOLD',
  'KIRO_DEFAULT_REGION',
  'KIRO_RATE_LIMIT_RETRY_DELAY_MS',
  'KIRO_RATE_LIMIT_MAX_RETRIES',
  'KIRO_MAX_REQUEST_ITERATIONS',
  'KIRO_REQUEST_TIMEOUT_MS',
  'KIRO_SDK_RESPONSE_TIMEOUT_ENABLED',
  'KIRO_SDK_RESPONSE_TIMEOUT_MS',
  'KIRO_TOKEN_EXPIRY_BUFFER_MS',
  'KIRO_USAGE_SYNC_MAX_RETRIES',
  'KIRO_AUTH_SERVER_PORT_START',
  'KIRO_AUTH_SERVER_PORT_RANGE',
  'KIRO_USAGE_TRACKING_ENABLED',
  'KIRO_ENABLE_LOG_API_REQUEST'
]

let configHome: string
let projectDir: string
const savedXdg = process.env.XDG_CONFIG_HOME
const savedEnv: Record<string, string | undefined> = {}

function writeUserConfig(obj: unknown): void {
  const dir = join(configHome, 'opencode', 'kiro-auth-plugin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'kiro.json'), JSON.stringify(obj), 'utf-8')
}

function writeLegacyUserConfig(obj: unknown): void {
  const dir = join(configHome, 'opencode')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'kiro.json'), JSON.stringify(obj), 'utf-8')
}

function writeProjectConfig(obj: unknown): void {
  const dir = join(projectDir, '.opencode')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'kiro.json'), JSON.stringify(obj), 'utf-8')
}

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), 'kiro-cfg-home-'))
  projectDir = mkdtempSync(join(tmpdir(), 'kiro-cfg-proj-'))
  process.env.XDG_CONFIG_HOME = configHome
  for (const k of KIRO_ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = savedXdg
  for (const k of KIRO_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(configHome, { recursive: true, force: true })
  rmSync(projectDir, { recursive: true, force: true })
})

describe('loadConfig defaults', () => {
  test('returns DEFAULT_CONFIG values when no files and no env are set', () => {
    // ensureUserConfigTemplate writes DEFAULT_CONFIG to the (empty) user path,
    // so the loaded config equals the defaults.
    const cfg = loadConfig(projectDir)
    expect(cfg.account_selection_strategy).toBe('lowest-usage')
    expect(cfg.quota_avoidance_enabled).toBe(true)
    expect(cfg.quota_reserve_threshold).toBe(0.95)
    expect(cfg.default_region).toBe('us-east-1')
    expect(cfg.rate_limit_retry_delay_ms).toBe(5000)
    expect(cfg.rate_limit_max_retries).toBe(3)
    expect(cfg.max_request_iterations).toBe(20)
    expect(cfg.request_timeout_ms).toBe(120000)
    expect(cfg.sdk_response_timeout_enabled).toBe(false)
    expect(cfg.sdk_response_timeout_ms).toBe(300000)
    expect(cfg.token_expiry_buffer_ms).toBe(300000)
    expect(cfg.usage_tracking_enabled).toBe(true)
    expect(cfg.auto_sync_kiro_cli).toBe(false)
    expect(cfg.enable_log_api_request).toBe(false)
  })
})

describe('loadConfig env overrides', () => {
  test('KIRO_ACCOUNT_SELECTION_STRATEGY overrides the strategy', () => {
    process.env.KIRO_ACCOUNT_SELECTION_STRATEGY = 'round-robin'
    expect(loadConfig(projectDir).account_selection_strategy).toBe('round-robin')
  })

  test('invalid strategy env falls back to lowest-usage (schema .catch)', () => {
    process.env.KIRO_ACCOUNT_SELECTION_STRATEGY = 'garbage-strategy'
    expect(loadConfig(projectDir).account_selection_strategy).toBe('lowest-usage')
  })

  test('KIRO_DEFAULT_REGION overrides region; invalid falls back to us-east-1', () => {
    process.env.KIRO_DEFAULT_REGION = 'eu-west-1'
    expect(loadConfig(projectDir).default_region).toBe('eu-west-1')
    process.env.KIRO_DEFAULT_REGION = 'moon-base-1'
    expect(loadConfig(projectDir).default_region).toBe('us-east-1')
  })

  test('boolean env: "true"/"1" => true, "false"/"0" => false', () => {
    process.env.KIRO_QUOTA_AVOIDANCE_ENABLED = 'false'
    expect(loadConfig(projectDir).quota_avoidance_enabled).toBe(false)
    process.env.KIRO_QUOTA_AVOIDANCE_ENABLED = '0'
    expect(loadConfig(projectDir).quota_avoidance_enabled).toBe(false)
    process.env.KIRO_QUOTA_AVOIDANCE_ENABLED = '1'
    expect(loadConfig(projectDir).quota_avoidance_enabled).toBe(true)
    process.env.KIRO_QUOTA_AVOIDANCE_ENABLED = 'true'
    expect(loadConfig(projectDir).quota_avoidance_enabled).toBe(true)
  })

  test('invalid boolean env falls back to the base value (default true)', () => {
    process.env.KIRO_QUOTA_AVOIDANCE_ENABLED = 'maybe'
    expect(loadConfig(projectDir).quota_avoidance_enabled).toBe(true)
  })

  test('KIRO_SDK_RESPONSE_TIMEOUT_ENABLED opts into a finite SDK response wait', () => {
    process.env.KIRO_SDK_RESPONSE_TIMEOUT_ENABLED = 'true'
    expect(loadConfig(projectDir).sdk_response_timeout_enabled).toBe(true)
  })

  test('number env overrides parse numerically', () => {
    process.env.KIRO_QUOTA_RESERVE_THRESHOLD = '0.5'
    process.env.KIRO_RATE_LIMIT_MAX_RETRIES = '7'
    process.env.KIRO_REQUEST_TIMEOUT_MS = '90000'
    process.env.KIRO_SDK_RESPONSE_TIMEOUT_MS = '360000'
    const cfg = loadConfig(projectDir)
    expect(cfg.quota_reserve_threshold).toBe(0.5)
    expect(cfg.rate_limit_max_retries).toBe(7)
    expect(cfg.request_timeout_ms).toBe(90000)
    expect(cfg.sdk_response_timeout_ms).toBe(360000)
  })

  test('non-numeric number env falls back to the base value', () => {
    process.env.KIRO_RATE_LIMIT_MAX_RETRIES = 'not-a-number'
    // base is DEFAULT_CONFIG.rate_limit_max_retries = 3
    expect(loadConfig(projectDir).rate_limit_max_retries).toBe(3)
  })
})

describe('loadConfig file merge', () => {
  test('user kiro.json overrides defaults', () => {
    writeUserConfig({ account_selection_strategy: 'sticky', rate_limit_max_retries: 9 })
    const cfg = loadConfig(projectDir)
    expect(cfg.account_selection_strategy).toBe('sticky')
    expect(cfg.rate_limit_max_retries).toBe(9)
    // untouched keys keep defaults
    expect(cfg.default_region).toBe('us-east-1')
  })

  test('legacy flat kiro.json is used when the new config path is absent', () => {
    writeLegacyUserConfig({ account_selection_strategy: 'sticky', rate_limit_max_retries: 8 })

    const cfg = loadConfig(projectDir)

    expect(cfg.account_selection_strategy).toBe('sticky')
    expect(cfg.rate_limit_max_retries).toBe(8)
    expect(existsSync(getUserConfigPath())).toBe(false)
  })

  test('project kiro.json overrides user kiro.json', () => {
    writeUserConfig({ account_selection_strategy: 'sticky', default_region: 'us-west-2' })
    writeProjectConfig({ account_selection_strategy: 'round-robin' })
    const cfg = loadConfig(projectDir)
    // project wins for strategy
    expect(cfg.account_selection_strategy).toBe('round-robin')
    // user value survives where project did not override
    expect(cfg.default_region).toBe('us-west-2')
  })

  test('env overrides win over both file layers', () => {
    writeUserConfig({ account_selection_strategy: 'sticky' })
    writeProjectConfig({ account_selection_strategy: 'round-robin' })
    process.env.KIRO_ACCOUNT_SELECTION_STRATEGY = 'lowest-usage'
    expect(loadConfig(projectDir).account_selection_strategy).toBe('lowest-usage')
  })

  test('invalid JSON in user config is ignored, defaults preserved', () => {
    const dir = join(configHome, 'opencode', 'kiro-auth-plugin')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'kiro.json'), '{ not valid json', 'utf-8')
    const cfg = loadConfig(projectDir)
    expect(cfg.account_selection_strategy).toBe('lowest-usage')
  })

  test('schema-invalid config value is rejected, defaults preserved', () => {
    // quota_reserve_threshold must be 0..1; 5 is out of range => whole file rejected
    writeUserConfig({ quota_reserve_threshold: 5 })
    const cfg = loadConfig(projectDir)
    expect(cfg.quota_reserve_threshold).toBe(DEFAULT_CONFIG.quota_reserve_threshold)
  })
})
