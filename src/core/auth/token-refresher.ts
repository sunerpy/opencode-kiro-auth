import type { AccountRepository } from '../../infrastructure/database/account-repository'
import { accessTokenExpired } from '../../kiro/auth'
import type { AccountManager } from '../../plugin/accounts'
import { KiroTokenRefreshError } from '../../plugin/errors'
import { isRefreshTokenDead, toDeadReason } from '../../plugin/health'
import * as logger from '../../plugin/logger'
import { refreshAccessToken } from '../../plugin/token'
import type { KiroAuthDetails, ManagedAccount } from '../../plugin/types'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

interface TokenRefresherConfig {
  token_expiry_buffer_ms: number
  auto_sync_kiro_cli: boolean
  account_selection_strategy: 'sticky' | 'round-robin' | 'lowest-usage'
}

/** Outcome of a forced refresh; `dead` distinguishes refresh-token-dead
 *  (needs re-login) from a transient failure (network/5xx). */
export interface ForceRefreshResult {
  ok: boolean
  dead: boolean
}

/**
 * Decide whether a refresh failure means the refresh token / OIDC client is
 * dead (permanent, needs re-login) or is merely transient (network/5xx).
 * A missing/unusable-credential decode error (e.g. a corrupted refresh_token
 * that never reaches the wire, or an empty response) is treated as dead:
 * the stored credentials are unusable, so the account needs a re-login.
 */
export function isRefreshErrorDead(error: unknown): boolean {
  if (error instanceof KiroTokenRefreshError) {
    if (error.code === 'MISSING_CREDENTIALS' || error.code === 'INVALID_RESPONSE') {
      return true
    }
    if (error.code === 'NETWORK_ERROR') {
      return false
    }
    if (error.code && isRefreshTokenDead(error.code)) {
      return true
    }
    return isRefreshTokenDead(error.message)
  }
  const message = error instanceof Error ? error.message : String(error)
  // Unusable stored credentials (missing/short/malformed refresh material that
  // fails to encode or decode) are dead: the account needs a re-login.
  if (message.includes('Missing credentials') || message.includes('Missing creds')) {
    return true
  }
  return isRefreshTokenDead(message)
}

export class TokenRefresher {
  constructor(
    private config: TokenRefresherConfig,
    private accountManager: AccountManager,
    private syncFromKiroCli: () => Promise<void>,
    private repository: AccountRepository
  ) {}

  async refreshIfNeeded(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    showToast: ToastFunction
  ): Promise<{ account: ManagedAccount; shouldContinue: boolean }> {
    if (!accessTokenExpired(auth, this.config.token_expiry_buffer_ms)) {
      return { account, shouldContinue: false }
    }

    try {
      const newAuth = await refreshAccessToken(auth)
      this.accountManager.updateFromAuth(account, newAuth)
      await this.repository.batchSave(this.accountManager.getAccounts())
      return { account, shouldContinue: false }
    } catch (e: any) {
      return await this.handleRefreshError(e, account, showToast)
    }
  }

  async forceRefresh(
    account: ManagedAccount,
    showToast: ToastFunction
  ): Promise<ForceRefreshResult> {
    try {
      const auth = this.accountManager.toAuthDetails(account)
      const newAuth = await refreshAccessToken(auth)
      this.accountManager.updateFromAuth(account, newAuth)
      await this.repository.batchSave(this.accountManager.getAccounts())
      return { ok: true, dead: false }
    } catch (e: any) {
      const dead = isRefreshErrorDead(e)
      logger.error('Forced token refresh failed', {
        email: account.email,
        code: e instanceof KiroTokenRefreshError ? e.code : undefined,
        message: e instanceof Error ? e.message : String(e),
        dead
      })
      showToast('403: Token refresh failed after stale-token detection.', 'warning')
      return { ok: false, dead }
    }
  }

  private async handleRefreshError(
    error: any,
    account: ManagedAccount,
    showToast: ToastFunction
  ): Promise<{ account: ManagedAccount; shouldContinue: boolean }> {
    logger.error('Token refresh failed', {
      email: account.email,
      code: error instanceof KiroTokenRefreshError ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error)
    })
    if (this.config.auto_sync_kiro_cli) {
      await this.syncFromKiroCli()
    }

    this.repository.invalidateCache()
    const accounts = await this.repository.findAll()
    const stillAcc = accounts.find((a: ManagedAccount) => a.id === account.id)

    if (
      stillAcc &&
      !accessTokenExpired(
        this.accountManager.toAuthDetails(stillAcc),
        this.config.token_expiry_buffer_ms
      )
    ) {
      showToast('Credentials recovered from Kiro CLI sync.', 'info')
      return { account: stillAcc, shouldContinue: true }
    }

    // Mark unhealthy ONLY when the refresh token itself is dead. A transient
    // failure (network / 5xx) leaves the account healthy so it can retry.
    if (isRefreshErrorDead(error)) {
      this.accountManager.markUnhealthy(account, toDeadReason(error.message))
      await this.repository.batchSave(this.accountManager.getAccounts())
      return { account, shouldContinue: true }
    }

    logger.error('Token refresh unrecoverable', {
      email: account.email,
      code: error instanceof KiroTokenRefreshError ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}
