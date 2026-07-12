import type { AccountRepository } from '../../infrastructure/database/account-repository'
import type { AccountManager } from '../../plugin/accounts'
import { isAccessTokenError, toDeadReason } from '../../plugin/health'
import type { ManagedAccount } from '../../plugin/types'
import type { ForceRefreshResult } from '../auth/token-refresher'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

export interface RequestContext {
  retry: number
  // Loop-bound invariant: account ids already force-refreshed this request.
  // Threaded across retries AND account switches (never reset on switch) so
  // each account force-refreshes at most once, bounding the loop with the
  // RetryStrategy iteration cap.
  forcedRefreshAccountIds?: Set<string>
}

type ForceRefreshFn = (
  account: ManagedAccount,
  showToast: ToastFunction
) => Promise<ForceRefreshResult>

interface ErrorHandlerConfig {
  rate_limit_max_retries: number
  rate_limit_retry_delay_ms: number
}

export class ErrorHandler {
  constructor(
    private config: ErrorHandlerConfig,
    private accountManager: AccountManager,
    private repository: AccountRepository,
    private forceRefresh?: ForceRefreshFn
  ) {}

  async handle(
    error: any,
    response: Response,
    account: ManagedAccount,
    context: RequestContext,
    showToast: ToastFunction
  ): Promise<{ shouldRetry: boolean; newContext?: RequestContext; switchAccount?: boolean }> {
    const readBody = async (): Promise<string> => {
      try {
        const body = JSON.parse(await response.clone().text())
        return body.message || body.Message || body.__type || JSON.stringify(body)
      } catch {
        return ''
      }
    }

    if (response.status === 400) {
      const reason = await readBody()
      showToast(`400: ${reason || 'unknown'}`, 'error')
      return { shouldRetry: false }
    }

    if (response.status === 401 && context.retry < this.config.rate_limit_max_retries) {
      const reason = await readBody()
      showToast(`401: ${reason || 'Unauthorized'}. Retrying...`, 'warning')
      return {
        shouldRetry: true,
        newContext: { ...context, retry: context.retry + 1 }
      }
    }

    if (response.status === 500) {
      account.failCount = (account.failCount || 0) + 1
      let errorMessage = 'Internal Server Error'
      try {
        const errorBody = await response.text()
        const errorData = JSON.parse(errorBody)
        if (errorData.message) {
          errorMessage = errorData.message
        } else if (errorData.Message) {
          errorMessage = errorData.Message
        }
      } catch {}

      if (account.failCount < 5) {
        const delay = 1000 * Math.pow(2, account.failCount - 1)
        showToast(`500: ${errorMessage}. Retrying in ${Math.ceil(delay / 1000)}s...`, 'warning')
        await this.sleep(delay)
        return { shouldRetry: true }
      } else {
        this.accountManager.markUnhealthy(
          account,
          `Server Error (500) after 5 attempts: ${errorMessage}`
        )
        await this.repository.batchSave(this.accountManager.getAccounts())
        showToast(`500: ${errorMessage}. Marking account as unhealthy and switching...`, 'warning')
        return { shouldRetry: true, switchAccount: true }
      }
    }

    if (response.status === 429) {
      const w = parseInt(response.headers.get('retry-after') || '60') * 1000
      this.accountManager.markRateLimited(account, w)
      await this.repository.batchSave(this.accountManager.getAccounts())
      const count = this.accountManager.getAccountCount()
      if (count > 1) {
        return { shouldRetry: true, switchAccount: true }
      }
      showToast(`429: Rate limited. Waiting ${Math.ceil(w / 1000)}s...`, 'warning')
      await this.sleep(w)
      return { shouldRetry: true }
    }

    if (response.status === 402 || response.status === 403) {
      let errorReason = response.status === 402 ? 'Quota' : 'Forbidden'
      let isPermanent = false
      const errorBody = await response.text()
      const errorData = (() => {
        try {
          return JSON.parse(errorBody)
        } catch {
          return null
        }
      })()
      if (errorData?.message) {
        errorReason = errorData.message
      }
      if (errorData?.reason === 'INVALID_MODEL_ID') {
        throw new Error(`Invalid model: ${errorData.message}`)
      }
      if (errorData?.reason === 'TEMPORARILY_SUSPENDED') {
        errorReason = 'Account Suspended'
        isPermanent = true
      }
      const isInvalidBearer = isAccessTokenError(errorReason)

      if (response.status === 403 && isInvalidBearer && this.forceRefresh) {
        const forced = context.forcedRefreshAccountIds ?? new Set<string>()
        const alreadyForced = forced.has(account.id)

        if (!alreadyForced) {
          const result = await this.forceRefresh(account, showToast)
          const nextForced = new Set(forced).add(account.id)
          if (result.ok) {
            showToast('403: Stale token detected. Refreshed and retrying...', 'warning')
            return {
              shouldRetry: true,
              newContext: { ...context, forcedRefreshAccountIds: nextForced }
            }
          }
          if (result.dead) {
            return this.markDeadAndSwitchOrFail(
              account,
              errorReason,
              response.status,
              context,
              nextForced,
              showToast
            )
          }
          return this.transientForbidden(
            errorReason,
            response.status,
            { ...context, forcedRefreshAccountIds: nextForced },
            showToast
          )
        }

        return this.markDeadAndSwitchOrFail(
          account,
          errorReason,
          response.status,
          context,
          forced,
          showToast
        )
      }

      if (isPermanent) {
        account.failCount = 10
      }

      if (this.accountManager.getAccountCount() > 1) {
        showToast(`${response.status}: ${errorReason}. Switching account...`, 'warning')
        this.accountManager.markUnhealthy(account, errorReason)
        await this.repository.batchSave(this.accountManager.getAccounts())
        return { shouldRetry: true, switchAccount: true }
      }

      if (
        response.status === 403 &&
        !isPermanent &&
        context.retry < this.config.rate_limit_max_retries
      ) {
        return this.transientForbidden(errorReason, response.status, context, showToast)
      }

      showToast(`${response.status}: ${errorReason}`, 'error')
      return { shouldRetry: false }
    }

    const reason = await readBody()
    showToast(`${response.status}: ${reason || response.statusText}`, 'error')
    return { shouldRetry: false }
  }

  private async markDeadAndSwitchOrFail(
    account: ManagedAccount,
    errorReason: string,
    status: number,
    context: RequestContext,
    forced: Set<string>,
    showToast: ToastFunction
  ): Promise<{ shouldRetry: boolean; newContext?: RequestContext; switchAccount?: boolean }> {
    const deadReason = toDeadReason(errorReason)
    this.accountManager.markUnhealthy(account, deadReason)
    await this.repository.batchSave(this.accountManager.getAccounts())

    if (this.accountManager.getAccountCount() > 1) {
      showToast(`${status}: ${errorReason}. Re-login required. Switching account...`, 'warning')
      return {
        shouldRetry: true,
        switchAccount: true,
        newContext: { ...context, forcedRefreshAccountIds: forced }
      }
    }

    showToast(`${status}: ${errorReason}. Re-login required.`, 'error')
    return { shouldRetry: false }
  }

  private async transientForbidden(
    errorReason: string,
    status: number,
    context: RequestContext,
    showToast: ToastFunction
  ): Promise<{ shouldRetry: boolean; newContext?: RequestContext }> {
    if (context.retry >= this.config.rate_limit_max_retries) {
      showToast(`${status}: ${errorReason}`, 'error')
      return { shouldRetry: false }
    }
    const delay = this.config.rate_limit_retry_delay_ms * Math.pow(2, context.retry)
    showToast(`${status}: ${errorReason}. Retrying in ${Math.ceil(delay / 1000)}s...`, 'warning')
    await this.sleep(delay)
    return {
      shouldRetry: true,
      newContext: { ...context, retry: context.retry + 1 }
    }
  }

  async handleNetworkError(
    error: any,
    context: RequestContext,
    showToast: ToastFunction
  ): Promise<{ shouldRetry: boolean; newContext?: RequestContext }> {
    if (this.isNetworkError(error) && context.retry < this.config.rate_limit_max_retries) {
      const d = this.config.rate_limit_retry_delay_ms * Math.pow(2, context.retry)
      showToast(`Network error. Retrying in ${Math.ceil(d / 1000)}s...`, 'warning')
      await this.sleep(d)
      return {
        shouldRetry: true,
        newContext: { ...context, retry: context.retry + 1 }
      }
    }
    return { shouldRetry: false }
  }

  private isNetworkError(e: any): boolean {
    return (
      e instanceof Error && /econnreset|etimedout|enotfound|network|fetch failed/i.test(e.message)
    )
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }
}
