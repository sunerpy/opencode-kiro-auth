import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import lockfile from 'proper-lockfile'
import { isPermanentError } from '../health'
import type { ManagedAccount } from '../types'

const LOCK_OPTIONS = {
  stale: 10000,
  retries: {
    retries: 5,
    minTimeout: 100,
    maxTimeout: 1000,
    factor: 2
  },
  realpath: false
}

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

function getBaseDir(): string {
  // Keep this local instead of importing DB_PATH from sqlite.ts: sqlite.ts imports
  // this module and also constructs `kiroDb` at module load, so importing it here
  // would create a cycle and trigger database construction just to compute a lock path.
  const p = process.platform
  if (p === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'opencode')
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
}

export function getRefreshLockPath(accountId: string): string {
  const safeAccountId = accountId.replace(/[^A-Za-z0-9_-]/g, '')
  return join(getBaseDir(), `.kiro-refresh-${safeAccountId}.lock`)
}

export function getKeepAliveLockPath(): string {
  return join(getBaseDir(), '.kiro-keepalive.lock')
}

export async function withDatabaseLock<T>(dbPath: string, fn: () => Promise<T>): Promise<T> {
  if (!existsSync(dbPath)) {
    const dir = dbPath.substring(0, dbPath.lastIndexOf('/'))
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(dbPath, '')
  }

  let release: (() => Promise<void>) | null = null
  try {
    release = await lockfile.lock(dbPath, LOCK_OPTIONS)
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
