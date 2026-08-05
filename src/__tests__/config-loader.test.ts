import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StreamRecoveryMode as CoordinatorStreamRecoveryMode } from '../core/request/stream-recovery.js'
import { loadConfig } from '../plugin/config/loader.js'
import { DEFAULT_CONFIG, KiroConfigSchema } from '../plugin/config/schema.js'
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
  'KIRO_STREAM_EVENT_TIMEOUT_ENABLED',
  'KIRO_STREAM_BUFFER_UNTIL_COMPLETE',
  'KIRO_COMPACTION_BUFFER_UNTIL_COMPLETE',
  'KIRO_STREAM_MAX_ATTEMPTS',
  'KIRO_STREAM_RECOVERY_MODE',
  'KIRO_STREAM_RECOVERY_REUSE_CONVERSATION_ID_ACROSS_ACCOUNTS',
  'KIRO_SDK_RESPONSE_TIMEOUT_ENABLED',
  'KIRO_SDK_RESPONSE_TIMEOUT_MS',
  'KIRO_SDK_HTTP_KEEP_ALIVE',
  'KIRO_TOKEN_EXPIRY_BUFFER_MS',
  'KIRO_USAGE_SYNC_MAX_RETRIES',
  'KIRO_AUTH_SERVER_PORT_START',
  'KIRO_AUTH_SERVER_PORT_RANGE',
  'KIRO_USAGE_TRACKING_ENABLED',
  'KIRO_ENABLE_LOG_API_REQUEST',
  'KIRO_DIAGNOSTIC_LOG_LEVEL',
  'KIRO_LOG_RETENTION_DAYS',
  'KIRO_LOG_MAX_TOTAL_SIZE_MB',
  'KIRO_LOG_COMPRESS_AFTER_DAYS',
  'KIRO_LOG_SEGMENT_SIZE_MB'
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
    expect(cfg.stream_event_timeout_enabled).toBe(false)
    expect(cfg.stream_buffer_until_complete).toBe(false)
    expect(cfg.compaction_buffer_until_complete).toBe(true)
    expect(cfg.stream_max_attempts).toBe(3)
    expect(cfg.stream_recovery_mode).toBe('off')
    expect(cfg.stream_recovery_reuse_conversation_id_across_accounts).toBe(false)
    expect(cfg.sdk_response_timeout_enabled).toBe(false)
    expect(cfg.sdk_response_timeout_ms).toBe(300000)
    expect(cfg.sdk_http_keep_alive).toBe(false)
    expect(cfg.token_expiry_buffer_ms).toBe(300000)
    expect(cfg.usage_tracking_enabled).toBe(true)
    expect(cfg.auto_sync_kiro_cli).toBe(false)
    expect(cfg.enable_log_api_request).toBe(false)
    expect(cfg.diagnostic_log_level).toBe('off')
    expect(cfg.log_retention_days).toBe(7)
    expect(cfg.log_max_total_size_mb).toBe(512)
    expect(cfg.log_compress_after_days).toBe(1)
    expect(cfg.log_segment_size_mb).toBe(16)
  })

  test('the zod defaults and DEFAULT_CONFIG agree on recovery behavior', () => {
    // loadConfig only ever runs KiroConfigSchema.partial(), which strips zod
    // defaults, so DEFAULT_CONFIG is the operative default and the two sources
    // can drift apart silently.
    expect(KiroConfigSchema.parse({}).stream_recovery_mode).toBe('off')
    expect(DEFAULT_CONFIG.stream_recovery_mode).toBe('off')
    expect(KiroConfigSchema.parse({}).compaction_buffer_until_complete).toBe(true)
    expect(DEFAULT_CONFIG.compaction_buffer_until_complete).toBe(true)
    expect(KiroConfigSchema.parse({}).stream_recovery_reuse_conversation_id_across_accounts).toBe(
      false
    )
    expect(DEFAULT_CONFIG.stream_recovery_reuse_conversation_id_across_accounts).toBe(false)
    expect(KiroConfigSchema.parse({}).diagnostic_log_level).toBe('off')
    expect(DEFAULT_CONFIG.diagnostic_log_level).toBe('off')
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

  test('KIRO_STREAM_EVENT_TIMEOUT_ENABLED opts into a finite stream inactivity wait', () => {
    process.env.KIRO_STREAM_EVENT_TIMEOUT_ENABLED = 'true'
    expect(loadConfig(projectDir).stream_event_timeout_enabled).toBe(true)
  })

  test('KIRO_SDK_HTTP_KEEP_ALIVE opts into cross-request socket reuse', () => {
    process.env.KIRO_SDK_HTTP_KEEP_ALIVE = 'true'
    expect(loadConfig(projectDir).sdk_http_keep_alive).toBe(true)
  })

  test('KIRO_STREAM_BUFFER_UNTIL_COMPLETE opts into replay-safe stream delivery', () => {
    process.env.KIRO_STREAM_BUFFER_UNTIL_COMPLETE = 'true'
    expect(loadConfig(projectDir).stream_buffer_until_complete).toBe(true)
  })

  test('KIRO_COMPACTION_BUFFER_UNTIL_COMPLETE can disable atomic compaction buffering', () => {
    process.env.KIRO_COMPACTION_BUFFER_UNTIL_COMPLETE = 'false'
    expect(loadConfig(projectDir).compaction_buffer_until_complete).toBe(false)
  })

  test('cross-account conversation ID reuse requires an explicit env opt-in', () => {
    process.env.KIRO_STREAM_RECOVERY_REUSE_CONVERSATION_ID_ACROSS_ACCOUNTS = 'true'
    expect(loadConfig(projectDir).stream_recovery_reuse_conversation_id_across_accounts).toBe(true)
  })

  test('KIRO_STREAM_RECOVERY_MODE selects a recovery strategy', () => {
    process.env.KIRO_STREAM_RECOVERY_MODE = 'reasoning_restart'
    expect(loadConfig(projectDir).stream_recovery_mode).toBe('reasoning_restart')
  })

  test('KIRO_STREAM_RECOVERY_MODE accepts the exact replay strategy', () => {
    process.env.KIRO_STREAM_RECOVERY_MODE = 'exact_replay'
    expect(loadConfig(projectDir).stream_recovery_mode).toBe('exact_replay')
  })

  test('invalid recovery mode env falls back to off (schema .catch)', () => {
    process.env.KIRO_STREAM_RECOVERY_MODE = 'hybrid_experimental'
    expect(loadConfig(projectDir).stream_recovery_mode).toBe('off')
  })

  test('KIRO_DIAGNOSTIC_LOG_LEVEL selects privacy-safe request diagnostics', () => {
    process.env.KIRO_DIAGNOSTIC_LOG_LEVEL = 'verbose'
    expect(loadConfig(projectDir).diagnostic_log_level).toBe('verbose')
  })

  test('invalid diagnostic log level env falls back to off', () => {
    process.env.KIRO_DIAGNOSTIC_LOG_LEVEL = 'full-prompt'
    expect(loadConfig(projectDir).diagnostic_log_level).toBe('off')
  })

  test('number env overrides parse numerically', () => {
    process.env.KIRO_QUOTA_RESERVE_THRESHOLD = '0.5'
    process.env.KIRO_RATE_LIMIT_MAX_RETRIES = '7'
    process.env.KIRO_REQUEST_TIMEOUT_MS = '90000'
    process.env.KIRO_STREAM_MAX_ATTEMPTS = '5'
    process.env.KIRO_SDK_RESPONSE_TIMEOUT_MS = '360000'
    process.env.KIRO_LOG_RETENTION_DAYS = '14'
    process.env.KIRO_LOG_MAX_TOTAL_SIZE_MB = '1024'
    process.env.KIRO_LOG_COMPRESS_AFTER_DAYS = '2'
    process.env.KIRO_LOG_SEGMENT_SIZE_MB = '32'
    const cfg = loadConfig(projectDir)
    expect(cfg.quota_reserve_threshold).toBe(0.5)
    expect(cfg.rate_limit_max_retries).toBe(7)
    expect(cfg.request_timeout_ms).toBe(90000)
    expect(cfg.stream_max_attempts).toBe(5)
    expect(cfg.sdk_response_timeout_ms).toBe(360000)
    expect(cfg.log_retention_days).toBe(14)
    expect(cfg.log_max_total_size_mb).toBe(1024)
    expect(cfg.log_compress_after_days).toBe(2)
    expect(cfg.log_segment_size_mb).toBe(32)
  })

  test('non-numeric number env falls back to the base value', () => {
    process.env.KIRO_RATE_LIMIT_MAX_RETRIES = 'not-a-number'
    // base is DEFAULT_CONFIG.rate_limit_max_retries = 3
    expect(loadConfig(projectDir).rate_limit_max_retries).toBe(3)
  })

  test('out-of-range log env values fall back to safe defaults', () => {
    process.env.KIRO_LOG_RETENTION_DAYS = '0'
    process.env.KIRO_LOG_MAX_TOTAL_SIZE_MB = '-1'
    process.env.KIRO_LOG_COMPRESS_AFTER_DAYS = '1.5'
    process.env.KIRO_LOG_SEGMENT_SIZE_MB = '999'
    const cfg = loadConfig(projectDir)
    expect(cfg.log_retention_days).toBe(7)
    expect(cfg.log_max_total_size_mb).toBe(512)
    expect(cfg.log_compress_after_days).toBe(1)
    expect(cfg.log_segment_size_mb).toBe(16)
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

  test('user file overrides the recovery mode; an out-of-enum value is rejected', () => {
    writeUserConfig({ stream_recovery_mode: 'reasoning_restart' })
    expect(loadConfig(projectDir).stream_recovery_mode).toBe('reasoning_restart')

    writeUserConfig({ stream_recovery_mode: 'hybrid_experimental' })
    expect(loadConfig(projectDir).stream_recovery_mode).toBe('off')
  })

  test('user file accepts the exact replay recovery mode', () => {
    writeUserConfig({ stream_recovery_mode: 'exact_replay' })
    expect(loadConfig(projectDir).stream_recovery_mode).toBe('exact_replay')
  })

  test('user file accepts the basic diagnostic level and rejects unknown levels', () => {
    writeUserConfig({ diagnostic_log_level: 'basic' })
    expect(loadConfig(projectDir).diagnostic_log_level).toBe('basic')

    writeUserConfig({ diagnostic_log_level: 'unsafe' })
    expect(loadConfig(projectDir).diagnostic_log_level).toBe('off')
  })

  test('the config literal union stays assignable to the coordinator mode', () => {
    const forCoordinator: CoordinatorStreamRecoveryMode =
      loadConfig(projectDir).stream_recovery_mode
    expect(forCoordinator).toBe('off')
  })
})
