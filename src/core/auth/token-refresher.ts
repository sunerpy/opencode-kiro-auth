import type { AccountRepository } from '../../infrastructure/database/account-repository'
import { accessTokenExpired } from '../../kiro/auth'
import type { AccountManager } from '../../plugin/accounts'
import { KiroTokenRefreshError } from '../../plugin/errors'
import { isRefreshTokenDead, toDeadReason } from '../../plugin/health'
import * as logger from '../../plugin/logger'
import { withRefreshLock } from '../../plugin/storage/locked-operations'
import { refreshAccessToken } from '../../plugin/token'
import type { KiroAuthDetails, ManagedAccount } from '../../plugin/types'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

const DEAD_TOAST_DEBOUNCE_MS = 60000

type LatestAuthRead = {
  readonly latestAccount: ManagedAccount | null
  readonly latestAuth: KiroAuthDetails | null
}

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
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly lastDeadToastAt = new Map<string, number>()

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
      await this.startOrJoinRefresh(account, () => auth)
      return { account, shouldContinue: false }
    } catch (e) {
      return await this.handleRefreshError(e, account, showToast)
    }
  }

  async forceRefresh(
    account: ManagedAccount,
    showToast: ToastFunction
  ): Promise<ForceRefreshResult> {
    try {
      await this.startOrJoinRefresh(account, () => this.accountManager.toAuthDetails(account))
      return { ok: true, dead: false }
    } catch (e) {
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

  private startOrJoinRefresh(
    account: ManagedAccount,
    getAuthFallback: () => KiroAuthDetails
  ): Promise<void> {
    const existing = this.inFlight.get(account.id)
    if (existing) {
      return existing
    }

    // The first in-process caller supplies the fallback auth for this shared
    // refresh. A2 re-reads the latest DB row inside the lock, so the fallback is
    // only used when that row is missing; joiners keep their own try/catch and
    // preserve their method-specific error handling.
    const refresh = this.runLockedRefresh(account, getAuthFallback).finally(() => {
      if (this.inFlight.get(account.id) === refresh) {
        this.inFlight.delete(account.id)
      }
    })
    this.inFlight.set(account.id, refresh)
    return refresh
  }

  private async runLockedRefresh(
    account: ManagedAccount,
    getAuthFallback: () => KiroAuthDetails
  ): Promise<void> {
    await withRefreshLock(account.id, async () => {
      const { latestAuth } = await this.readLatestAuth(account)
      if (latestAuth && !accessTokenExpired(latestAuth, this.config.token_expiry_buffer_ms)) {
        this.accountManager.updateFromAuth(account, latestAuth)
        return
      }

      const newAuth = await refreshAccessToken(latestAuth ?? getAuthFallback())
      this.accountManager.updateFromAuth(account, newAuth)
      await this.repository.batchSave(this.accountManager.getAccounts())
    })
  }

  private async readLatestAuth(account: ManagedAccount): Promise<LatestAuthRead> {
    this.repository.invalidateCache()
    const accounts: ManagedAccount[] = await this.repository.findAll()
    const latestAccount = accounts.find((a) => a.id === account.id) ?? null

    if (!latestAccount) {
      return { latestAccount: null, latestAuth: null }
    }

    account.email = latestAccount.email
    account.authMethod = latestAccount.authMethod
    account.region = latestAccount.region
    if (latestAccount.oidcRegion !== undefined) {
      account.oidcRegion = latestAccount.oidcRegion
    } else {
      delete account.oidcRegion
    }
    if (latestAccount.clientId !== undefined) {
      account.clientId = latestAccount.clientId
    } else {
      delete account.clientId
    }
    if (latestAccount.clientSecret !== undefined) {
      account.clientSecret = latestAccount.clientSecret
    } else {
      delete account.clientSecret
    }
    if (latestAccount.profileArn !== undefined) {
      account.profileArn = latestAccount.profileArn
    } else {
      delete account.profileArn
    }
    account.refreshToken = latestAccount.refreshToken
    account.accessToken = latestAccount.accessToken
    account.expiresAt = latestAccount.expiresAt

    return {
      latestAccount,
      latestAuth: this.accountManager.toAuthDetails(account)
    }
  }

  private async handleRefreshError(
    error: unknown,
    account: ManagedAccount,
    showToast: ToastFunction
  ): Promise<{ account: ManagedAccount; shouldContinue: boolean }> {
    const message = error instanceof Error ? error.message : String(error)
    logger.error('Token refresh failed', {
      email: account.email,
      code: error instanceof KiroTokenRefreshError ? error.code : undefined,
      message
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
      this.accountManager.markUnhealthy(account, toDeadReason(message))
      await this.repository.batchSave(this.accountManager.getAccounts())
      const now = Date.now()
      const lastToastAt = this.lastDeadToastAt.get(account.id) ?? 0
      if (now - lastToastAt >= DEAD_TOAST_DEBOUNCE_MS) {
        showToast(
          `Kiro account ${account.email} sign-in expired — run "opencode auth login" and select kiro-auth to re-authenticate.`,
          'warning'
        )
        this.lastDeadToastAt.set(account.id, now)
      }
      return { account, shouldContinue: true }
    }

    logger.error('Token refresh unrecoverable', {
      email: account.email,
      code: error instanceof KiroTokenRefreshError ? error.code : undefined,
      message
    })
    throw error
  }
}
