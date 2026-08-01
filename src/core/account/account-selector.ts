import type { AccountRepository } from '../../infrastructure/database/account-repository'
import type { AccountManager } from '../../plugin/accounts'
import * as logger from '../../plugin/logger'
import type { ManagedAccount } from '../../plugin/types'
import type { AccountRefreshService } from './account-refresh-service'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

interface AccountSelectorConfig {
  auto_sync_kiro_cli: boolean
  account_selection_strategy: 'sticky' | 'round-robin' | 'lowest-usage'
  refresh_before_switch_enabled?: boolean
  refresh_all_deadline_ms?: number
}

export class AccountSelector {
  private triedEmptySync = false
  private circuitBreakerTrips = 0
  private lastCircuitBreakerReset = Date.now()

  constructor(
    private accountManager: AccountManager,
    private config: AccountSelectorConfig,
    private syncFromKiroCli: () => Promise<void>,
    private repository: AccountRepository,
    private accountRefreshService?: Pick<AccountRefreshService, 'refreshAll'>
  ) {}

  async selectHealthyAccount(
    showToast: ToastFunction,
    signal?: AbortSignal
  ): Promise<ManagedAccount | null> {
    this.checkCircuitBreaker()

    let count = this.accountManager.getAccountCount()

    if (count === 0 && this.config.auto_sync_kiro_cli && !this.triedEmptySync) {
      this.triedEmptySync = true
      await this.handleEmptyAccounts()
      count = this.accountManager.getAccountCount()
    }

    if (count === 0) {
      throw new Error('No accounts')
    }

    let acc = this.accountManager.getCurrentOrNext()

    if (!acc) {
      this.circuitBreakerTrips++
      if (this.accountManager.allSelectableBlockedByOverage()) {
        throw new Error(
          'All accounts have exceeded their free quota and entered paid overage. Set "stop_on_overage": false in ~/.config/opencode/kiro-auth-plugin/kiro.json to continue with paid overage, or wait for the quota to reset.'
        )
      }
      const wait = this.accountManager.getMinWaitTime()
      if (wait > 0 && wait < 30000) {
        if (this.accountManager.shouldShowToast()) {
          showToast(`All accounts rate-limited. Waiting ${Math.ceil(wait / 1000)}s...`, 'warning')
        }
        await this.sleep(wait, signal)
        return null
      }
      throw new Error('All accounts are unhealthy or rate-limited: reauth required')
    }

    this.resetCircuitBreaker()

    const used = acc.usedCount ?? 0
    const limit = acc.limitCount ?? 0
    if (limit > 0 && used / limit >= 0.9 && this.accountManager.shouldShowUsageToast()) {
      showToast(this.formatUsageMessage(used, limit, acc.email || ''), 'warning')
    }

    return acc
  }

  async selectAlternativeAccount(
    excludedIds: ReadonlySet<string>,
    signal?: AbortSignal
  ): Promise<ManagedAccount | null> {
    if (this.config.refresh_before_switch_enabled !== false && this.accountRefreshService) {
      try {
        await this.accountRefreshService.refreshAll({
          force: false,
          deadlineMs: this.config.refresh_all_deadline_ms ?? 5000,
          signal
        })
      } catch (error) {
        logger.warn('Kiro pre-switch account refresh failed; selecting with cached usage', {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    return this.accountManager.getCurrentOrNext({ excludedIds, recoverUnhealthy: false })
  }

  private async handleEmptyAccounts(): Promise<void> {
    await this.syncFromKiroCli()
    this.repository.invalidateCache()
    const accounts = await this.repository.findAll()
    for (const a of accounts) {
      this.accountManager.addAccount(a)
    }
  }

  private formatUsageMessage(usedCount: number, limitCount: number, email: string): string {
    if (limitCount > 0) {
      const percentage = Math.round((usedCount / limitCount) * 100)
      return `Usage (${email}): ${usedCount}/${limitCount} (${percentage}%)`
    }
    return `Usage (${email}): ${usedCount}`
  }

  private checkCircuitBreaker(): void {
    if (Date.now() - this.lastCircuitBreakerReset > 60000) {
      this.circuitBreakerTrips = 0
      this.lastCircuitBreakerReset = Date.now()
    }

    if (this.circuitBreakerTrips >= 10) {
      throw new Error('Circuit breaker tripped: Too many consecutive failures selecting accounts')
    }
  }

  private resetCircuitBreaker(): void {
    if (this.circuitBreakerTrips > 0) {
      this.circuitBreakerTrips = 0
      this.lastCircuitBreakerReset = Date.now()
    }
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    let onAbort: (() => void) | undefined
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      onAbort = (): void => {
        clearTimeout(timer)
        reject(signal?.reason)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    }).finally(() => {
      if (onAbort) signal?.removeEventListener('abort', onAbort)
    })
  }
}
