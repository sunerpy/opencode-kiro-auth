import { createHash } from 'node:crypto'
import { decodeRefreshToken, encodeRefreshToken } from '../kiro/auth'
import { isAccessTokenError, isPermanentError } from './health'
import * as logger from './logger'
import { kiroDb } from './storage/sqlite'
import { writeToKiroCli } from './sync/kiro-cli'
import type {
  AccountSelectionStrategy,
  KiroAuthDetails,
  ManagedAccount,
  RefreshParts
} from './types'

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
  getCurrentOrNext(): ManagedAccount | null {
    const now = Date.now()
    const overageBlocked = (a: ManagedAccount) => this.isOverageBlocked(a)
    const available = this.accounts.filter((a) => {
      if (overageBlocked(a)) return false
      if (!a.isHealthy) {
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
    if (!selected) {
      const fallback = this.accounts
        .filter(
          (a) =>
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
      kiroDb.upsertAccount(a).catch((e) =>
        logger.warn('DB write failed', {
          method: 'updateUsage',
          email: a.email,
          error: e instanceof Error ? e.message : String(e)
        })
      )
    }
  }
  addAccount(a: ManagedAccount): void {
    const i = this.accounts.findIndex((x) => x.id === a.id)
    if (i === -1) this.accounts.push(a)
    else this.accounts[i] = a
    kiroDb.upsertAccount(a).catch((e) =>
      logger.warn('DB write failed', {
        method: 'addAccount',
        email: a.email,
        error: e instanceof Error ? e.message : String(e)
      })
    )
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
    const acc = this.accounts.find((x) => x.id === a.id)
    if (acc) {
      acc.accessToken = auth.access
      acc.expiresAt = auth.expires
      acc.lastUsed = Date.now()
      if (auth.email) acc.email = auth.email
      const p = decodeRefreshToken(auth.refresh)
      acc.refreshToken = p.refreshToken
      if (p.profileArn) acc.profileArn = p.profileArn
      if (p.clientId) acc.clientId = p.clientId
      acc.failCount = 0
      acc.isHealthy = true
      delete acc.unhealthyReason
      delete acc.recoveryTime
      kiroDb.upsertAccount(acc).catch((e) =>
        logger.warn('DB write failed', {
          method: 'updateFromAuth',
          email: acc.email,
          error: e instanceof Error ? e.message : String(e)
        })
      )
      writeToKiroCli(acc).catch((e) =>
        logger.warn('CLI write failed', {
          method: 'updateFromAuth',
          email: acc.email,
          error: e instanceof Error ? e.message : String(e)
        })
      )
    }
  }
  markRateLimited(a: ManagedAccount, ms: number): void {
    const acc = this.accounts.find((x) => x.id === a.id)
    if (acc) {
      acc.rateLimitResetTime = Date.now() + ms
      kiroDb.upsertAccount(acc).catch((e) =>
        logger.warn('DB write failed', {
          method: 'markRateLimited',
          email: acc.email,
          error: e instanceof Error ? e.message : String(e)
        })
      )
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

    kiroDb.upsertAccount(acc).catch((e) =>
      logger.warn('DB write failed', {
        method: 'markUnhealthy',
        email: acc.email,
        error: e instanceof Error ? e.message : String(e)
      })
    )
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
