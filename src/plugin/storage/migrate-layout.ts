import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync
} from 'node:fs'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'
import * as logger from '../logger.js'
import {
  getLegacyLogsDir,
  getLegacyUserConfigPath,
  getLogsDir,
  getMigrationLockPath,
  getOpencodeConfigDir,
  getPluginDir,
  getUserConfigPath
} from '../paths.js'

const MIGRATION_LOCK_OPTIONS = {
  stale: 15000,
  retries: 0,
  realpath: false
}

const MIGRATION_LOCK_ATTEMPTS = 4

function isCrossDeviceError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EXDEV'
}

function removeTemporaryFile(path: string): void {
  if (!existsSync(path)) return

  try {
    unlinkSync(path)
  } catch (error) {
    logger.warn('Storage layout migration: temporary file cleanup failed', {
      path,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

function moveFile(source: string, destination: string): void {
  try {
    renameSync(source, destination)
    return
  } catch (error) {
    if (!(error instanceof Error) || !isCrossDeviceError(error)) throw error
  }

  const temporaryDestination = `${destination}.tmp-${process.pid}`
  try {
    copyFileSync(source, temporaryDestination)
    renameSync(temporaryDestination, destination)
    unlinkSync(source)
  } catch (error) {
    removeTemporaryFile(temporaryDestination)
    throw error
  }
}

function migrateUserConfig(): boolean {
  const legacyPath = getLegacyUserConfigPath()
  const destinationPath = getUserConfigPath()
  if (!existsSync(legacyPath) || existsSync(destinationPath)) return false

  moveFile(legacyPath, destinationPath)
  return true
}

function migrateLogs(): number {
  const legacyDir = getLegacyLogsDir()
  if (!existsSync(legacyDir)) return 0

  const destinationDir = getLogsDir()
  mkdirSync(destinationDir, { recursive: true })

  let moved = 0
  for (const entry of readdirSync(legacyDir)) {
    const source = join(legacyDir, entry)
    const destination = join(destinationDir, entry)
    if (existsSync(destination)) continue

    try {
      moveFile(source, destination)
      moved++
    } catch (error) {
      logger.warn('Storage layout migration: log file move failed', {
        source,
        destination,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  if (readdirSync(legacyDir).length === 0) {
    try {
      rmdirSync(legacyDir)
    } catch (error) {
      logger.warn('Storage layout migration: legacy log directory cleanup failed', {
        path: legacyDir,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return moved
}

function removeStaleFlatLocks(): number {
  const configDir = getOpencodeConfigDir()
  let removed = 0

  for (const entry of readdirSync(configDir)) {
    const isKeepAliveLock = entry === '.kiro-keepalive.lock'
    const isRefreshLock = /^\.kiro-refresh-.*\.lock$/.test(entry)
    if (!isKeepAliveLock && !isRefreshLock) continue

    const path = join(configDir, entry)
    try {
      unlinkSync(path)
      removed++
    } catch (error) {
      logger.warn('Storage layout migration: stale lock cleanup failed', {
        path,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return removed
}

function acquireMigrationLock(path: string): (() => void) | null {
  let lastError: unknown
  for (let attempt = 0; attempt < MIGRATION_LOCK_ATTEMPTS; attempt++) {
    try {
      return lockfile.lockSync(path, MIGRATION_LOCK_OPTIONS)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }

  logger.warn('Storage layout migration: lock acquisition skipped', lastError)
  return null
}

function runMigration(): void {
  try {
    mkdirSync(getPluginDir(), { recursive: true })
  } catch (error) {
    logger.warn(
      'Storage layout migration: plugin directory creation failed',
      error instanceof Error ? error.message : String(error)
    )
    return
  }

  const migrationLockPath = getMigrationLockPath()
  try {
    closeSync(openSync(migrationLockPath, 'a'))
  } catch (error) {
    logger.warn(
      'Storage layout migration: lock file creation failed',
      error instanceof Error ? error.message : String(error)
    )
    return
  }

  const release = acquireMigrationLock(migrationLockPath)
  if (!release) return

  let configMoved = false
  let logsMoved = 0
  let locksRemoved = 0

  try {
    try {
      configMoved = migrateUserConfig()
    } catch (error) {
      logger.warn(
        'Storage layout migration: config move failed',
        error instanceof Error ? error.message : String(error)
      )
    }

    try {
      logsMoved = migrateLogs()
    } catch (error) {
      logger.warn(
        'Storage layout migration: logs migration failed',
        error instanceof Error ? error.message : String(error)
      )
    }

    try {
      locksRemoved = removeStaleFlatLocks()
    } catch (error) {
      logger.warn(
        'Storage layout migration: stale lock scan failed',
        error instanceof Error ? error.message : String(error)
      )
    }
  } finally {
    try {
      release()
    } catch (error) {
      logger.warn(
        'Storage layout migration: lock release failed',
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  logger.log('Storage layout migration complete', {
    configMoved,
    logsMoved,
    locksRemoved
  })
}

export function migrateSafeFilesIfNeeded(): void {
  try {
    runMigration()
  } catch (error) {
    logger.warn(
      'Storage layout migration failed non-fatally',
      error instanceof Error ? error.message : String(error)
    )
  }
}
