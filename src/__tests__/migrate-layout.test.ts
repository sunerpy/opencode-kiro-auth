import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as logger from '../plugin/logger.js'
import {
  getLegacyLogsDir,
  getLegacyUserConfigPath,
  getLogsDir,
  getMigrationLockPath,
  getOpencodeConfigDir,
  getPluginDir,
  getUserConfigPath
} from '../plugin/paths.js'
import { migrateSafeFilesIfNeeded } from '../plugin/storage/migrate-layout.js'

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

let configHome: string
const spies: Array<{ mockRestore: () => void }> = []

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf-8')
}

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), 'kiro-layout-'))
  process.env.XDG_CONFIG_HOME = configHome
})

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome
  rmSync(configHome, { recursive: true, force: true })
})

describe('migrateSafeFilesIfNeeded', () => {
  test('moves a legacy kiro.json when the new config is absent', () => {
    // Given: only the flat legacy config exists.
    write(getLegacyUserConfigPath(), '{"account_selection_strategy":"sticky"}')

    // When: the storage layout migration runs.
    migrateSafeFilesIfNeeded()

    // Then: the config is moved byte-for-byte into the plugin directory.
    expect(existsSync(getLegacyUserConfigPath())).toBe(false)
    expect(readFileSync(getUserConfigPath(), 'utf-8')).toBe(
      '{"account_selection_strategy":"sticky"}'
    )
  })

  test('leaves both config files untouched when legacy and new paths both exist', () => {
    // Given: both layouts contain independently-authored config files.
    write(getLegacyUserConfigPath(), 'legacy-config')
    write(getUserConfigPath(), 'new-config')

    // When: migration evaluates the config step.
    migrateSafeFilesIfNeeded()

    // Then: neither file is overwritten or deleted.
    expect(readFileSync(getLegacyUserConfigPath(), 'utf-8')).toBe('legacy-config')
    expect(readFileSync(getUserConfigPath(), 'utf-8')).toBe('new-config')
  })

  test('merges legacy logs without overwriting same-named destination files', () => {
    // Given: one unique legacy log and one collision with an existing destination log.
    write(join(getLegacyLogsDir(), 'legacy-only.log'), 'legacy-only')
    write(join(getLegacyLogsDir(), 'collision.log'), 'legacy-collision')
    write(join(getLogsDir(), 'collision.log'), 'destination-wins')

    // When: migration merges the legacy log directory.
    migrateSafeFilesIfNeeded()

    // Then: the unique file moves and the collision remains untouched at both paths.
    expect(readFileSync(join(getLogsDir(), 'legacy-only.log'), 'utf-8')).toBe('legacy-only')
    expect(readFileSync(join(getLogsDir(), 'collision.log'), 'utf-8')).toBe('destination-wins')
    expect(readFileSync(join(getLegacyLogsDir(), 'collision.log'), 'utf-8')).toBe(
      'legacy-collision'
    )
  })

  test('deletes only stale flat plugin locks and leaves database and unrelated files untouched', () => {
    // Given: stale plugin locks share the root with database and unrelated protected files.
    const root = getOpencodeConfigDir()
    const protectedFiles = new Map([
      ['kiro.db', 'database'],
      ['kiro.db-wal', 'wal'],
      ['kiro.db-shm', 'shm'],
      ['kiro.json.bak-20260714', 'backup'],
      ['bun.lock', 'bun-lock']
    ])
    for (const [name, content] of protectedFiles) write(join(root, name), content)
    write(join(root, '.kiro-keepalive.lock'), 'keepalive')
    write(join(root, '.kiro-refresh-account-a.lock'), 'refresh-a')
    write(join(root, '.kiro-refresh-account-b.lock'), 'refresh-b')

    // When: stale flat locks are cleaned up.
    migrateSafeFilesIfNeeded()

    // Then: only the regenerable plugin locks are removed.
    expect(existsSync(join(root, '.kiro-keepalive.lock'))).toBe(false)
    expect(existsSync(join(root, '.kiro-refresh-account-a.lock'))).toBe(false)
    expect(existsSync(join(root, '.kiro-refresh-account-b.lock'))).toBe(false)
    for (const [name, content] of protectedFiles) {
      expect(readFileSync(join(root, name), 'utf-8')).toBe(content)
    }
  })

  test('is idempotent and releases the cross-process migration lock', () => {
    // Given: a legacy config and log are ready for the first migration.
    write(getLegacyUserConfigPath(), 'config-once')
    write(join(getLegacyLogsDir(), 'once.log'), 'log-once')

    // When: migration runs once and the moved files' identities are captured.
    expect(() => migrateSafeFilesIfNeeded()).not.toThrow()
    const configPath = getUserConfigPath()
    const logPath = join(getLogsDir(), 'once.log')
    const configAfterFirstRun = statSync(configPath)
    const logAfterFirstRun = statSync(logPath)

    // When: migration runs a second time in the same process.
    expect(() => migrateSafeFilesIfNeeded()).not.toThrow()
    const configAfterSecondRun = statSync(configPath)
    const logAfterSecondRun = statSync(logPath)

    // Then: content, timestamps, and inode identities prove the second run did not rewrite files.
    expect(readFileSync(configPath, 'utf-8')).toBe('config-once')
    expect(readFileSync(logPath, 'utf-8')).toBe('log-once')
    expect(configAfterSecondRun.mtimeMs).toBe(configAfterFirstRun.mtimeMs)
    expect(configAfterSecondRun.ino).toBe(configAfterFirstRun.ino)
    expect(logAfterSecondRun.mtimeMs).toBe(logAfterFirstRun.mtimeMs)
    expect(logAfterSecondRun.ino).toBe(logAfterFirstRun.ino)
    expect(existsSync(getMigrationLockPath())).toBe(true)
    expect(existsSync(`${getMigrationLockPath()}.lock`)).toBe(false)
  })

  test('returns normally and continues cleanup when a migration target cannot be created', () => {
    // Given: the logs destination is a regular file, so it cannot become a directory.
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    spies.push(warn)
    mkdirSync(getPluginDir(), { recursive: true })
    writeFileSync(getLogsDir(), 'not-a-directory', 'utf-8')
    write(join(getLegacyLogsDir(), 'blocked.log'), 'blocked')
    const staleLock = join(getOpencodeConfigDir(), '.kiro-keepalive.lock')
    write(staleLock, 'stale')

    // When: the logs step fails inside the non-fatal migration boundary.
    const run = () => migrateSafeFilesIfNeeded()

    // Then: startup would continue and the independent stale-lock cleanup still runs.
    expect(run).not.toThrow()
    expect(warn).toHaveBeenCalled()
    expect(readFileSync(join(getLegacyLogsDir(), 'blocked.log'), 'utf-8')).toBe('blocked')
    expect(existsSync(staleLock)).toBe(false)
  })
})
