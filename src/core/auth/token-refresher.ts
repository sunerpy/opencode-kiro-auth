import type { AccountRepository } from '../../infrastructure/database/account-repository'
import { accessTokenExpired } from '../../kiro/auth'
import type { AccountManager } from '../../plugin/accounts'
import { KiroTokenRefreshError, TokenPersistenceError } from '../../plugin/errors'
import { isRefreshTokenDead, toDeadReason } from '../../plugin/health'
import * as logger from '../../plugin/logger'
import { withRefreshLock } from '../../plugin/storage/locked-operations'
import { refreshAccessToken } from '../../plugin/token'
import type { KiroAuthDetails, ManagedAccount } from '../../plugin/types'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

const DEAD_TOAST_DEBOUNCE_MS = 60000
const TOKEN_PERSISTENCE_MAX_ATTEMPTS = 3
const TOKEN_PERSISTENCE_RETRY_DELAY_MS = 250

type LatestAuthRead = {
  readonly latestAccount: ManagedAccount | null
  readonly latestAuth: KiroAuthDetails | null
}

interface TokenRefresherConfig {
  token_expiry_buffer_ms: number
  auto_sync_kiro_cli: boolean
  account_selection_strategy: 'sticky' | 'round-robin' | 'lowest-usage'
}

interface TokenRefresherDependencies {
  refreshAccessToken: typeof refreshAccessToken
  sleep: (delayMs: number) => Promise<void>
  random: () => number
}

function isTransientPersistenceError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code).toUpperCase()
      : ''
  const message = error instanceof Error ? error.message : String(error)
  return (
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_LOCKED' ||
    /SQLITE_(?:BUSY|LOCKED)|database is locked|lock file is already being held/i.test(message)
  )
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
  if (error instanceof TokenPersistenceError) {
    return false
  }
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
  private readonly pendingPersistence = new Map<string, ManagedAccount>()
  private readonly lastDeadToastAt = new Map<string, number>()
  private readonly refreshAccessToken: typeof refreshAccessToken
  private readonly sleep: (delayMs: number) => Promise<void>
  private readonly random: () => number

  constructor(
    private config: TokenRefresherConfig,
    private accountManager: AccountManager,
    private syncFromKiroCli: () => Promise<void>,
    private repository: AccountRepository,
    dependencies: Partial<TokenRefresherDependencies> = {}
  ) {
    this.refreshAccessToken = dependencies.refreshAccessToken ?? refreshAccessToken
    this.sleep = dependencies.sleep ?? defaultSleep
    this.random = dependencies.random ?? Math.random
  }

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
      if (e instanceof TokenPersistenceError) {
        logger.error('Forced token refresh persistence failed', { email: account.email })
        return { ok: false, dead: false }
      }

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
      const { latestAccount, latestAuth } = await this.readLatestAuth(account)
      if (
        latestAccount &&
        latestAuth &&
        !accessTokenExpired(latestAuth, this.config.token_expiry_buffer_ms)
      ) {
        this.pendingPersistence.delete(account.id)
        this.accountManager.publishAuthCandidate(latestAccount, false)
        return
      }

      const pendingCandidate = this.pendingPersistence.get(account.id)
      if (pendingCandidate) {
        await this.persistRefreshedAccount(pendingCandidate)
        this.pendingPersistence.delete(account.id)
        this.accountManager.publishAuthCandidate(pendingCandidate)
        return
      }

      const newAuth = await this.refreshAccessToken(latestAuth ?? getAuthFallback())
      const candidate = this.accountManager.createAuthCandidate(latestAccount ?? account, newAuth)
      this.pendingPersistence.set(account.id, candidate)
      await this.persistRefreshedAccount(candidate)
      this.pendingPersistence.delete(account.id)
      this.accountManager.publishAuthCandidate(candidate)
    })
  }

  private async persistRefreshedAccount(candidate: ManagedAccount): Promise<void> {
    for (let attempt = 1; attempt <= TOKEN_PERSISTENCE_MAX_ATTEMPTS; attempt++) {
      try {
        await this.repository.save(candidate)
        return
      } catch (error) {
        const retryable = isTransientPersistenceError(error)
        if (!retryable || attempt === TOKEN_PERSISTENCE_MAX_ATTEMPTS) {
          throw new TokenPersistenceError()
        }

        logger.warn('Token persistence failed; retrying', {
          email: candidate.email,
          attempt,
          maxAttempts: TOKEN_PERSISTENCE_MAX_ATTEMPTS
        })
        const jitter = Math.floor(TOKEN_PERSISTENCE_RETRY_DELAY_MS * 0.25 * this.random())
        await this.sleep(TOKEN_PERSISTENCE_RETRY_DELAY_MS * attempt + jitter)
      }
    }
  }

  private async readLatestAuth(account: ManagedAccount): Promise<LatestAuthRead> {
    this.repository.invalidateCache()
    const accounts: ManagedAccount[] = await this.repository.findAll()
    const latestAccount = accounts.find((a) => a.id === account.id) ?? null

    if (!latestAccount) {
      return { latestAccount: null, latestAuth: null }
    }

    this.syncPersistedAccountReference(account, latestAccount)

    return {
      latestAccount,
      latestAuth: this.accountManager.toAuthDetails(account)
    }
  }

  private syncPersistedAccountReference(
    account: ManagedAccount,
    latestAccount: ManagedAccount
  ): void {
    account.email = latestAccount.email
    account.authMethod = latestAccount.authMethod
    account.region = latestAccount.region
    if (latestAccount.oidcRegion === undefined) delete account.oidcRegion
    else account.oidcRegion = latestAccount.oidcRegion
    if (latestAccount.clientId === undefined) delete account.clientId
    else account.clientId = latestAccount.clientId
    if (latestAccount.clientSecret === undefined) delete account.clientSecret
    else account.clientSecret = latestAccount.clientSecret
    if (latestAccount.profileArn === undefined) delete account.profileArn
    else account.profileArn = latestAccount.profileArn
    account.refreshToken = latestAccount.refreshToken
    account.accessToken = latestAccount.accessToken
    account.expiresAt = latestAccount.expiresAt
  }

  private async handleRefreshError(
    error: unknown,
    account: ManagedAccount,
    showToast: ToastFunction
  ): Promise<{ account: ManagedAccount; shouldContinue: boolean }> {
    if (error instanceof TokenPersistenceError) {
      logger.error('Token refresh persistence failed', { email: account.email })
      return { account, shouldContinue: true }
    }

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
