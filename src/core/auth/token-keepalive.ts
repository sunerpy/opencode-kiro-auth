import type { AccountRepository } from '../../infrastructure/database/account-repository'
import { accessTokenExpired } from '../../kiro/auth'
import type { AccountManager } from '../../plugin/accounts'
import { isPermanentError } from '../../plugin/health'
import * as logger from '../../plugin/logger'
import { tryAcquireKeepAliveLock } from '../../plugin/storage/locked-operations'
import type { ManagedAccount } from '../../plugin/types'
import type { TokenRefresher } from './token-refresher'

type ToastVariant = 'info' | 'warning' | 'success' | 'error'
type ToastFunction = (message: string, variant: ToastVariant) => void
type LockRelease = () => Promise<void>
type TimeoutHandle = ReturnType<typeof setTimeout>
type IntervalHandle = ReturnType<typeof setInterval>
type TimerHandle = TimeoutHandle | IntervalHandle

export interface KeepAliveConfig {
  readonly token_keepalive_enabled: boolean
  readonly token_keepalive_interval_ms: number
  readonly token_expiry_buffer_ms: number
}

const INITIAL_TICK_DELAY_MS = 5000
const noopToast: ToastFunction = () => {}

type UnrefTimer = {
  readonly unref: () => void
}

function hasUnref(timer: TimerHandle): timer is TimerHandle & UnrefTimer {
  return typeof timer === 'object' && timer !== null && 'unref' in timer
}

function unrefTimer(timer: TimerHandle): void {
  if (hasUnref(timer)) {
    timer.unref()
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export class KeepAliveController {
  private initialDelayTimer: TimeoutHandle | null = null
  private intervalTimer: IntervalHandle | null = null
  private running = false
  private disposed = false
  private activeLeaderLockRelease: LockRelease | null = null

  constructor(
    private readonly config: KeepAliveConfig,
    private readonly accountManager: AccountManager,
    private readonly tokenRefresher: TokenRefresher,
    private readonly repository: AccountRepository
  ) {}

  start(): void {
    if (!this.config.token_keepalive_enabled) {
      return
    }
    if (this.initialDelayTimer || this.intervalTimer) {
      return
    }

    this.disposed = false
    this.initialDelayTimer = setTimeout(() => {
      this.initialDelayTimer = null
      void this.tick()
    }, INITIAL_TICK_DELAY_MS)
    this.intervalTimer = setInterval(() => {
      void this.tick()
    }, this.config.token_keepalive_interval_ms)

    unrefTimer(this.initialDelayTimer)
    unrefTimer(this.intervalTimer)
  }

  dispose(): void {
    this.disposed = true
    if (this.initialDelayTimer) {
      clearTimeout(this.initialDelayTimer)
      this.initialDelayTimer = null
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer)
      this.intervalTimer = null
    }
    void this.releaseLeaderLock()
  }

  async runOnceForTest(): Promise<void> {
    await this.tick()
  }

  private async tick(): Promise<void> {
    if (this.disposed) {
      return
    }
    if (this.running) {
      logger.debug('Kiro token keep-alive tick skipped because previous tick is still running')
      return
    }

    this.running = true
    try {
      const release = await tryAcquireKeepAliveLock()
      if (!release) {
        return
      }

      this.activeLeaderLockRelease = release
      try {
        await this.refreshNearExpiryAccounts()
      } finally {
        await this.releaseLeaderLock()
      }
    } catch (error) {
      logger.error('Kiro token keep-alive tick failed', normalizeError(error))
    } finally {
      this.running = false
    }
  }

  private async refreshNearExpiryAccounts(): Promise<void> {
    this.repository.invalidateCache()
    const accounts = this.accountManager.getAccounts()
    for (const account of accounts) {
      if (this.disposed) {
        return
      }

      try {
        await this.refreshAccountIfNeeded(account)
      } catch (error) {
        logger.error('Kiro token keep-alive account refresh failed', {
          email: account.email,
          message: normalizeError(error).message
        })
      }
    }
  }

  private async refreshAccountIfNeeded(account: ManagedAccount): Promise<void> {
    if (!account.isHealthy || isPermanentError(account.unhealthyReason)) {
      return
    }

    const auth = this.accountManager.toAuthDetails(account)
    if (!accessTokenExpired(auth, this.config.token_expiry_buffer_ms)) {
      return
    }

    await this.tokenRefresher.refreshIfNeeded(account, auth, noopToast)
  }

  private async releaseLeaderLock(): Promise<void> {
    const release = this.activeLeaderLockRelease
    if (!release) {
      return
    }

    this.activeLeaderLockRelease = null
    try {
      await release()
    } catch (error) {
      logger.warn('Failed to release Kiro token keep-alive leader lock', normalizeError(error))
    }
  }
}
