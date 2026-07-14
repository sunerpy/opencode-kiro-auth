import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../plugin/config/loader.js'
import { DEFAULT_CONFIG } from '../plugin/config/schema.js'

// Backfill mutates the REAL user kiro.json under the kiro-auth-plugin directory.
// setup.ts already points XDG_CONFIG_HOME at a temp dir, but each test overrides
// it with its own throwaway dir so writes are fully isolated and asserted.

let configHome: string
let projectDir: string
const savedXdg = process.env.XDG_CONFIG_HOME

function userConfigPath(): string {
  return join(configHome, 'opencode', 'kiro-auth-plugin', 'kiro.json')
}

function writeUserConfigRaw(text: string): void {
  const dir = join(configHome, 'opencode', 'kiro-auth-plugin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'kiro.json'), text, 'utf-8')
}

function readUser(): string {
  return readFileSync(userConfigPath(), 'utf-8')
}

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), 'kiro-backfill-home-'))
  projectDir = mkdtempSync(join(tmpdir(), 'kiro-backfill-proj-'))
  process.env.XDG_CONFIG_HOME = configHome
})

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = savedXdg
  rmSync(configHome, { recursive: true, force: true })
  rmSync(projectDir, { recursive: true, force: true })
})

describe('config backfill: additive new-key insertion', () => {
  test('appends missing DEFAULT_CONFIG keys to an existing file, preserving existing values', () => {
    writeUserConfigRaw(
      JSON.stringify({ account_selection_strategy: 'sticky', request_timeout_ms: 90000 })
    )

    loadConfig(projectDir)

    const written = JSON.parse(readUser())
    // existing values untouched
    expect(written.account_selection_strategy).toBe('sticky')
    expect(written.request_timeout_ms).toBe(90000)
    // newly-added default keys present with their default values
    expect(written.token_keepalive_enabled).toBe(false)
    expect(written.token_keepalive_interval_ms).toBe(600000)
    expect(written.auto_sync_kiro_cli).toBe(false)
    // every DEFAULT_CONFIG key is now present
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      expect(key in written).toBe(true)
    }
  })

  test('preserves existing key order and appends new keys after them', () => {
    writeUserConfigRaw(
      JSON.stringify({ default_region: 'us-west-2', usage_tracking_enabled: true })
    )

    loadConfig(projectDir)

    const keys = Object.keys(JSON.parse(readUser()))
    expect(keys[0]).toBe('default_region')
    expect(keys[1]).toBe('usage_tracking_enabled')
    // appended keys come after the user's originals
    expect(keys.indexOf('token_keepalive_enabled')).toBeGreaterThan(1)
  })
})

describe('config backfill: value-preservation guarantees', () => {
  test('never flips an explicit false to the default', () => {
    // token_keepalive_enabled default is false; set it TRUE explicitly and ensure
    // backfill does not touch it. auto_sync default is false; set TRUE explicitly.
    writeUserConfigRaw(JSON.stringify({ token_keepalive_enabled: true, auto_sync_kiro_cli: true }))

    loadConfig(projectDir)

    const written = JSON.parse(readUser())
    expect(written.token_keepalive_enabled).toBe(true)
    expect(written.auto_sync_kiro_cli).toBe(true)
  })

  test('preserves unknown/custom keys not in the schema', () => {
    writeUserConfigRaw(
      JSON.stringify({ my_custom_key: 'keep-me', account_selection_strategy: 'round-robin' })
    )

    loadConfig(projectDir)

    const written = JSON.parse(readUser())
    expect(written.my_custom_key).toBe('keep-me')
    expect(written.account_selection_strategy).toBe('round-robin')
  })

  test('does NOT add optional (non-default) keys like $schema / idc_* / effort', () => {
    writeUserConfigRaw(JSON.stringify({ account_selection_strategy: 'sticky' }))

    loadConfig(projectDir)

    const written = JSON.parse(readUser())
    expect('$schema' in written).toBe(false)
    expect('idc_start_url' in written).toBe(false)
    expect('idc_region' in written).toBe(false)
    expect('idc_profile_arn' in written).toBe(false)
    expect('effort' in written).toBe(false)
  })
})

describe('config backfill: idempotency and no-churn', () => {
  test('does NOT rewrite a file that already has every default key', () => {
    // Seed a complete file (all default keys).
    writeUserConfigRaw(`${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`)
    const before = statSync(userConfigPath()).mtimeMs
    const beforeText = readUser()

    loadConfig(projectDir)

    expect(readUser()).toBe(beforeText)
    expect(statSync(userConfigPath()).mtimeMs).toBe(before)
  })

  test('a second load after backfill is a no-op', () => {
    writeUserConfigRaw(JSON.stringify({ account_selection_strategy: 'sticky' }))
    loadConfig(projectDir)
    const afterFirst = readUser()
    const mtimeAfterFirst = statSync(userConfigPath()).mtimeMs

    loadConfig(projectDir)

    expect(readUser()).toBe(afterFirst)
    expect(statSync(userConfigPath()).mtimeMs).toBe(mtimeAfterFirst)
  })
})

describe('config backfill: parse-safety', () => {
  test('leaves an invalid-JSON file byte-for-byte untouched', () => {
    const bad = '{ not valid json'
    writeUserConfigRaw(bad)

    const cfg = loadConfig(projectDir)

    expect(readUser()).toBe(bad)
    // loadConfig still returns defaults despite the unreadable file
    expect(cfg.account_selection_strategy).toBe('lowest-usage')
  })

  test('leaves a non-object JSON (array) untouched', () => {
    const arr = '[1,2,3]'
    writeUserConfigRaw(arr)

    loadConfig(projectDir)

    expect(readUser()).toBe(arr)
  })
})

describe('config backfill: scope and creation', () => {
  test('does not backfill the project config, only the user config', () => {
    // user file complete so backfill is a no-op there; project file partial.
    writeUserConfigRaw(`${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`)
    const projOpencode = join(projectDir, '.opencode')
    mkdirSync(projOpencode, { recursive: true })
    const projPath = join(projOpencode, 'kiro.json')
    const projText = JSON.stringify({ account_selection_strategy: 'round-robin' })
    writeFileSync(projPath, projText, 'utf-8')

    loadConfig(projectDir)

    // project config left exactly as authored (no backfill)
    expect(readFileSync(projPath, 'utf-8')).toBe(projText)
  })

  test('an absent user file is created by the template with all keys (backfill no-op)', () => {
    // no user file written; loadConfig -> ensureUserConfigTemplate creates it.
    loadConfig(projectDir)

    const written = JSON.parse(readUser())
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      expect(key in written).toBe(true)
    }
  })

  test('does not leave a stale .tmp file after a successful backfill', () => {
    writeUserConfigRaw(JSON.stringify({ account_selection_strategy: 'sticky' }))

    loadConfig(projectDir)

    const leftovers = readdirTmp()
    expect(leftovers.length).toBe(0)
  })
})

function readdirTmp(): string[] {
  const dir = join(configHome, 'opencode', 'kiro-auth-plugin')
  return readdirSync(dir).filter((f: string) => f.startsWith('kiro.json.tmp-'))
}
