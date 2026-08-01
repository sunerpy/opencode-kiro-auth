import { accessTokenExpired } from '../../kiro/auth'
import type { AccountManager } from '../../plugin/accounts'
import { isPermanentError } from '../../plugin/health'
import * as logger from '../../plugin/logger'
import { tryAcquireKeepAliveLock } from '../../plugin/storage/locked-operations'
import type { KiroAuthDetails, ManagedAccount } from '../../plugin/types'
import { fetchUsageLimits, updateAccountQuota } from '../../plugin/usage'
import type { TokenRefresher } from '../auth/token-refresher'

const USAGE_FETCH_CONCURRENCY = 4
// Manual auth-menu refreshes get a generous bound while still guaranteeing
// that an unresponsive usage endpoint cannot freeze the TTY indefinitely.
const MANUAL_REFRESH_DEADLINE_MULTIPLIER = 6
const noopToast = (): void => {}

type UsageSnapshot = Awaited<ReturnType<typeof fetchUsageLimits>>
type LockRelease = () => Promise<void>

export type RefreshAllSkipReason = 'cooldown' | 'lock_unavailable'
export type AccountTokenRefreshStatus =
  'renewed' | 'not_needed' | 'skipped_unhealthy' | 'failed' | 'timeout' | 'aborted'
export type AccountUsageRefreshStatus = 'updated' | 'failed' | 'timeout' | 'aborted'

export interface AccountRefreshResult {
  readonly accountId: string
  readonly email: string
  readonly before: {
    readonly usedCount: number
    readonly limitCount: number
  }
  readonly after: {
    readonly usedCount: number
    readonly limitCount: number
  }
  readonly tokenStatus: AccountTokenRefreshStatus
  readonly usageStatus: AccountUsageRefreshStatus
  readonly error?: string
}

export interface RefreshAllSummary {
  readonly startedAt: number
  readonly completedAt: number
  readonly totalAccounts: number
  readonly tokenRenewed: number
  readonly tokenSkipped: number
  readonly usageUpdated: number
  readonly failed: number
  readonly timedOut: boolean
  readonly skippedReason?: RefreshAllSkipReason
  readonly lockAcquired: boolean
  readonly proceededWithoutLock: boolean
  readonly accounts: readonly AccountRefreshResult[]
}

export interface RefreshAllOptions {
  readonly force?: boolean
  readonly deadlineMs?: number
  readonly signal?: AbortSignal
}

interface AccountRefreshConfig {
  readonly refresh_all_cooldown_ms: number
  readonly refresh_all_deadline_ms: number
  readonly token_expiry_buffer_ms: number
}

interface AccountRefreshManager {
  getAccounts(): ManagedAccount[]
  toAuthDetails(account: ManagedAccount): KiroAuthDetails
  updateUsage(
    id: string,
    meta: UsageSnapshot & {
      lastSync: number
    }
  ): void
}

interface TokenRefreshPort {
  refreshIfNeeded(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    showToast: typeof noopToast
  ): Promise<{ account: ManagedAccount; shouldContinue: boolean }>
}

interface AccountRefreshDependencies {
  readonly fetchUsageLimits: (auth: KiroAuthDetails, signal?: AbortSignal) => Promise<UsageSnapshot>
  readonly tryAcquireKeepAliveLock: () => Promise<LockRelease | null>
  readonly now: () => number
}

interface RefreshScope {
  readonly signal: AbortSignal
  readonly timedOut: () => boolean
  readonly cleanup: () => void
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function createRefreshScope(
  parent: AbortSignal | undefined,
  deadlineMs: number | undefined
): RefreshScope {
  const controller = new AbortController()
  let deadlineReached = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const abortFromParent = (): void => controller.abort(parent?.reason)

  if (parent?.aborted) {
    abortFromParent()
  } else {
    parent?.addEventListener('abort', abortFromParent, { once: true })
  }

  if (deadlineMs !== undefined) {
    timer = setTimeout(() => {
      deadlineReached = true
      controller.abort(new DOMException('Account refresh deadline exceeded', 'TimeoutError'))
    }, deadlineMs)
  }

  return {
    signal: controller.signal,
    timedOut: () => deadlineReached,
    cleanup: () => {
      if (timer) clearTimeout(timer)
      parent?.removeEventListener('abort', abortFromParent)
    }
  }
}

function waitForCompletionOrAbort(operation: Promise<void>, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)

  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (completed: boolean): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(completed)
    }
    const onAbort = (): void => finish(false)
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      () => finish(true),
      (error) => {
        logger.error('Kiro account refresh pass failed', { error: normalizeError(error) })
        finish(true)
      }
    )
  })
}

export class AccountRefreshService {
  private readonly inFlight = new Map<boolean, Promise<RefreshAllSummary>>()
  private lastSuccessfulRefreshAt = 0
  private readonly dependencies: AccountRefreshDependencies

  constructor(
    private readonly config: AccountRefreshConfig,
    private readonly accountManager: AccountRefreshManager,
    private readonly tokenRefresher: TokenRefreshPort,
    dependencies: Partial<AccountRefreshDependencies> = {}
  ) {
    this.dependencies = {
      fetchUsageLimits: dependencies.fetchUsageLimits ?? fetchUsageLimits,
      tryAcquireKeepAliveLock: dependencies.tryAcquireKeepAliveLock ?? tryAcquireKeepAliveLock,
      now: dependencies.now ?? Date.now
    }
  }

  refreshAll(options: RefreshAllOptions = {}): Promise<RefreshAllSummary> {
    const force = options.force === true
    // A forced pass can satisfy either caller. An automatic pass can only
    // satisfy another automatic caller because it may legitimately skip.
    const compatible = this.inFlight.get(force) ?? (!force ? this.inFlight.get(true) : undefined)
    if (compatible) return compatible

    const refresh = this.runRefresh(this.accountManager.getAccounts(), options).then((summary) => {
      if (
        !summary.skippedReason &&
        !summary.timedOut &&
        summary.failed === 0 &&
        !options.signal?.aborted
      ) {
        this.lastSuccessfulRefreshAt = this.dependencies.now()
      }
      return summary
    })
    const tracked = refresh.finally(() => {
      if (this.inFlight.get(force) === tracked) this.inFlight.delete(force)
    })
    this.inFlight.set(force, tracked)
    return tracked
  }

  refreshAccount(
    accountId: string,
    options: RefreshAllOptions = { force: true }
  ): Promise<RefreshAllSummary> {
    const account = this.accountManager
      .getAccounts()
      .find((candidate) => candidate.id === accountId)
    return this.runRefresh(account ? [account] : [], { ...options, force: options.force ?? true })
  }

  private async runRefresh(
    accounts: ManagedAccount[],
    options: RefreshAllOptions
  ): Promise<RefreshAllSummary> {
    const startedAt = this.dependencies.now()
    const force = options.force === true
    if (
      !force &&
      this.lastSuccessfulRefreshAt > 0 &&
      startedAt - this.lastSuccessfulRefreshAt < this.config.refresh_all_cooldown_ms
    ) {
      return this.emptySummary(startedAt, accounts.length, 'cooldown')
    }

    if (accounts.length === 0) {
      return this.emptySummary(startedAt, 0)
    }

    const defaultDeadlineMs =
      this.config.refresh_all_deadline_ms * (force ? MANUAL_REFRESH_DEADLINE_MULTIPLIER : 1)
    const scope = createRefreshScope(options.signal, options.deadlineMs ?? defaultDeadlineMs)
    let release: LockRelease | null = null
    let lockAcquired = false
    let proceededWithoutLock = false
    const results = new Map<string, AccountRefreshResult>()

    try {
      release = await this.dependencies.tryAcquireKeepAliveLock()
      lockAcquired = release !== null
      if (!release && !force) {
        return this.emptySummary(startedAt, accounts.length, 'lock_unavailable')
      }
      proceededWithoutLock = !release

      const operation = this.refreshAccounts(accounts, results, scope.signal)
      const completed = await waitForCompletionOrAbort(operation, scope.signal)
      if (!completed) {
        void operation.catch(() => {})
      }

      const timedOut = scope.timedOut()
      const terminalStatus = timedOut ? 'timeout' : 'aborted'
      for (const account of accounts) {
        if (!results.has(account.id)) {
          results.set(
            account.id,
            this.terminalResult(
              account,
              terminalStatus,
              timedOut ? 'Account refresh timed out.' : 'Account refresh was aborted.'
            )
          )
        }
      }

      return this.buildSummary(
        startedAt,
        accounts,
        results,
        timedOut,
        lockAcquired,
        proceededWithoutLock
      )
    } finally {
      scope.cleanup()
      if (release) {
        try {
          await release()
        } catch (error) {
          logger.warn('Failed to release Kiro account refresh leader lock', {
            error: normalizeError(error)
          })
        }
      }
    }
  }

  private async refreshAccounts(
    accounts: ManagedAccount[],
    results: Map<string, AccountRefreshResult>,
    signal: AbortSignal
  ): Promise<void> {
    let nextIndex = 0
    const worker = async (): Promise<void> => {
      while (!signal.aborted) {
        const account = accounts[nextIndex++]
        if (!account) return
        const result = await this.refreshOne(account, signal)
        results.set(account.id, result)
      }
    }
    const workerCount = Math.min(USAGE_FETCH_CONCURRENCY, accounts.length)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
  }

  private async refreshOne(
    account: ManagedAccount,
    signal: AbortSignal
  ): Promise<AccountRefreshResult> {
    const before = this.usageCounts(account)
    let tokenStatus: AccountTokenRefreshStatus = 'not_needed'
    const errors: string[] = []

    if (!account.isHealthy || isPermanentError(account.unhealthyReason)) {
      tokenStatus = 'skipped_unhealthy'
      errors.push('Token refresh skipped: account needs re-login.')
    } else {
      const auth = this.accountManager.toAuthDetails(account)
      if (accessTokenExpired(auth, this.config.token_expiry_buffer_ms)) {
        const previousAccessToken = account.accessToken
        const previousExpiry = account.expiresAt
        try {
          const result = await this.tokenRefresher.refreshIfNeeded(account, auth, noopToast)
          if (result.shouldContinue) {
            tokenStatus = 'failed'
            errors.push('Token refresh did not complete.')
          } else if (
            account.accessToken !== previousAccessToken ||
            account.expiresAt !== previousExpiry
          ) {
            tokenStatus = 'renewed'
          }
        } catch (error) {
          tokenStatus = 'failed'
          errors.push(`Token refresh failed: ${normalizeError(error)}`)
        }
      }
    }

    if (signal.aborted) {
      const status =
        signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
          ? 'timeout'
          : 'aborted'
      return {
        accountId: account.id,
        email: account.email,
        before,
        after: this.usageCounts(account),
        tokenStatus,
        usageStatus: status,
        error: [
          ...errors,
          status === 'timeout' ? 'Usage refresh timed out.' : 'Usage refresh aborted.'
        ].join(' ')
      }
    }

    let usageStatus: AccountUsageRefreshStatus = 'updated'
    try {
      const auth = this.accountManager.toAuthDetails(account)
      const usage = await this.dependencies.fetchUsageLimits(auth, signal)
      if (signal.aborted) {
        usageStatus =
          signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
            ? 'timeout'
            : 'aborted'
      } else {
        updateAccountQuota(account, usage, this.accountManager)
      }
    } catch (error) {
      if (signal.aborted) {
        usageStatus =
          signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
            ? 'timeout'
            : 'aborted'
      } else {
        usageStatus = 'failed'
        errors.push(`Usage refresh failed: ${normalizeError(error)}`)
      }
    }

    if (usageStatus === 'timeout') errors.push('Usage refresh timed out.')
    if (usageStatus === 'aborted') errors.push('Usage refresh aborted.')
    return {
      accountId: account.id,
      email: account.email,
      before,
      after: this.usageCounts(account),
      tokenStatus,
      usageStatus,
      ...(errors.length > 0 ? { error: errors.join(' ') } : {})
    }
  }

  private usageCounts(account: ManagedAccount): { usedCount: number; limitCount: number } {
    return {
      usedCount: account.usedCount ?? 0,
      limitCount: account.limitCount ?? 0
    }
  }

  private terminalResult(
    account: ManagedAccount,
    status: 'timeout' | 'aborted',
    error: string
  ): AccountRefreshResult {
    const counts = this.usageCounts(account)
    return {
      accountId: account.id,
      email: account.email,
      before: counts,
      after: counts,
      tokenStatus: status,
      usageStatus: status,
      error
    }
  }

  private buildSummary(
    startedAt: number,
    accounts: ManagedAccount[],
    results: Map<string, AccountRefreshResult>,
    timedOut: boolean,
    lockAcquired: boolean,
    proceededWithoutLock: boolean
  ): RefreshAllSummary {
    const accountResults = accounts.map((account) => results.get(account.id)!).filter(Boolean)
    const failed = accountResults.filter(
      (result) =>
        !['renewed', 'not_needed'].includes(result.tokenStatus) || result.usageStatus !== 'updated'
    ).length
    return {
      startedAt,
      completedAt: this.dependencies.now(),
      totalAccounts: accounts.length,
      tokenRenewed: accountResults.filter((result) => result.tokenStatus === 'renewed').length,
      tokenSkipped: accountResults.filter((result) => result.tokenStatus !== 'renewed').length,
      usageUpdated: accountResults.filter((result) => result.usageStatus === 'updated').length,
      failed,
      timedOut,
      lockAcquired,
      proceededWithoutLock,
      accounts: accountResults
    }
  }

  private emptySummary(
    startedAt: number,
    totalAccounts: number,
    skippedReason?: RefreshAllSkipReason
  ): RefreshAllSummary {
    return {
      startedAt,
      completedAt: this.dependencies.now(),
      totalAccounts,
      tokenRenewed: 0,
      tokenSkipped: 0,
      usageUpdated: 0,
      failed: 0,
      timedOut: false,
      ...(skippedReason ? { skippedReason } : {}),
      lockAcquired: false,
      proceededWithoutLock: false,
      accounts: []
    }
  }
}

export type AccountRefreshServiceAccountManager = Pick<
  AccountManager,
  'getAccounts' | 'toAuthDetails' | 'updateUsage'
>
export type AccountRefreshServiceTokenRefresher = Pick<TokenRefresher, 'refreshIfNeeded'>
