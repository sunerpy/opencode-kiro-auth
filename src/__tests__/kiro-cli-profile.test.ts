import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import Database from 'libsql'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readActiveProfileArnFromKiroCli } from '../plugin/sync/kiro-cli-profile.js'

// readActiveProfileArnFromKiroCli reads the external kiro-cli data.sqlite3.
// getCliDbPath honors the KIROCLI_DB_PATH env override, so we point it at a
// throwaway libsql file shaped like a real kiro-cli DB. No network, no real
// credentials, no touching the developer's real kiro-cli DB.

let tempDir: string
let dbPath: string
const savedEnv = process.env.KIROCLI_DB_PATH

function seedDb(profileValue: string | null): void {
  const db = new Database(dbPath)
  db.exec('CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)')
  if (profileValue !== null) {
    db.prepare('INSERT INTO state (key, value) VALUES (?, ?)').run(
      'api.codewhisperer.profile',
      profileValue
    )
  }
  db.close()
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'kiro-cli-profile-'))
  dbPath = join(tempDir, 'data.sqlite3')
  process.env.KIROCLI_DB_PATH = dbPath
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env.KIROCLI_DB_PATH
  else process.env.KIROCLI_DB_PATH = savedEnv
  rmSync(tempDir, { recursive: true, force: true })
})

describe('readActiveProfileArnFromKiroCli', () => {
  test('returns undefined when the DB file does not exist', () => {
    process.env.KIROCLI_DB_PATH = join(tempDir, 'nonexistent.sqlite3')
    expect(readActiveProfileArnFromKiroCli()).toBeUndefined()
  })

  test('reads the arn field from the profile JSON', () => {
    seedDb(JSON.stringify({ arn: 'arn:aws:codewhisperer:us-east-1:123:profile/A' }))
    expect(readActiveProfileArnFromKiroCli()).toBe('arn:aws:codewhisperer:us-east-1:123:profile/A')
  })

  test('falls back to profileArn field when arn is absent', () => {
    seedDb(JSON.stringify({ profileArn: 'arn:aws:codewhisperer:us-west-2:456:profile/B' }))
    expect(readActiveProfileArnFromKiroCli()).toBe('arn:aws:codewhisperer:us-west-2:456:profile/B')
  })

  test('falls back to profile_arn (snake_case) field last', () => {
    seedDb(JSON.stringify({ profile_arn: 'arn:aws:codewhisperer:eu-west-1:789:profile/C' }))
    expect(readActiveProfileArnFromKiroCli()).toBe('arn:aws:codewhisperer:eu-west-1:789:profile/C')
  })

  test('trims surrounding whitespace on the arn', () => {
    seedDb(JSON.stringify({ arn: '  arn:aws:codewhisperer:us-east-1:1:profile/T  ' }))
    expect(readActiveProfileArnFromKiroCli()).toBe('arn:aws:codewhisperer:us-east-1:1:profile/T')
  })

  test('returns undefined when arn is an empty/whitespace string', () => {
    seedDb(JSON.stringify({ arn: '   ' }))
    expect(readActiveProfileArnFromKiroCli()).toBeUndefined()
  })

  test('returns undefined when the profile row is missing', () => {
    seedDb(null)
    expect(readActiveProfileArnFromKiroCli()).toBeUndefined()
  })

  test('returns undefined when the profile value is not valid JSON', () => {
    seedDb('not-json{{{')
    expect(readActiveProfileArnFromKiroCli()).toBeUndefined()
  })

  test('returns undefined when arn is a non-string type', () => {
    seedDb(JSON.stringify({ arn: 12345 }))
    expect(readActiveProfileArnFromKiroCli()).toBeUndefined()
  })

  test('prefers arn over profileArn/profile_arn when multiple present', () => {
    seedDb(
      JSON.stringify({
        arn: 'arn:winner',
        profileArn: 'arn:loser1',
        profile_arn: 'arn:loser2'
      })
    )
    expect(readActiveProfileArnFromKiroCli()).toBe('arn:winner')
  })
})
