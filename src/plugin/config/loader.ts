import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as logger from '../logger'
import { getLegacyUserConfigPath, getLogsDir, getUserConfigPath } from '../paths.js'
import {
  AccountSelectionStrategySchema,
  DEFAULT_CONFIG,
  KiroConfigSchema,
  RegionSchema,
  type KiroConfig
} from './schema'

export { getUserConfigPath } from '../paths.js'

function ensureUserConfigTemplate(): void {
  const path = getUserConfigPath()
  if (!existsSync(path)) {
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8')
      logger.log(`Created default config template at ${path}`)
    } catch (error) {
      logger.warn(`Failed to create config template at ${path}: ${String(error)}`)
    }
  }
}

export function getProjectConfigPath(directory: string): string {
  return join(directory, '.opencode', 'kiro.json')
}

// Additively write any DEFAULT_CONFIG key missing from an existing user
// kiro.json so new-version keys become visible/toggleable. Additive-only,
// parse-safe, atomic, idempotent, user-config-only. See plan config-backfill.md.
function backfillUserConfig(path: string): void {
  if (!existsSync(path)) {
    return
  }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return
  }

  const obj = raw as Record<string, unknown>
  const defaultKeys = Object.keys(DEFAULT_CONFIG) as (keyof KiroConfig)[]
  const missing = defaultKeys.filter((key) => !(key in obj))
  if (missing.length === 0) {
    return
  }

  const next: Record<string, unknown> = { ...obj }
  for (const key of missing) {
    next[key] = DEFAULT_CONFIG[key]
  }

  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
    try {
      renameSync(tmp, path)
    } catch (renameError) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {}
      throw renameError
    }
    logger.log(`Backfilled ${missing.length} new config key(s) into ${path}: ${missing.join(', ')}`)
  } catch (error) {
    logger.warn(`Config backfill failed for ${path}: ${String(error)}`)
  }
}

function loadConfigFile(path: string): Partial<KiroConfig> | null {
  try {
    if (!existsSync(path)) {
      return null
    }

    const content = readFileSync(path, 'utf-8')
    const rawConfig = JSON.parse(content)

    const result = KiroConfigSchema.partial().safeParse(rawConfig)

    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')
      logger.warn(`Config validation error at ${path}: ${issues}`)
      return null
    }

    return result.data
  } catch (error) {
    if (error instanceof SyntaxError) {
      logger.warn(`Invalid JSON in config file ${path}: ${error.message}`)
    } else {
      logger.warn(`Failed to load config file ${path}: ${String(error)}`)
    }
    return null
  }
}

function mergeConfigs(base: KiroConfig, override: Partial<KiroConfig>): KiroConfig {
  return {
    ...base,
    ...override
  }
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback
  }
  if (value === '1' || value === 'true') {
    return true
  }
  if (value === '0' || value === 'false') {
    return false
  }
  return fallback
}

function parseNumberEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback
  }
  const parsed = Number(value)
  if (isNaN(parsed)) {
    return fallback
  }
  return parsed
}

function applyEnvOverrides(config: KiroConfig): KiroConfig {
  const env = process.env

  return {
    ...config,

    account_selection_strategy: env.KIRO_ACCOUNT_SELECTION_STRATEGY
      ? AccountSelectionStrategySchema.catch('lowest-usage').parse(
          env.KIRO_ACCOUNT_SELECTION_STRATEGY
        )
      : config.account_selection_strategy,

    quota_avoidance_enabled: parseBooleanEnv(
      env.KIRO_QUOTA_AVOIDANCE_ENABLED,
      config.quota_avoidance_enabled
    ),

    quota_reserve_threshold: parseNumberEnv(
      env.KIRO_QUOTA_RESERVE_THRESHOLD,
      config.quota_reserve_threshold
    ),

    default_region: env.KIRO_DEFAULT_REGION
      ? RegionSchema.catch('us-east-1').parse(env.KIRO_DEFAULT_REGION)
      : config.default_region,

    rate_limit_retry_delay_ms: parseNumberEnv(
      env.KIRO_RATE_LIMIT_RETRY_DELAY_MS,
      config.rate_limit_retry_delay_ms
    ),

    rate_limit_max_retries: parseNumberEnv(
      env.KIRO_RATE_LIMIT_MAX_RETRIES,
      config.rate_limit_max_retries
    ),

    max_request_iterations: parseNumberEnv(
      env.KIRO_MAX_REQUEST_ITERATIONS,
      config.max_request_iterations
    ),

    request_timeout_ms: parseNumberEnv(env.KIRO_REQUEST_TIMEOUT_MS, config.request_timeout_ms),

    token_expiry_buffer_ms: parseNumberEnv(
      env.KIRO_TOKEN_EXPIRY_BUFFER_MS,
      config.token_expiry_buffer_ms
    ),

    usage_sync_max_retries: parseNumberEnv(
      env.KIRO_USAGE_SYNC_MAX_RETRIES,
      config.usage_sync_max_retries
    ),

    auth_server_port_start: parseNumberEnv(
      env.KIRO_AUTH_SERVER_PORT_START,
      config.auth_server_port_start
    ),

    auth_server_port_range: parseNumberEnv(
      env.KIRO_AUTH_SERVER_PORT_RANGE,
      config.auth_server_port_range
    ),

    usage_tracking_enabled: parseBooleanEnv(
      env.KIRO_USAGE_TRACKING_ENABLED,
      config.usage_tracking_enabled
    ),

    enable_log_api_request: parseBooleanEnv(
      env.KIRO_ENABLE_LOG_API_REQUEST,
      config.enable_log_api_request
    )
  }
}

export function loadConfig(directory: string): KiroConfig {
  const userConfigPath = getUserConfigPath()
  const legacyUserConfigPath = getLegacyUserConfigPath()
  const configSourcePath =
    !existsSync(userConfigPath) && existsSync(legacyUserConfigPath)
      ? legacyUserConfigPath
      : userConfigPath

  if (configSourcePath === userConfigPath) ensureUserConfigTemplate()
  backfillUserConfig(configSourcePath)
  let config: KiroConfig = { ...DEFAULT_CONFIG }

  const userConfig = loadConfigFile(configSourcePath)
  if (userConfig) {
    config = mergeConfigs(config, userConfig)
  }

  const projectConfigPath = getProjectConfigPath(directory)
  const projectConfig = loadConfigFile(projectConfigPath)
  if (projectConfig) {
    config = mergeConfigs(config, projectConfig)
  }

  config = applyEnvOverrides(config)

  return config
}

export function configExists(path: string): boolean {
  return existsSync(path)
}

export function getDefaultLogsDir(): string {
  return getLogsDir()
}
