import { createHash } from 'node:crypto'
import { existsSync, promises as fs, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import lockfile from 'proper-lockfile'
import { isPermanentError } from '../health'
import { getKeepAliveLockPath, getRefreshLockPath } from '../paths.js'
import type { ManagedAccount } from '../types'

export { getKeepAliveLockPath, getRefreshLockPath } from '../paths.js'

const DATABASE_LOCK_OPTIONS = {
  stale: 10000,
  retries: 0,
  realpath: false
}
const DATABASE_LOCK_DEADLINE_MS = 10000
const DATABASE_LOCK_MIN_BACKOFF_MS = 25
const DATABASE_LOCK_MAX_BACKOFF_MS = 250

const REFRESH_LOCK_OPTIONS = {
  stale: 15000,
  retries: {
    retries: 10,
    minTimeout: 100,
    maxTimeout: 1000,
    factor: 2
  },
  realpath: false
}

const KEEP_ALIVE_LOCK_OPTIONS = {
  stale: 120000,
  retries: 0,
  realpath: false
}

type LockRelease = () => Promise<void>

const SYNC_LOCK_OPTIONS = { stale: 10000, retries: 0, realpath: false }
const SYNC_LOCK_DEADLINE_MS = 10000

function blockingBackoff(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function isLockContention(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && e.code === 'ELOCKED'
}

function asyncBackoff(attempt: number, remainingMs: number): Promise<void> {
  const ceiling = Math.min(
    DATABASE_LOCK_MIN_BACKOFF_MS * 2 ** Math.min(attempt, 4),
    DATABASE_LOCK_MAX_BACKOFF_MS,
    remainingMs
  )
  const floor = Math.max(1, Math.floor(ceiling / 2))
  const delay = floor + Math.floor(Math.random() * (ceiling - floor + 1))
  return new Promise((resolve) => setTimeout(resolve, delay))
}

async function acquireDatabaseLock(dbPath: string): Promise<LockRelease> {
  // A deadline avoids fixed retry-count starvation; jitter keeps contenders
  // from repeatedly attempting the atomic mkdir in lockstep.
  const deadline = Date.now() + DATABASE_LOCK_DEADLINE_MS
  let attempt = 0

  for (;;) {
    try {
      return await lockfile.lock(dbPath, DATABASE_LOCK_OPTIONS)
    } catch (e) {
      const remainingMs = deadline - Date.now()
      if (!isLockContention(e) || remainingMs <= 0) throw e
      await asyncBackoff(attempt++, remainingMs)
    }
  }
}

export function withDatabaseLockSync<T>(dbPath: string, fn: () => T): T {
  if (!existsSync(dbPath)) {
    mkdirSync(dirname(dbPath), { recursive: true })
    writeFileSync(dbPath, '')
  }

  // proper-lockfile's sync API rejects a retries object, so bounded lock-acquisition backoff is
  // done here to serialize the synchronous constructor/init (schema + migrations) across processes.
  const deadline = Date.now() + SYNC_LOCK_DEADLINE_MS
  let release: (() => void) | null = null
  let attempt = 0
  for (;;) {
    try {
      release = lockfile.lockSync(dbPath, SYNC_LOCK_OPTIONS)
      break
    } catch (e) {
      if (!isLockContention(e) || Date.now() >= deadline) throw e
      blockingBackoff(Math.min(100 * 2 ** attempt++, 500))
    }
  }

  try {
    return fn()
  } finally {
    try {
      release()
    } catch (e) {
      console.warn('Failed to release lock:', e)
    }
  }
}

export async function withDatabaseLock<T>(dbPath: string, fn: () => Promise<T>): Promise<T> {
  if (!existsSync(dbPath)) {
    await fs.mkdir(dirname(dbPath), { recursive: true })
    await fs.writeFile(dbPath, '')
  }

  let release: (() => Promise<void>) | null = null
  try {
    release = await acquireDatabaseLock(dbPath)
    return await fn()
  } finally {
    if (release) {
      try {
        await release()
      } catch (e) {
        console.warn('Failed to release lock:', e)
      }
    }
  }
}

export async function withRefreshLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = getRefreshLockPath(accountId)

  if (!existsSync(lockPath)) {
    await fs.mkdir(dirname(lockPath), { recursive: true })
    await fs.writeFile(lockPath, '')
  }

  let release: (() => Promise<void>) | null = null
  try {
    release = await lockfile.lock(lockPath, REFRESH_LOCK_OPTIONS)
    return await fn()
  } finally {
    if (release) {
      try {
        await release()
      } catch (e) {
        console.warn('Failed to release refresh lock:', e)
      }
    }
  }
}

export async function tryAcquireKeepAliveLock(): Promise<LockRelease | null> {
  const lockPath = getKeepAliveLockPath()

  if (!existsSync(lockPath)) {
    await fs.mkdir(dirname(lockPath), { recursive: true })
    await fs.writeFile(lockPath, '')
  }

  try {
    return await lockfile.lock(lockPath, KEEP_ALIVE_LOCK_OPTIONS)
  } catch {
    return null
  }
}

export async function withKeepAliveLock<T>(fn: () => Promise<T>): Promise<T | null> {
  const release = await tryAcquireKeepAliveLock()
  if (!release) {
    return null
  }

  try {
    return await fn()
  } finally {
    try {
      await release()
    } catch (e) {
      console.warn('Failed to release keep-alive lock:', e)
    }
  }
}

export function createDeterministicId(
  email: string,
  authMethod: string,
  clientId?: string,
  profileArn?: string
): string {
  const parts = [email, authMethod, clientId || '', profileArn || ''].join(':')
  return createHash('sha256').update(parts).digest('hex')
}

export function mergeAccounts(
  existing: ManagedAccount[],
  incoming: ManagedAccount[]
): ManagedAccount[] {
  const accountMap = new Map<string, ManagedAccount>()

  for (const acc of existing) {
    accountMap.set(acc.id, acc)
  }

  for (const acc of incoming) {
    const existingAcc = accountMap.get(acc.id)

    if (existingAcc) {
      const incomingHasPermanentError = isPermanentError(acc.unhealthyReason)
      const hasPermanentError =
        isPermanentError(existingAcc.unhealthyReason) || incomingHasPermanentError
      const incomingRecovered = acc.isHealthy && !incomingHasPermanentError
      // AWS SSO-OIDC rotates refresh tokens and invalidates the old token; a stale
      // in-memory token triple from another process must not clobber a newer
      // persisted token triple during this cross-process merge.
      const tokenWinner = (acc.expiresAt || 0) >= (existingAcc.expiresAt || 0) ? acc : existingAcc
      const usageWinner = (acc.lastSync || 0) >= (existingAcc.lastSync || 0) ? acc : existingAcc

      accountMap.set(acc.id, {
        ...existingAcc,
        ...acc,
        refreshToken: tokenWinner.refreshToken,
        accessToken: tokenWinner.accessToken,
        expiresAt: tokenWinner.expiresAt,
        lastUsed: Math.max(existingAcc.lastUsed || 0, acc.lastUsed || 0),
        usedCount: usageWinner.usedCount ?? 0,
        limitCount: usageWinner.limitCount ?? 0,
        overageCount: usageWinner.overageCount ?? 0,
        rateLimitResetTime: Math.max(
          existingAcc.rateLimitResetTime || 0,
          acc.rateLimitResetTime || 0
        ),
        isHealthy: incomingRecovered
          ? true
          : hasPermanentError
            ? false
            : existingAcc.isHealthy || acc.isHealthy,
        unhealthyReason: incomingRecovered
          ? undefined
          : acc.unhealthyReason || existingAcc.unhealthyReason,
        recoveryTime: incomingRecovered ? undefined : acc.recoveryTime || existingAcc.recoveryTime,
        failCount: incomingRecovered
          ? acc.failCount || 0
          : Math.max(existingAcc.failCount || 0, acc.failCount || 0),
        lastSync: Math.max(existingAcc.lastSync || 0, acc.lastSync || 0)
      })
    } else {
      accountMap.set(acc.id, acc)
    }
  }

  return Array.from(accountMap.values())
}

export function deduplicateAccounts(accounts: ManagedAccount[]): ManagedAccount[] {
  const accountMap = new Map<string, ManagedAccount>()

  for (const acc of accounts) {
    const existing = accountMap.get(acc.id)
    if (!existing) {
      accountMap.set(acc.id, acc)
      continue
    }

    const currLastUsed = acc.lastUsed || 0
    const existLastUsed = existing.lastUsed || 0

    if (currLastUsed > existLastUsed) {
      accountMap.set(acc.id, acc)
    } else if (currLastUsed === existLastUsed) {
      const currAddedAt = acc.expiresAt || 0
      const existAddedAt = existing.expiresAt || 0
      if (currAddedAt > existAddedAt) {
        accountMap.set(acc.id, acc)
      }
    }
  }

  return Array.from(accountMap.values())
}
