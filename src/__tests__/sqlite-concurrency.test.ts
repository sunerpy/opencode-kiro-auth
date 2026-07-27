import { describe, expect, spyOn, test } from 'bun:test'
import type Libsql from 'libsql'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'
import { createDatabase } from '../plugin/storage/sqlite.js'
import type { ManagedAccount } from '../plugin/types.js'

const CHILD_TIMEOUT_MS = 15_000

type DbFixture = { readonly dir: string; readonly path: string }
type ChildOutcome = { readonly exitCode: number; readonly stderr: string }
type AccountRow = {
  readonly id: string
  readonly refresh_token: string
  readonly access_token: string
  readonly expires_at: number
  readonly used_count: number
  readonly last_sync: number
}

function account(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: 'sqlite-concurrency-account',
    email: 'sqlite-concurrency@example.com',
    authMethod: 'idc',
    region: 'us-east-1',
    refreshToken: 'old-refresh',
    accessToken: 'old-access',
    expiresAt: 100,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    ...overrides
  }
}

function tempDbFixture(): DbFixture {
  const dir = mkdtempSync(join(tmpdir(), 'kiro-sqlite-concurrency-'))
  return { dir, path: join(dir, 'kiro.db') }
}

async function waitForFile(path: string, timeoutMs = CHILD_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for barrier: ${path}`)
    await Bun.sleep(5)
  }
}

function spawnChild(source: string, env: NodeJS.ProcessEnv) {
  const child = Bun.spawn({
    cmd: [process.execPath, '-e', source],
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: CHILD_TIMEOUT_MS
  })
  return {
    exited: child.exited,
    stderr: new Response(child.stderr).text()
  }
}

async function outcome(child: ReturnType<typeof spawnChild>): Promise<ChildOutcome> {
  const [exitCode, stderr] = await Promise.all([child.exited, child.stderr])
  return { exitCode, stderr }
}

const holderSource = `
  import Database from 'libsql'
  import { existsSync, writeFileSync } from 'node:fs'

  const path = process.env.SHARED_DB_PATH
  const readyPath = process.env.HOLDER_READY_PATH
  const releaseMarkers = JSON.parse(process.env.RELEASE_MARKERS ?? '[]')
  if (!path || !readyPath || !Array.isArray(releaseMarkers)) throw new Error('Missing holder inputs')

  const db = new Database(path)
  db.exec('BEGIN IMMEDIATE')
  if (process.env.UPDATE_TOKEN === '1') {
    db.prepare(
      'UPDATE accounts SET refresh_token = ?, access_token = ?, expires_at = ? WHERE id = ?'
    ).run('new-refresh', 'new-access', 200, 'sqlite-concurrency-account')
  }
  writeFileSync(readyPath, 'ready')

  const deadline = Date.now() + ${CHILD_TIMEOUT_MS}
  while (!releaseMarkers.some((marker) => existsSync(marker))) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for release marker')
    await Bun.sleep(5)
  }
  db.exec('COMMIT')
  db.close()
`

const atomicContenderSource = `
  import type Libsql from 'libsql'
  import { existsSync, writeFileSync } from 'node:fs'
  import { KiroDatabase } from './src/plugin/storage/sqlite.ts'

  const path = process.env.SHARED_DB_PATH
  const contenderReadyPath = process.env.CONTENDER_READY_PATH
  const startPath = process.env.START_PATH
  const readPath = process.env.READ_COMPLETE_PATH
  const timerPath = process.env.TIMER_FIRED_PATH
  if (!path || !contenderReadyPath || !startPath || !readPath || !timerPath) {
    throw new Error('Missing contender inputs')
  }

  class InstrumentedDatabase extends KiroDatabase {
    override getAccounts() {
      const rows = super.getAccounts()
      writeFileSync(readPath, 'read')
      return rows
    }
  }

  const db = new InstrumentedDatabase(path)
  const connection: Libsql.Database = Reflect.get(db, 'db')
  const originalExec = connection.exec.bind(connection)
  connection.exec = (sql) => {
    if (sql.startsWith('BEGIN')) setTimeout(() => writeFileSync(timerPath, 'responsive'), 0)
    return originalExec(sql)
  }

  writeFileSync(contenderReadyPath, 'ready')
  const deadline = Date.now() + ${CHILD_TIMEOUT_MS}
  while (!existsSync(startPath)) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for contender start')
    await Bun.sleep(5)
  }

  try {
    await db.upsertAccount({
      id: 'sqlite-concurrency-account', email: 'sqlite-concurrency@example.com',
      authMethod: 'idc', region: 'us-east-1', refreshToken: 'old-refresh',
      accessToken: 'old-access', expiresAt: 100, rateLimitResetTime: 0,
      isHealthy: true, failCount: 0, usedCount: 20, limitCount: 100, lastSync: 20
    })
  } finally {
    db.close()
  }
`

const responsiveContenderSource = `
  import type Libsql from 'libsql'
  import { existsSync, writeFileSync } from 'node:fs'
  import { KiroDatabase } from './src/plugin/storage/sqlite.ts'

  const path = process.env.SHARED_DB_PATH
  const contenderReadyPath = process.env.CONTENDER_READY_PATH
  const startPath = process.env.START_PATH
  const timerPath = process.env.TIMER_FIRED_PATH
  if (!path || !contenderReadyPath || !startPath || !timerPath) {
    throw new Error('Missing contender inputs')
  }

  const db = new KiroDatabase(path)
  const connection: Libsql.Database = Reflect.get(db, 'db')
  const originalExec = connection.exec.bind(connection)
  connection.exec = (sql) => {
    if (sql.startsWith('BEGIN')) setTimeout(() => writeFileSync(timerPath, 'responsive'), 0)
    return originalExec(sql)
  }

  writeFileSync(contenderReadyPath, 'ready')
  const deadline = Date.now() + ${CHILD_TIMEOUT_MS}
  while (!existsSync(startPath)) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for contender start')
    await Bun.sleep(5)
  }

  let failure
  try {
    await db.upsertAccount({
      id: 'sqlite-event-loop-account', email: 'sqlite-event-loop@example.com',
      authMethod: 'idc', region: 'us-east-1', refreshToken: 'refresh', accessToken: 'access',
      expiresAt: 100, rateLimitResetTime: 0, isHealthy: true, failCount: 0
    })
  } catch (error) {
    failure = error
  } finally {
    await Bun.sleep(0)
    db.close()
  }
  if (failure) throw failure
`

describe('KiroDatabase runtime write concurrency', () => {
  test(
    'upsertAccount reads inside BEGIN IMMEDIATE and preserves a token committed by another process',
    async () => {
      const fixture = tempDbFixture()
      const readyPath = join(fixture.dir, 'holder-ready')
      const contenderReadyPath = join(fixture.dir, 'contender-ready')
      const startPath = join(fixture.dir, 'start-contender')
      const readPath = join(fixture.dir, 'contender-read')
      const timerPath = join(fixture.dir, 'contender-responsive')
      const seed = createDatabase(fixture.path)

      try {
        await seed.upsertAccount(account({ usedCount: 1, limitCount: 100, lastSync: 1 }))

        const contender = spawnChild(atomicContenderSource, {
          CONTENDER_READY_PATH: contenderReadyPath,
          READ_COMPLETE_PATH: readPath,
          SHARED_DB_PATH: fixture.path,
          START_PATH: startPath,
          TIMER_FIRED_PATH: timerPath,
          XDG_CONFIG_HOME: join(fixture.dir, 'contender-home')
        })
        await waitForFile(contenderReadyPath)

        const holder = spawnChild(holderSource, {
          HOLDER_READY_PATH: readyPath,
          RELEASE_MARKERS: JSON.stringify([readPath, timerPath]),
          SHARED_DB_PATH: fixture.path,
          UPDATE_TOKEN: '1'
        })
        await waitForFile(readyPath)
        writeFileSync(startPath, 'start')

        const [holderResult, contenderResult] = await Promise.all([
          outcome(holder),
          outcome(contender)
        ])
        expect(holderResult).toEqual({ exitCode: 0, stderr: '' })
        expect(contenderResult).toEqual({ exitCode: 0, stderr: '' })

        const verifier = createDatabase(fixture.path)
        const row = (verifier.getAccounts() as AccountRow[]).find(
          (candidate) => candidate.id === 'sqlite-concurrency-account'
        )
        verifier.close()
        expect(row).toMatchObject({
          refresh_token: 'new-refresh',
          access_token: 'new-access',
          expires_at: 200,
          used_count: 20,
          last_sync: 20
        })
      } finally {
        if (seed) seed.close()
        rmSync(fixture.dir, { recursive: true, force: true })
      }
    },
    CHILD_TIMEOUT_MS + 5_000
  )

  test(
    'waiting for a cross-process writer lock does not block the event loop',
    async () => {
      const fixture = tempDbFixture()
      const readyPath = join(fixture.dir, 'holder-ready')
      const contenderReadyPath = join(fixture.dir, 'contender-ready')
      const startPath = join(fixture.dir, 'start-contender')
      const timerPath = join(fixture.dir, 'contender-responsive')
      createDatabase(fixture.path).close()

      try {
        const contender = spawnChild(responsiveContenderSource, {
          CONTENDER_READY_PATH: contenderReadyPath,
          SHARED_DB_PATH: fixture.path,
          START_PATH: startPath,
          TIMER_FIRED_PATH: timerPath,
          XDG_CONFIG_HOME: join(fixture.dir, 'contender-home')
        })
        await waitForFile(contenderReadyPath)
        const holder = spawnChild(holderSource, {
          HOLDER_READY_PATH: readyPath,
          RELEASE_MARKERS: JSON.stringify([timerPath]),
          SHARED_DB_PATH: fixture.path
        })
        await waitForFile(readyPath)
        writeFileSync(startPath, 'start')

        const [holderResult, contenderResult] = await Promise.all([
          outcome(holder),
          outcome(contender)
        ])
        expect(existsSync(timerPath)).toBe(true)
        expect(holderResult).toEqual({ exitCode: 0, stderr: '' })
        expect(contenderResult).toEqual({ exitCode: 0, stderr: '' })
      } finally {
        rmSync(fixture.dir, { recursive: true, force: true })
      }
    },
    CHILD_TIMEOUT_MS + 5_000
  )

  test('BEGIN IMMEDIATE retries SQLITE_BUSY until its bounded deadline and preserves the cause', async () => {
    const fixture = tempDbFixture()
    const database = createDatabase(fixture.path)
    const connection: Libsql.Database = Reflect.get(database, 'db')
    const originalExec = connection.exec.bind(connection)
    const busyError = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
    const startedAt = Date.now()
    let attempts = 0
    let nowCalls = 0
    connection.exec = (sql) => {
      if (sql === 'BEGIN IMMEDIATE') {
        attempts++
        throw busyError
      }
      return originalExec(sql)
    }
    const nowSpy = spyOn(Date, 'now').mockImplementation(() =>
      ++nowCalls >= 3 ? startedAt + 30_000 : startedAt
    )
    const randomSpy = spyOn(Math, 'random').mockReturnValue(0)

    try {
      await expect(database.upsertAccount(account())).rejects.toMatchObject({
        name: 'DatabaseWriteLockTimeoutError',
        code: 'KIRO_DB_WRITE_LOCK_TIMEOUT',
        cause: busyError
      })
      expect(attempts).toBe(2)
    } finally {
      randomSpy.mockRestore()
      nowSpy.mockRestore()
      database.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  test('an exception inside the transaction rolls back its writes', async () => {
    const fixture = tempDbFixture()
    const database = createDatabase(fixture.path)
    await database.upsertAccount(account({ accessToken: 'before' }))
    const connection: Libsql.Database = Reflect.get(database, 'db')
    const originalExec = connection.exec.bind(connection)
    const calls: string[] = []
    connection.exec = (sql) => {
      calls.push(sql)
      return originalExec(sql)
    }
    Reflect.set(database, 'upsertAccountInternal', () => {
      throw new Error('injected write failure')
    })

    try {
      await expect(database.upsertAccount(account({ accessToken: 'after' }))).rejects.toThrow(
        'injected write failure'
      )
      expect(calls).toContain('ROLLBACK')
      const row = (database.getAccounts() as AccountRow[]).find(
        (candidate) => candidate.id === 'sqlite-concurrency-account'
      )
      expect(row?.access_token).toBe('before')
    } finally {
      database.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  test('a failed BEGIN does not issue ROLLBACK', async () => {
    const fixture = tempDbFixture()
    const database = createDatabase(fixture.path)
    const connection: Libsql.Database = Reflect.get(database, 'db')
    const originalExec = connection.exec.bind(connection)
    const beginError = Object.assign(new Error('read-only database'), { code: 'SQLITE_READONLY' })
    const calls: string[] = []
    connection.exec = (sql) => {
      calls.push(sql)
      if (sql.startsWith('BEGIN')) throw beginError
      return originalExec(sql)
    }

    try {
      await expect(database.upsertAccount(account())).rejects.toBe(beginError)
      expect(calls).not.toContain('ROLLBACK')
    } finally {
      database.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  test('all runtime write methods avoid the global database file lock', async () => {
    const fixture = tempDbFixture()
    const database = createDatabase(fixture.path)
    const originalLock = lockfile.lock
    let databaseLockCalls = 0
    const lockSpy = spyOn(lockfile, 'lock').mockImplementation(async (path, options) => {
      if (path === fixture.path) databaseLockCalls++
      return originalLock(path, options)
    })

    try {
      await database.upsertAccount(account({ id: 'write-upsert', email: 'upsert@example.com' }))
      await database.batchUpsertAccounts([
        account({ id: 'write-batch', email: 'batch@example.com' })
      ])
      await database.deleteAccount('write-delete')
      await database.upsertAccount(account({ id: 'write-remove', email: 'remove@example.com' }))
      await database.removeAccountWithTombstone('write-remove')
      await database.upsertAccount(account({ id: 'write-keep', email: 'identity@example.com' }))
      await database.upsertAccount(
        account({ id: 'write-superseded', email: 'identity@example.com' })
      )
      await database.cleanupSupersededIdentities(
        'write-keep',
        'identity@example.com',
        'idc',
        undefined
      )
      await database.addRemovedAccount('write-manual-tombstone')
      await database.clearRemovedAccount('write-manual-tombstone')
      await database.nextAssignmentIndex()
      await database.markAccountsUnhealthy(['write-batch'], 'test')

      expect(databaseLockCalls).toBe(0)
    } finally {
      lockSpy.mockRestore()
      database.close()
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })
})
