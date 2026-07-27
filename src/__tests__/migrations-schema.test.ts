import { describe, expect, spyOn, test } from 'bun:test'
import Database from 'libsql'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMigrations } from '../plugin/storage/migrations.js'
import { KiroDatabase } from '../plugin/storage/sqlite.js'

const REFRESH_TOKEN_DEDUP_MARKER = 'refresh_token_dedup_migration_version'

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'kiro-mig-')), 'kiro.db')
}

function tempDb(): Database.Database {
  return new Database(tempDbPath())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringColumn(row: unknown, name: string): string {
  if (!isRecord(row) || typeof row[name] !== 'string') {
    throw new TypeError(`Expected ${name} to be a string`)
  }
  return row[name]
}

function numberColumn(row: unknown, name: string): number {
  if (!isRecord(row) || typeof row[name] !== 'number') {
    throw new TypeError(`Expected ${name} to be a number`)
  }
  return row[name]
}

function dataVersion(db: Database.Database): number {
  const row = db.prepare('PRAGMA data_version').get()
  return numberColumn(row, 'data_version')
}

function countBeginImmediateDuring(action: () => void): number {
  const originalExec = Database.prototype.exec
  let count = 0
  const execSpy = spyOn(Database.prototype, 'exec').mockImplementation(function (
    this: Database.Database,
    sql: string
  ) {
    if (/^\s*BEGIN IMMEDIATE\b/i.test(sql)) count++
    return originalExec.call(this, sql)
  })

  try {
    action()
  } finally {
    execSpy.mockRestore()
  }
  return count
}

function columnNames(db: Database.Database): Set<string> {
  const cols = db.prepare('PRAGMA table_info(accounts)').all() as any[]
  return new Set(cols.map((c) => c.name))
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name)
}

function indexExists(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(name)
}

// The CURRENT schema, as KiroDatabase.init() creates it (already has all modern
// columns, no real_email, no usage table). runMigrations on this is the common
// production case and must be idempotent.
function createModernSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, auth_method TEXT NOT NULL,
      region TEXT NOT NULL, oidc_region TEXT, client_id TEXT, client_secret TEXT, profile_arn TEXT,
      start_url TEXT,
      refresh_token TEXT NOT NULL, access_token TEXT NOT NULL, expires_at INTEGER NOT NULL,
      rate_limit_reset INTEGER DEFAULT 0, is_healthy INTEGER DEFAULT 1, unhealthy_reason TEXT,
      recovery_time INTEGER, fail_count INTEGER DEFAULT 0, last_used INTEGER DEFAULT 0,
      used_count INTEGER DEFAULT 0, limit_count INTEGER DEFAULT 0, last_sync INTEGER DEFAULT 0
    )
  `)
}

// A LEGACY schema predating the real_email removal: it has the real_email
// column and lacks start_url / oidc_region / used_count etc. Exercises the
// table-rebuild branch of migrateRealEmailColumn.
function createLegacyRealEmailSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, auth_method TEXT NOT NULL,
      region TEXT NOT NULL, client_id TEXT, client_secret TEXT, profile_arn TEXT,
      refresh_token TEXT NOT NULL, access_token TEXT NOT NULL, expires_at INTEGER NOT NULL,
      rate_limit_reset INTEGER DEFAULT 0, is_healthy INTEGER DEFAULT 1, unhealthy_reason TEXT,
      recovery_time INTEGER, fail_count INTEGER DEFAULT 0, last_used INTEGER DEFAULT 0,
      real_email TEXT
    )
  `)
}

function insertModernAccount(db: Database.Database, overrides: Record<string, unknown> = {}): void {
  const row = {
    id: 'acc-1',
    email: 'user@example.com',
    auth_method: 'idc',
    region: 'us-east-1',
    refresh_token: 'refresh-1',
    access_token: 'access-1',
    expires_at: Date.now() + 3600000,
    ...overrides
  }
  db.prepare(
    `INSERT INTO accounts (id, email, auth_method, region, refresh_token, access_token, expires_at)
     VALUES (@id, @email, @auth_method, @region, @refresh_token, @access_token, @expires_at)`
  ).run(row as any)
}

describe('runMigrations on modern schema', () => {
  test('creates removed_accounts table and all expected columns', () => {
    const db = tempDb()
    createModernSchema(db)
    runMigrations(db)

    expect(tableExists(db, 'removed_accounts')).toBe(true)

    const cols = columnNames(db)
    for (const c of [
      'oidc_region',
      'start_url',
      'used_count',
      'limit_count',
      'last_sync',
      'overage_count'
    ]) {
      expect(cols.has(c)).toBe(true)
    }
    db.close()
  })

  test('adds overage_count to existing rows with default 0 and remains idempotent', () => {
    const db = tempDb()
    createModernSchema(db)
    insertModernAccount(db, { id: 'overage-migration' })

    runMigrations(db)
    runMigrations(db)

    const cols = columnNames(db)
    expect(cols.has('overage_count')).toBe(true)
    const row = db
      .prepare('SELECT overage_count FROM accounts WHERE id = ?')
      .get('overage-migration') as { overage_count: number }
    expect(row.overage_count).toBe(0)
    db.close()
  })

  test('is idempotent: running twice does not throw and keeps schema stable', () => {
    const db = tempDb()
    createModernSchema(db)
    runMigrations(db)
    const before = columnNames(db)

    expect(() => runMigrations(db)).not.toThrow()

    const after = columnNames(db)
    expect([...after].sort()).toEqual([...before].sort())
    expect(tableExists(db, 'removed_accounts')).toBe(true)
    db.close()
  })

  test('drops the refresh_token unique index if present', () => {
    const db = tempDb()
    createModernSchema(db)
    db.exec('CREATE UNIQUE INDEX idx_refresh_token_unique ON accounts(refresh_token)')
    expect(indexExists(db, 'idx_refresh_token_unique')).toBe(true)

    runMigrations(db)

    expect(indexExists(db, 'idx_refresh_token_unique')).toBe(false)
    db.close()
  })
})

describe('refresh-token deduplication migration marker', () => {
  test('reopening an already migrated database performs no writes', () => {
    const path = tempDbPath()
    const initial = new KiroDatabase(path)
    initial.close()
    const observer = new Database(path)
    const before = dataVersion(observer)

    const beginImmediateCount = countBeginImmediateDuring(() => {
      const reopened = new KiroDatabase(path)
      reopened.close()
    })

    expect(beginImmediateCount).toBe(0)
    expect(dataVersion(observer)).toBe(before)
    observer.close()
  })

  test('a legacy database with duplicate refresh tokens is deduplicated exactly once', () => {
    const path = tempDbPath()
    const legacy = new Database(path)
    createModernSchema(legacy)
    insertModernAccount(legacy, { id: 'legacy-dup-a', refresh_token: 'legacy-shared' })
    insertModernAccount(legacy, { id: 'legacy-dup-b', refresh_token: 'legacy-shared' })
    legacy.exec(
      "UPDATE accounts SET used_count = 3, limit_count = 10, last_used = 100 WHERE id = 'legacy-dup-a'"
    )
    legacy.exec(
      "UPDATE accounts SET used_count = 9, limit_count = 20, last_used = 50 WHERE id = 'legacy-dup-b'"
    )
    legacy.close()

    const migrated = new KiroDatabase(path)
    migrated.close()

    const inspection = new Database(path)
    const migratedRows = inspection
      .prepare(
        'SELECT id, used_count, limit_count FROM accounts WHERE refresh_token = ? ORDER BY id'
      )
      .all('legacy-shared')
    expect(migratedRows).toHaveLength(1)
    expect(stringColumn(migratedRows[0], 'id')).toBe('legacy-dup-a')
    expect(numberColumn(migratedRows[0], 'used_count')).toBe(9)
    expect(numberColumn(migratedRows[0], 'limit_count')).toBe(20)
    const marker = inspection
      .prepare('SELECT value FROM plugin_meta WHERE key = ?')
      .get(REFRESH_TOKEN_DEDUP_MARKER)
    expect(numberColumn(marker, 'value')).toBe(1)

    insertModernAccount(inspection, {
      id: 'post-marker-a',
      email: 'post-a@example.com',
      refresh_token: 'post-marker-shared'
    })
    insertModernAccount(inspection, {
      id: 'post-marker-b',
      email: 'post-b@example.com',
      refresh_token: 'post-marker-shared'
    })

    const reopened = new KiroDatabase(path)
    reopened.close()

    const postMarkerRows = inspection
      .prepare('SELECT id FROM accounts WHERE refresh_token = ? ORDER BY id')
      .all('post-marker-shared')
    expect(postMarkerRows.map((row) => stringColumn(row, 'id'))).toEqual([
      'post-marker-a',
      'post-marker-b'
    ])
    inspection.close()
  })

  test('marker and dedup commit atomically', () => {
    const db = tempDb()
    createModernSchema(db)
    db.exec('CREATE TABLE plugin_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)')
    insertModernAccount(db, { id: 'atomic-a', refresh_token: 'atomic-shared' })
    insertModernAccount(db, { id: 'atomic-b', refresh_token: 'atomic-shared' })

    const originalExec = db.exec.bind(db)
    const execSpy = spyOn(db, 'exec').mockImplementation((sql: string) => {
      const marker = db
        .prepare('SELECT value FROM plugin_meta WHERE key = ?')
        .get(REFRESH_TOKEN_DEDUP_MARKER)
      if (/^\s*COMMIT\s*$/i.test(sql) && marker) {
        throw new Error('injected failure before migration commit')
      }
      return originalExec(sql)
    })

    try {
      expect(() => runMigrations(db)).toThrow('injected failure before migration commit')
    } finally {
      execSpy.mockRestore()
    }

    expect(
      db.prepare('SELECT value FROM plugin_meta WHERE key = ?').get(REFRESH_TOKEN_DEDUP_MARKER)
    ).toBeUndefined()
    const rows = db
      .prepare('SELECT id FROM accounts WHERE refresh_token = ? ORDER BY id')
      .all('atomic-shared')
    expect(rows.map((row) => stringColumn(row, 'id'))).toEqual(['atomic-a', 'atomic-b'])
    db.close()
  })
})

describe('migrateToUniqueRefreshToken duplicate merge (index-absent branch)', () => {
  test('rows sharing a refresh_token are merged to one, keeping max usage counters', () => {
    const db = tempDb()
    createModernSchema(db)
    // Two rows, same refresh_token, different ids and usage counters.
    insertModernAccount(db, {
      id: 'dup-a',
      refresh_token: 'shared-token',
      used_count: 3,
      last_used: 100
    })
    insertModernAccount(db, {
      id: 'dup-b',
      refresh_token: 'shared-token',
      used_count: 9,
      last_used: 50
    })
    db.exec(
      "UPDATE accounts SET used_count = 3, limit_count = 10, last_used = 100 WHERE id = 'dup-a'"
    )
    db.exec(
      "UPDATE accounts SET used_count = 9, limit_count = 20, last_used = 50 WHERE id = 'dup-b'"
    )

    runMigrations(db)

    const rows = db
      .prepare('SELECT * FROM accounts WHERE refresh_token = ?')
      .all('shared-token') as any[]
    expect(rows).toHaveLength(1)
    // Kept row is dup-a (ordered by last_used DESC), merged with max counters.
    expect(rows[0].id).toBe('dup-a')
    expect(rows[0].used_count).toBe(9)
    expect(rows[0].limit_count).toBe(20)

    // After the merge migration installs the unique index, the drop migration
    // later removes it — final state has no unique index.
    expect(indexExists(db, 'idx_refresh_token_unique')).toBe(false)
    db.close()
  })
})

describe('migrateRealEmailColumn table-rebuild branch', () => {
  test('legacy real_email is promoted onto builder-id emails and column dropped', () => {
    const db = tempDb()
    createLegacyRealEmailSchema(db)
    // A builder-id placeholder email with a real_email available: should be promoted.
    db.prepare(
      `INSERT INTO accounts (id, email, auth_method, region, refresh_token, access_token, expires_at, real_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'la',
      'builder-id@aws.amazon.com',
      'social',
      'us-east-1',
      'r1',
      'a1',
      Date.now() + 1000,
      'real-person@example.com'
    )
    // A normal email with no real_email: should be preserved as-is.
    db.prepare(
      `INSERT INTO accounts (id, email, auth_method, region, refresh_token, access_token, expires_at, real_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('nb', 'keep@example.com', 'idc', 'us-east-1', 'r2', 'a2', Date.now() + 1000, null)

    runMigrations(db)

    const cols = columnNames(db)
    // The rebuilt table no longer has real_email.
    expect(cols.has('real_email')).toBe(false)
    // and gained the modern columns.
    expect(cols.has('used_count')).toBe(true)
    expect(cols.has('start_url')).toBe(true)
    expect(cols.has('oidc_region')).toBe(true)
    expect(cols.has('overage_count')).toBe(true)

    const promoted = db.prepare('SELECT email FROM accounts WHERE id = ?').get('la') as any
    expect(promoted.email).toBe('real-person@example.com')

    const kept = db.prepare('SELECT email FROM accounts WHERE id = ?').get('nb') as any
    expect(kept.email).toBe('keep@example.com')
    db.close()
  })

  test('oidc_region backfilled from region for rebuilt rows', () => {
    const db = tempDb()
    createLegacyRealEmailSchema(db)
    db.prepare(
      `INSERT INTO accounts (id, email, auth_method, region, refresh_token, access_token, expires_at, real_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('r', 'e@example.com', 'idc', 'eu-west-1', 'r', 'a', Date.now() + 1000, null)

    runMigrations(db)

    const row = db.prepare('SELECT region, oidc_region FROM accounts WHERE id = ?').get('r') as any
    expect(row.oidc_region).toBe('eu-west-1')
    db.close()
  })
})

describe('migrateUsageTable folds a legacy usage table into accounts', () => {
  test('used_count/limit_count/last_sync are copied then usage table dropped', () => {
    const db = tempDb()
    createModernSchema(db)
    insertModernAccount(db, { id: 'u1' })

    db.exec(
      'CREATE TABLE usage (account_id TEXT PRIMARY KEY, used_count INTEGER, limit_count INTEGER, last_sync INTEGER)'
    )
    db.prepare(
      'INSERT INTO usage (account_id, used_count, limit_count, last_sync) VALUES (?,?,?,?)'
    ).run('u1', 42, 100, 777)

    runMigrations(db)

    expect(tableExists(db, 'usage')).toBe(false)
    const row = db
      .prepare('SELECT used_count, limit_count, last_sync FROM accounts WHERE id = ?')
      .get('u1') as any
    expect(row.used_count).toBe(42)
    expect(row.limit_count).toBe(100)
    expect(row.last_sync).toBe(777)
    db.close()
  })
})

describe('migrateToUniqueRefreshToken legacy index compatibility', () => {
  test('when the unique index already exists, marker migration succeeds and the index is still dropped', () => {
    const db = tempDb()
    createModernSchema(db)
    db.exec('CREATE UNIQUE INDEX idx_refresh_token_unique ON accounts(refresh_token)')
    insertModernAccount(db, { id: 'solo', refresh_token: 'uniq-tok' })

    runMigrations(db)

    const rows = db.prepare('SELECT id FROM accounts').all() as any[]
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('solo')
    // migrateDropRefreshTokenUniqueIndex removes the index regardless.
    expect(indexExists(db, 'idx_refresh_token_unique')).toBe(false)
    db.close()
  })
})

describe('migrateDropRefreshTokenUniqueIndex dedup on differing-token rows is a no-op', () => {
  test('two rows same email but different refresh_token both survive (dedup keys on both)', () => {
    const db = tempDb()
    createModernSchema(db)
    insertModernAccount(db, { id: 'a'.repeat(64), email: 'dupe@example.com', refresh_token: 't1' })
    insertModernAccount(db, {
      id: 'kiro-cli-sync-legacy',
      email: 'dupe@example.com',
      refresh_token: 't2'
    })

    runMigrations(db)

    const rows = db
      .prepare('SELECT id FROM accounts WHERE email = ?')
      .all('dupe@example.com') as any[]
    // Different refresh_tokens => not duplicates => both kept.
    expect(rows).toHaveLength(2)
    db.close()
  })
})
