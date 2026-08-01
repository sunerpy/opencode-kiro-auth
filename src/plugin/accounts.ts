import { createHash } from 'node:crypto'
import { decodeRefreshToken, encodeRefreshToken } from '../kiro/auth'
import { isAccessTokenError, isPermanentError } from './health'
import * as logger from './logger'
import { kiroDb, type AccountHealthSnapshot } from './storage/sqlite'
import { writeToKiroCli } from './sync/kiro-cli'
import type {
  AccountSelectionStrategy,
  KiroAuthDetails,
  ManagedAccount,
  RefreshParts
} from './types'

const ACCOUNT_HEALTH_REFRESH_INTERVAL_MS = 1_000

type HealthPersistenceMethod =
  'updateUsage' | 'addAccount' | 'updateFromAuth' | 'markRateLimited' | 'markUnhealthy'

export function createDeterministicAccountId(
  email: string,
  method: string,
  clientId?: string,
  profileArn?: string
): string {
  return createHash('sha256')
    .update(`${email}:${method}:${clientId || ''}:${profileArn || ''}`)
    .digest('hex')
}

export class AccountManager {
  private accounts: ManagedAccount[]
  private cursor: number
  private strategy: AccountSelectionStrategy
  private lastToastTime = 0
  private lastUsageToastTime = 0
  private rrCursor: number
  private stickyId?: string
  private startIndex: number
  private perRequestSpread: boolean
  private quotaAvoidanceEnabled: boolean
  private quotaReserveThreshold: number
  private stopOnOverage: boolean
  private overageThreshold: number
  private lastHealthDataVersion: number | undefined
  private lastHealthRefreshAt: number
  private pendingHealthWriteCounts = new Map<string, number>()
  constructor(
    accounts: ManagedAccount[],
    strategy: AccountSelectionStrategy = 'sticky',
    opts?: {
      quotaAvoidanceEnabled?: boolean
      quotaReserveThreshold?: number
      stopOnOverage?: boolean
      overageThreshold?: number
      startIndex?: number
      perRequestSpread?: boolean
    }
  ) {
    this.accounts = accounts
    this.cursor = 0
    this.strategy = strategy
    this.quotaAvoidanceEnabled = opts?.quotaAvoidanceEnabled ?? true
    this.quotaReserveThreshold = opts?.quotaReserveThreshold ?? 0.95
    this.stopOnOverage = opts?.stopOnOverage ?? true
    this.overageThreshold = opts?.overageThreshold ?? 0
    this.startIndex = opts?.startIndex ?? 0
    this.perRequestSpread = opts?.perRequestSpread ?? false
    this.rrCursor = this.startIndex
    this.lastHealthRefreshAt = Date.now()
    try {
      this.lastHealthDataVersion = kiroDb.getDataVersion()
    } catch {
      this.lastHealthDataVersion = undefined
    }
  }
  static async loadFromDisk(
    strategy?: AccountSelectionStrategy,
    opts?: {
      quotaAvoidanceEnabled?: boolean
      quotaReserveThreshold?: number
      stopOnOverage?: boolean
      overageThreshold?: number
      distributeAcrossProcesses?: boolean
      perRequestSpread?: boolean
    }
  ): Promise<AccountManager> {
    const rows = kiroDb.getAccounts()
    const accounts: ManagedAccount[] = rows.map((r: any) => ({
      id: r.id,
      email: r.email,
      authMethod: r.auth_method as any,
      region: r.region as any,
      oidcRegion: r.oidc_region || undefined,
      clientId: r.client_id,
      clientSecret: r.client_secret,
      profileArn: r.profile_arn,
      startUrl: r.start_url || undefined,
      refreshToken: r.refresh_token,
      accessToken: r.access_token,
      expiresAt: r.expires_at,
      rateLimitResetTime: r.rate_limit_reset,
      isHealthy: r.is_healthy === 1,
      unhealthyReason: r.unhealthy_reason,
      recoveryTime: r.recovery_time,
      failCount: r.fail_count || 0,
      lastUsed: r.last_used,
      usedCount: r.used_count,
      limitCount: r.limit_count,
      overageCount: r.overage_count || 0,
      lastSync: r.last_sync
    }))
    let startIndex = 0
    if (opts?.distributeAcrossProcesses !== false) {
      try {
        startIndex = await kiroDb.nextAssignmentIndex()
      } catch (error) {
        logger.warn('assignment index failed, using 0', {
          error: error instanceof Error ? error.message : String(error)
        })
        startIndex = 0
      }
    }
    return new AccountManager(accounts, strategy || 'sticky', {
      ...opts,
      startIndex,
      perRequestSpread: opts?.perRequestSpread
    })
  }
  getAccountCount(): number {
    return this.accounts.length
  }
  getAccounts(): ManagedAccount[] {
    return [...this.accounts]
  }
  shouldShowToast(debounce = 10000): boolean {
    if (Date.now() - this.lastToastTime < debounce) return false
    this.lastToastTime = Date.now()
    return true
  }
  shouldShowUsageToast(debounce = 10000): boolean {
    if (Date.now() - this.lastUsageToastTime < debounce) return false
    this.lastUsageToastTime = Date.now()
    return true
  }
  getMinWaitTime(): number {
    const now = Date.now()
    const waits = this.accounts.map((a) => (a.rateLimitResetTime || 0) - now).filter((t) => t > 0)
    return waits.length > 0 ? Math.min(...waits) : 0
  }
  allSelectableBlockedByOverage(): boolean {
    if (!this.stopOnOverage) return false

    const now = Date.now()
    const healthEligible = (a: ManagedAccount) => {
      if (isPermanentError(a.unhealthyReason)) return false
      if (a.isHealthy) return true
      if (isAccessTokenError(a.unhealthyReason)) return true
      return a.failCount < 10
    }
    const rateLimited = (a: ManagedAccount) =>
      !!(a.rateLimitResetTime && now < a.rateLimitResetTime)
    const hasOverageBlockedEligible = this.accounts.some(
      (a) => healthEligible(a) && this.isOverageBlocked(a)
    )
    const hasCleanRateLimited = this.accounts.some(
      (a) => healthEligible(a) && rateLimited(a) && !this.isOverageBlocked(a)
    )
    const hasHealthySelectable = this.accounts.some(
      (a) => a.isHealthy && !rateLimited(a) && !this.isOverageBlocked(a)
    )

    return hasOverageBlockedEligible && !hasCleanRateLimited && !hasHealthySelectable
  }
  getCurrentOrNext(
    options: { excludedIds?: ReadonlySet<string>; recoverUnhealthy?: boolean } = {}
  ): ManagedAccount | null {
    const now = Date.now()
    this.refreshAccountHealthIfNeeded(now)
    const excludedIds = options.excludedIds ?? new Set<string>()
    const recoverUnhealthy = options.recoverUnhealthy ?? true
    const overageBlocked = (a: ManagedAccount) => this.isOverageBlocked(a)
    const available = this.accounts.filter((a) => {
      if (excludedIds.has(a.id)) return false
      if (overageBlocked(a)) return false
      if (!a.isHealthy) {
        if (!recoverUnhealthy) return false
        if (isPermanentError(a.unhealthyReason)) {
          return false
        }
        // Heal-by-refresh: a legacy access-token-error row (persisted
        // invalid-bearer, possibly failCount=10) is refreshable, so reset and
        // reselect it. Refresh-dead rows are already excluded above.
        if (isAccessTokenError(a.unhealthyReason)) {
          a.failCount = 0
          a.isHealthy = true
          delete a.unhealthyReason
          delete a.recoveryTime
          return true
        }
        if (a.failCount < 10 && a.recoveryTime && now >= a.recoveryTime) {
          a.isHealthy = true
          delete a.unhealthyReason
          delete a.recoveryTime
          return true
        }
        return false
      }
      return !(a.rateLimitResetTime && now < a.rateLimitResetTime)
    })
    let candidatePool = available
    if (this.accounts.length > 1 && this.quotaAvoidanceEnabled) {
      const ratio = (a: ManagedAccount) =>
        a.limitCount && a.limitCount > 0 ? (a.usedCount || 0) / a.limitCount : 0
      const ample = available.filter((a) => ratio(a) < this.quotaReserveThreshold)
      // used>=limit stays in nearFull (soft/drainable, NOT hard-excluded): the
      // real 402 is the authoritative exhaustion signal and already
      // hard-switches accounts in error-handler.
      const nearFull = available.filter((a) => ratio(a) >= this.quotaReserveThreshold)
      candidatePool = ample.length > 0 ? ample : nearFull
    }

    const sorted = [...this.accounts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const N = sorted.length
    let selected: ManagedAccount | undefined
    if (candidatePool.length > 0) {
      if (this.perRequestSpread) {
        selected = [...candidatePool].sort(
          (a, b) => (a.usedCount || 0) - (b.usedCount || 0) || (a.lastUsed || 0) - (b.lastUsed || 0)
        )[0]
      } else if (this.strategy === 'sticky') {
        if (this.stickyId) {
          selected = candidatePool.find((a) => a.id === this.stickyId)
        }
        if (!selected) {
          for (let k = 0; k < N; k++) {
            const candidate = sorted[(this.startIndex + k) % N]
            if (candidate && candidatePool.some((account) => account.id === candidate.id)) {
              selected = candidate
              break
            }
          }
        }
        if (selected) this.stickyId = selected.id
      } else if (this.strategy === 'round-robin') {
        selected = candidatePool[this.rrCursor % candidatePool.length]
        this.rrCursor++
      } else {
        const sortedIndexById = new Map(sorted.map((account, index) => [account.id, index]))
        selected = [...candidatePool].sort((a, b) => {
          const usageDifference = (a.usedCount || 0) - (b.usedCount || 0)
          if (usageDifference !== 0) return usageDifference

          const lastUsedDifference = (a.lastUsed || 0) - (b.lastUsed || 0)
          if (lastUsedDifference !== 0) return lastUsedDifference

          const aIndex = sortedIndexById.get(a.id) ?? 0
          const bIndex = sortedIndexById.get(b.id) ?? 0
          const aOffset = (((aIndex - this.startIndex) % N) + N) % N
          const bOffset = (((bIndex - this.startIndex) % N) + N) % N
          return aOffset - bOffset
        })[0]
      }
    }
    if (!selected && recoverUnhealthy) {
      const fallback = this.accounts
        .filter(
          (a) =>
            !excludedIds.has(a.id) &&
            !a.isHealthy &&
            a.failCount < 10 &&
            !isPermanentError(a.unhealthyReason) &&
            !overageBlocked(a)
        )
        .sort(
          (a, b) => (a.usedCount || 0) - (b.usedCount || 0) || (a.lastUsed || 0) - (b.lastUsed || 0)
        )[0]
      if (fallback) {
        fallback.isHealthy = true
        delete fallback.unhealthyReason
        delete fallback.recoveryTime
        selected = fallback
      }
    }
    if (selected) {
      if (overageBlocked(selected)) return null
      selected.lastUsed = now
      selected.usedCount = (selected.usedCount || 0) + 1
      return selected
    }
    return null
  }
  private refreshAccountHealthIfNeeded(now: number): void {
    let dataVersion: number
    try {
      dataVersion = kiroDb.getDataVersion()
    } catch (error) {
      this.lastHealthRefreshAt = now
      logger.warn('Account health refresh check failed; keeping in-memory state', {
        error: error instanceof Error ? error.message : String(error)
      })
      return
    }

    const versionChanged =
      this.lastHealthDataVersion !== undefined && dataVersion !== this.lastHealthDataVersion
    const refreshExpired = now - this.lastHealthRefreshAt >= ACCOUNT_HEALTH_REFRESH_INTERVAL_MS
    if (!versionChanged && !refreshExpired) return

    try {
      const snapshots = kiroDb.getAccountHealthSnapshots(this.accounts.map((account) => account.id))
      const snapshotsById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]))
      for (const account of this.accounts) {
        const snapshot = snapshotsById.get(account.id)
        if (snapshot) this.applyHealthSnapshot(account, snapshot)
      }
    } catch (error) {
      logger.warn('Account health refresh failed; keeping in-memory state', {
        error: error instanceof Error ? error.message : String(error)
      })
    } finally {
      this.lastHealthDataVersion = dataVersion
      this.lastHealthRefreshAt = now
    }
  }
  private applyHealthSnapshot(account: ManagedAccount, snapshot: AccountHealthSnapshot): void {
    if ((this.pendingHealthWriteCounts.get(account.id) ?? 0) > 0) return
    account.rateLimitResetTime = snapshot.rateLimitResetTime
    account.isHealthy = snapshot.isHealthy
    account.failCount = snapshot.failCount
    if (snapshot.unhealthyReason === undefined) delete account.unhealthyReason
    else account.unhealthyReason = snapshot.unhealthyReason
    if (snapshot.recoveryTime === undefined) delete account.recoveryTime
    else account.recoveryTime = snapshot.recoveryTime
  }
  private persistLocalHealthMutation(
    account: ManagedAccount,
    method: HealthPersistenceMethod
  ): void {
    const pendingCount = this.pendingHealthWriteCounts.get(account.id) ?? 0
    this.pendingHealthWriteCounts.set(account.id, pendingCount + 1)
    const persistedSnapshot = { ...account }

    kiroDb
      .upsertAccount(persistedSnapshot)
      .catch((error) =>
        logger.warn('DB write failed', {
          method,
          email: account.email,
          error: error instanceof Error ? error.message : String(error)
        })
      )
      .finally(() => {
        const remaining = (this.pendingHealthWriteCounts.get(account.id) ?? 1) - 1
        if (remaining > 0) this.pendingHealthWriteCounts.set(account.id, remaining)
        else this.pendingHealthWriteCounts.delete(account.id)
      })
  }
  updateUsage(
    id: string,
    meta: {
      usedCount: number
      limitCount: number
      overageCount?: number
      email?: string
      lastSync?: number
    }
  ): void {
    const a = this.accounts.find((x) => x.id === id)
    if (a) {
      a.usedCount = meta.usedCount
      a.limitCount = meta.limitCount
      a.overageCount = meta.overageCount ?? 0
      a.lastSync = meta.lastSync ?? a.lastSync
      if (meta.email) a.email = meta.email
      if (!isPermanentError(a.unhealthyReason)) {
        a.failCount = 0
        a.isHealthy = true
        delete a.unhealthyReason
        delete a.recoveryTime
      }
      this.persistLocalHealthMutation(a, 'updateUsage')
    }
  }
  addAccount(a: ManagedAccount): void {
    const i = this.accounts.findIndex((x) => x.id === a.id)
    if (i === -1) this.accounts.push(a)
    else this.accounts[i] = a
    this.persistLocalHealthMutation(a, 'addAccount')
  }
  removeAccount(a: ManagedAccount): void {
    const removedIndex = this.accounts.findIndex((x) => x.id === a.id)
    if (removedIndex === -1) return
    this.accounts = this.accounts.filter((x) => x.id !== a.id)
    kiroDb.removeAccountWithTombstone(a.id).catch((e) =>
      logger.warn('DB write failed', {
        method: 'removeAccountWithTombstone',
        email: a.email,
        error: e instanceof Error ? e.message : String(e)
      })
    )
    if (this.accounts.length === 0) this.cursor = 0
    else if (this.cursor >= this.accounts.length) this.cursor = this.accounts.length - 1
    else if (removedIndex <= this.cursor && this.cursor > 0) this.cursor--
  }
  updateFromAuth(a: ManagedAccount, auth: KiroAuthDetails): void {
    const account = this.accounts.find((item) => item.id === a.id)
    if (!account) return

    const candidate = this.createAuthCandidate(account, auth)
    this.publishAuthCandidate(candidate, false)
    this.persistLocalHealthMutation(candidate, 'updateFromAuth')
    this.writeAuthCandidateToKiroCli(candidate)
  }
  createAuthCandidate(a: ManagedAccount, auth: KiroAuthDetails): ManagedAccount {
    const candidate = { ...a }
    candidate.accessToken = auth.access
    candidate.expiresAt = auth.expires
    candidate.lastUsed = Date.now()
    if (auth.email) candidate.email = auth.email
    const p = decodeRefreshToken(auth.refresh)
    candidate.refreshToken = p.refreshToken
    if (p.profileArn) candidate.profileArn = p.profileArn
    if (p.clientId) candidate.clientId = p.clientId
    candidate.failCount = 0
    candidate.isHealthy = true
    delete candidate.unhealthyReason
    delete candidate.recoveryTime
    return candidate
  }
  publishAuthCandidate(candidate: ManagedAccount, syncKiroCli = true): void {
    const account = this.accounts.find((item) => item.id === candidate.id)
    if (!account) return

    Object.assign(account, candidate)
    if (candidate.unhealthyReason === undefined) delete account.unhealthyReason
    if (candidate.recoveryTime === undefined) delete account.recoveryTime
    if (!syncKiroCli) return

    this.writeAuthCandidateToKiroCli(account)
  }
  private writeAuthCandidateToKiroCli(account: ManagedAccount): void {
    writeToKiroCli(account).catch((e) =>
      logger.warn('CLI write failed', {
        method: 'updateFromAuth',
        email: account.email,
        error: e instanceof Error ? e.message : String(e)
      })
    )
  }
  markRateLimited(a: ManagedAccount, ms: number): void {
    const acc = this.accounts.find((x) => x.id === a.id)
    if (acc) {
      acc.rateLimitResetTime = Date.now() + ms
      this.persistLocalHealthMutation(acc, 'markRateLimited')
    }
  }
  markUnhealthy(a: ManagedAccount, reason: string, recovery?: number): void {
    const acc = this.accounts.find((x) => x.id === a.id)
    if (!acc) return

    const isPermanent = isPermanentError(reason)

    if (isPermanent) {
      logger.warn('Account marked as permanently unhealthy', {
        email: acc.email,
        reason,
        accountId: acc.id
      })
      acc.failCount = 10
      acc.isHealthy = false
      acc.unhealthyReason = reason
      delete acc.recoveryTime
    } else {
      acc.failCount = (acc.failCount || 0) + 1
      acc.unhealthyReason = reason
      acc.lastUsed = Date.now()
      if (acc.failCount >= 10) {
        acc.isHealthy = false
        acc.recoveryTime = recovery || Date.now() + 3600000
      }
    }

    this.persistLocalHealthMutation(acc, 'markUnhealthy')
  }
  async saveToDisk(): Promise<void> {
    await kiroDb.batchUpsertAccounts(this.accounts)
  }
  toAuthDetails(a: ManagedAccount): KiroAuthDetails {
    const p: RefreshParts = {
      refreshToken: a.refreshToken,
      profileArn: a.profileArn,
      clientId: a.clientId,
      clientSecret: a.clientSecret,
      authMethod: a.authMethod
    }
    return {
      refresh: encodeRefreshToken(p),
      access: a.accessToken,
      expires: a.expiresAt,
      authMethod: a.authMethod,
      region: a.region,
      oidcRegion: a.oidcRegion,
      profileArn: a.profileArn,
      clientId: a.clientId,
      clientSecret: a.clientSecret,
      email: a.email
    }
  }

  private isOverageBlocked(a: ManagedAccount): boolean {
    return this.stopOnOverage && (a.overageCount ?? 0) > this.overageThreshold
  }
}
