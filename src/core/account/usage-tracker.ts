import type { AccountRepository } from '../../infrastructure/database/account-repository'
import type { AccountManager } from '../../plugin/accounts'
import * as logger from '../../plugin/logger'
import type { KiroAuthDetails, ManagedAccount } from '../../plugin/types'
import { fetchUsageLimits, updateAccountQuota } from '../../plugin/usage'

interface UsageTrackerConfig {
  usage_tracking_enabled: boolean
  usage_sync_max_retries: number
  usage_sync_cooldown_ms?: number
}

export class UsageTracker {
  private lastSyncTime = new Map<string, number>()
  private readonly cooldownMs: number

  constructor(
    private config: UsageTrackerConfig,
    private accountManager: AccountManager,
    private repository: AccountRepository
  ) {
    this.cooldownMs = config.usage_sync_cooldown_ms ?? 60000
  }

  async syncUsage(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    isValid: () => boolean = () => true
  ): Promise<void> {
    if (!this.config.usage_tracking_enabled) return
    if (!isValid()) return

    const last = this.lastSyncTime.get(account.id) ?? 0
    if (Date.now() - last < this.cooldownMs) return

    this.lastSyncTime.set(account.id, Date.now())
    this.syncWithRetry(account, auth, 0, isValid).catch((e) => {
      logger.warn('Usage sync failed after all retries', {
        accountId: account.id,
        error: e instanceof Error ? e.message : String(e)
      })
    })
  }

  private async syncWithRetry(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    attempt: number,
    isValid: () => boolean
  ): Promise<void> {
    try {
      const u = await fetchUsageLimits(auth)
      if (!isValid()) return
      updateAccountQuota(account, u, this.accountManager)
      if (!isValid()) return
      await this.repository.batchSave(this.accountManager.getAccounts())
    } catch (e: any) {
      if (!isValid()) return
      if (attempt < this.config.usage_sync_max_retries) {
        await this.sleep(1000 * Math.pow(2, attempt))
        if (!isValid()) return
        return this.syncWithRetry(account, auth, attempt + 1, isValid)
      }

      if (e.message?.includes('FEATURE_NOT_SUPPORTED')) {
        // Some IDC profiles don't support getUsageLimits; don't penalize the account.
        return
      }

      if (
        e.message?.includes('403') ||
        e.message?.includes('invalid') ||
        e.message?.includes('bearer token')
      ) {
        if (!isValid()) return
        this.accountManager.markUnhealthy(account, e.message)
        if (!isValid()) return
        this.repository.save(account).catch(() => {})
      }

      throw e
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }
}
