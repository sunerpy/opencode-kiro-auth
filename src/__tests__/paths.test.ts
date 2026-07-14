import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getKeepAliveLockPath,
  getLegacyLogsDir,
  getLegacyUserConfigPath,
  getLogsDir,
  getMigrationLockPath,
  getOpencodeConfigDir,
  getPluginDir,
  getRefreshLockPath,
  getUserConfigPath
} from '../plugin/paths.js'

const originalPlatform = process.platform
const originalAppData = process.env.APPDATA
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

let configHome: string

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), 'kiro-paths-'))
  setPlatform('linux')
  process.env.XDG_CONFIG_HOME = configHome
  delete process.env.APPDATA
})

afterEach(() => {
  setPlatform(originalPlatform)
  if (originalAppData === undefined) delete process.env.APPDATA
  else process.env.APPDATA = originalAppData
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome
  rmSync(configHome, { recursive: true, force: true })
})

describe('plugin storage paths', () => {
  test('uses the XDG opencode root and dedicated plugin directory on non-Windows platforms', () => {
    // Given: XDG_CONFIG_HOME points to an isolated non-Windows config root.
    const opencodeDir = join(configHome, 'opencode')
    const pluginDir = join(opencodeDir, 'kiro-auth-plugin')

    // When: every path getter resolves its location.
    const paths = {
      opencode: getOpencodeConfigDir(),
      plugin: getPluginDir(),
      config: getUserConfigPath(),
      logs: getLogsDir(),
      refreshLock: getRefreshLockPath('account:unsafe/value'),
      keepAliveLock: getKeepAliveLockPath()
    }

    // Then: moved files live below the plugin directory and the id is sanitized.
    expect(paths).toEqual({
      opencode: opencodeDir,
      plugin: pluginDir,
      config: join(pluginDir, 'kiro.json'),
      logs: join(pluginDir, 'logs'),
      refreshLock: join(pluginDir, '.kiro-refresh-accountunsafevalue.lock'),
      keepAliveLock: join(pluginDir, '.kiro-keepalive.lock')
    })
  })

  test('keeps legacy sources and the migration lock directly under the opencode root', () => {
    // Given: the legacy layout is rooted at the XDG opencode directory.
    const opencodeDir = join(configHome, 'opencode')

    // When: legacy and migration paths are resolved.
    const paths = {
      config: getLegacyUserConfigPath(),
      logs: getLegacyLogsDir(),
      migrationLock: getMigrationLockPath()
    }

    // Then: none of them is nested under kiro-auth-plugin.
    expect(paths).toEqual({
      config: join(opencodeDir, 'kiro.json'),
      logs: join(opencodeDir, 'kiro-logs'),
      migrationLock: join(opencodeDir, '.kiro-auth-migration.lock')
    })
  })

  test('uses APPDATA for the Windows opencode root', () => {
    // Given: the process reports Windows and APPDATA is set.
    setPlatform('win32')
    process.env.APPDATA = join(configHome, 'Roaming')

    // When: the root and plugin paths are resolved.
    const opencodeDir = getOpencodeConfigDir()

    // Then: APPDATA wins and the plugin directory remains nested below opencode.
    expect(opencodeDir).toBe(join(configHome, 'Roaming', 'opencode'))
    expect(getPluginDir()).toBe(join(opencodeDir, 'kiro-auth-plugin'))
  })
})
