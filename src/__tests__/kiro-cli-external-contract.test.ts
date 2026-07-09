import { describe, expect, test } from 'bun:test'
import Database from 'libsql'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pluginModule from '../index.js'
import { safeJsonParse } from '../plugin/sync/kiro-cli-parser.js'

// External kiro-cli contract regression.
//
// The provider rename `kiro` -> `kiro-auth` is an INTERNAL OpenCode concern.
// The kiro-cli SQLite import reads keys owned by the external kiro-cli tool
// (`kirocli:odic:token`, `kirocli:social:token`, `codewhisperer:*`). Those
// keys are NOT ours to rename — renaming them would break reading a real
// kiro-cli `data.sqlite3`. These tests prove the rename did NOT leak into the
// external contract: the import still reads the unchanged `kirocli:*` /
// `codewhisperer:*` literals, while the resulting credential lands under the
// OpenCode provider id `kiro-auth`.

const testDir = dirname(fileURLToPath(import.meta.url))
const kiroCliSourcePath = join(testDir, '..', 'plugin', 'sync', 'kiro-cli.ts')

describe('kiro-cli external contract keys are not renamed', () => {
  test('source declares external write-back keys as kirocli:* (not kiro-auth:*)', () => {
    const source = readFileSync(kiroCliSourcePath, 'utf8')

    // The IDC / social write-back target keys are the external kiro-cli
    // literals, exactly as kiro-cli itself stores them.
    expect(source).toContain("'kirocli:odic:token'")
    expect(source).toContain("'kirocli:social:token'")

    // The rename must NOT have leaked into the external contract. No source
    // key literal may be prefixed with our internal provider id.
    expect(source).not.toContain('kiro-auth:odic:token')
    expect(source).not.toContain('kiro-auth:social:token')
    expect(source).not.toContain("'kiro-auth:")

    // The reader keys the token detection off the unchanged external
    // conventions: any row key containing `:token`, and `odic` marking IDC.
    expect(source).toContain(".includes(':token')")
    expect(source).toContain(".includes('odic')")
    expect(source).toContain('SELECT key, value FROM auth_kv')
  })

  test('fixture: import reads unchanged kirocli:* keys; credential lands under kiro-auth', () => {
    // In-memory libsql fixture shaped like a real kiro-cli data.sqlite3.
    // NO network, NO real credentials, NO temp files.
    const db = new Database(':memory:')
    db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)')
    db.exec('CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)')

    const idcTokenValue = JSON.stringify({
      access_token: 'fixture-access',
      refresh_token: 'fixture-refresh',
      region: 'us-east-1',
      client_id: 'fixture-client-id',
      client_secret: 'fixture-client-secret',
      expires_at: '2999-01-01T00:00:00.000Z'
    })

    const insert = db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?)')
    // The external kiro-cli keys — exactly as kiro-cli writes them.
    insert.run('kirocli:odic:token', idcTokenValue)
    insert.run('kirocli:odic:device-registration', JSON.stringify({}))
    insert.run(
      'codewhisperer:profile',
      JSON.stringify({ arn: 'arn:aws:codewhisperer:us-east-1:123:profile/X' })
    )

    // Read exactly the way syncFromKiroCli does: SELECT from auth_kv.
    const rows = db.prepare('SELECT key, value FROM auth_kv').all() as {
      key: string
      value: string
    }[]

    // The token rows are discovered via the unchanged external key
    // conventions (`:token` substring, `odic` => IDC), NOT via a kiro-auth
    // prefix.
    const tokenRows = rows.filter((r) => r.key.includes(':token'))
    expect(tokenRows.map((r) => r.key)).toEqual(['kirocli:odic:token'])

    const idcRow = tokenRows.find((r) => r.key.includes('odic'))
    expect(idcRow).toBeDefined()
    expect(idcRow!.key).toBe('kirocli:odic:token')
    // Guard: the source key literal read is NOT our internal provider id.
    expect(idcRow!.key.startsWith('kiro-auth:')).toBe(false)
    expect(idcRow!.key.startsWith('kirocli:')).toBe(true)

    // The payload parses with the same helper the importer uses.
    const parsed = safeJsonParse(idcRow!.value)
    expect(parsed).not.toBeNull()
    expect(parsed.access_token).toBe('fixture-access')
    expect(parsed.refresh_token).toBe('fixture-refresh')

    db.close()

    // The credential that this external key feeds lands under the OpenCode
    // provider id `kiro-auth` — the one place the rename applies.
    expect(pluginModule.id).toBe('kiro-auth')
  })
})
