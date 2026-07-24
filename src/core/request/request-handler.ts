import {
  GenerateAssistantResponseCommand,
  type GenerateAssistantResponseCommandOutput
} from '@aws/codewhisperer-streaming-client'
import { clearTimeout as clearDeadlineTimeout, setTimeout as setDeadlineTimeout } from 'node:timers'
import type { AccountRepository } from '../../infrastructure/database/account-repository'
import type { AccountManager } from '../../plugin/accounts'
import type { KiroConfig } from '../../plugin/config'
import { isPermanentError } from '../../plugin/health'
import * as logger from '../../plugin/logger'
import { transformToSdkRequest } from '../../plugin/request'
import { createSdkClient } from '../../plugin/sdk-client'
import { syncFromKiroCli } from '../../plugin/sync/kiro-cli'
import type { KiroAuthDetails, ManagedAccount, SdkPreparedRequest } from '../../plugin/types'
import { AccountSelector } from '../account/account-selector'
import { UsageTracker } from '../account/usage-tracker'
import { TokenRefresher } from '../auth/token-refresher'
import { ErrorHandler, isKiroContextOverflowBody, type RequestContext } from './error-handler'
import { ResponseHandler } from './response-handler'
import { RetryStrategy } from './retry-strategy'
import { SdkEventStreamIterationError, UpstreamUnexpectedError } from './stream-error'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

const KIRO_API_PATTERN = /^(https?:\/\/)?q\.[a-z0-9-]+\.amazonaws\.com/
const REAUTH_FAILURE_COOLDOWN_MS = 60000
type UpstreamWaitPhase = 'SDK response' | 'stream event'

export class RequestHandler {
  private accountSelector: AccountSelector
  private tokenRefresher: TokenRefresher
  private errorHandler: ErrorHandler
  private responseHandler: ResponseHandler
  private usageTracker: UsageTracker
  private retryStrategy: RetryStrategy
  private reauthInFlight: Promise<boolean> | null = null
  private lastFailedReauthAt = 0
  private accountAttemptEpochs = new Map<string, number>()
  private streamRetryRandom = Math.random
  private static kiroRequestQueue: Promise<void> = Promise.resolve()

  constructor(
    private accountManager: AccountManager,
    private config: KiroConfig,
    private repository: AccountRepository,
    private client?: any
  ) {
    this.accountSelector = new AccountSelector(accountManager, config, syncFromKiroCli, repository)
    this.tokenRefresher = new TokenRefresher(config, accountManager, syncFromKiroCli, repository)
    this.errorHandler = new ErrorHandler(config, accountManager, repository, (acc, toast) =>
      this.tokenRefresher.forceRefresh(acc, toast)
    )
    this.responseHandler = new ResponseHandler()
    this.usageTracker = new UsageTracker(config, accountManager, repository)
    this.retryStrategy = new RetryStrategy(config)
  }

  get sharedTokenRefresher(): TokenRefresher {
    return this.tokenRefresher
  }

  async handle(input: any, init: any, showToast: ToastFunction): Promise<Response> {
    const url = typeof input === 'string' ? input : input.url

    if (!KIRO_API_PATTERN.test(url)) {
      return fetch(input, init)
    }

    return this.enqueueKiroRequest(() => this.handleKiroRequest(url, init, showToast))
  }

  private async enqueueKiroRequest<T>(run: () => Promise<T>): Promise<T> {
    const previous = RequestHandler.kiroRequestQueue
    let release!: () => void

    RequestHandler.kiroRequestQueue = new Promise((resolve) => {
      release = resolve
    })

    await previous.catch(() => {})

    try {
      return await run()
    } finally {
      release()
    }
  }

  private async handleKiroRequest(
    url: string,
    init: any,
    showToast: ToastFunction
  ): Promise<Response> {
    const requestController = new AbortController()
    const inboundSignal = init?.signal as AbortSignal | undefined
    const abortFromInbound = (): void => requestController.abort(inboundSignal?.reason)
    if (inboundSignal?.aborted) abortFromInbound()
    else inboundSignal?.addEventListener('abort', abortFromInbound, { once: true })
    let timeout: ReturnType<typeof setDeadlineTimeout> | undefined
    const beginUpstreamWait = (
      phase: UpstreamWaitPhase,
      timeoutMs: number,
      details: Record<string, unknown> = {}
    ): void => {
      if (requestController.signal.aborted) return
      if (timeout) clearDeadlineTimeout(timeout)
      if (timeoutMs <= 0) {
        timeout = undefined
        return
      }
      const startedAt = Date.now()
      timeout = setDeadlineTimeout(() => {
        logger.warn('Kiro upstream wait timed out', {
          phase,
          configuredTimeoutMs: timeoutMs,
          elapsedMs: Date.now() - startedAt,
          platform: process.platform,
          ...details
        })
        requestController.abort(
          new DOMException(`Kiro request timed out waiting for ${phase}`, 'TimeoutError')
        )
      }, timeoutMs)
    }
    const endUpstreamWait = (): void => {
      if (!timeout) return
      clearDeadlineTimeout(timeout)
      timeout = undefined
    }
    let requestCleanupDone = false
    let responseOwnsLifecycle = false
    const cleanupRequest = (): void => {
      if (requestCleanupDone) return
      requestCleanupDone = true
      endUpstreamWait()
      inboundSignal?.removeEventListener('abort', abortFromInbound)
    }
    const signal = requestController.signal
    const body = init?.body ? JSON.parse(init.body) : {}
    const model = this.extractModel(url) || body.model || 'claude-sonnet-4-5'
    const think =
      model.endsWith('-thinking') || !!body.providerOptions?.thinkingConfig || !!body.thinkingConfig
    const budget =
      body.providerOptions?.thinkingConfig?.thinkingBudget ||
      body.thinkingConfig?.thinkingBudget ||
      body.thinkingConfig?.budget_tokens ||
      20000

    let handlerContext: RequestContext = { retry: 0, forcedRefreshAccountIds: new Set<string>() }
    let consecutiveNullAccounts = 0
    let streamFailureCount = 0
    let forcedStreamAccount: ManagedAccount | null = null
    const retryContext = this.retryStrategy.createContext()

    try {
      while (true) {
        if (signal.aborted) throw signal.reason
        const check = this.retryStrategy.shouldContinue(retryContext)
        if (!check.canContinue) {
          throw new Error(check.error)
        }

        if (this.allAccountsPermanentlyUnhealthy()) {
          const reauthed = await this.triggerReauth(showToast)
          if (!reauthed) {
            throw new Error('All accounts are permanently unhealthy. Please re-authenticate.')
          }
          continue
        }

        let acc: ManagedAccount | null = forcedStreamAccount
        forcedStreamAccount = null
        if (!acc) {
          acc = await this.accountSelector
            .selectHealthyAccount(showToast, signal)
            .catch(async (e) => {
              if (e instanceof Error && e.message.includes('reauth required')) {
                const reauthed = await this.triggerReauth(showToast)
                if (!reauthed)
                  throw new Error(
                    'All accounts are unhealthy or rate-limited. Please re-authenticate.'
                  )
                return null
              }
              throw e
            })
        }
        if (!acc) {
          consecutiveNullAccounts++
          const backoffDelay = Math.min(1000 * Math.pow(2, consecutiveNullAccounts - 1), 10000)
          await this.sleep(backoffDelay, signal)
          continue
        }

        consecutiveNullAccounts = 0
        const auth = this.accountManager.toAuthDetails(acc)

        const tokenResult = await this.tokenRefresher.refreshIfNeeded(acc, auth, showToast)
        if (tokenResult.shouldContinue) {
          acc = tokenResult.account
          await this.sleep(500, signal)
          continue
        }

        const sdkPrep = this.prepareSdkRequest(init?.body, model, auth, think, budget, showToast)

        if (this.config.enable_log_effort_debug) {
          try {
            logger.log('[effort-debug] request effort resolution', {
              model,
              effectiveModel: sdkPrep.effectiveModel,
              think,
              budget,
              resolvedEffort: sdkPrep.effort ?? 'undefined (not effort-capable or not thinking)',
              inboundBodyKeys: Object.keys(body),
              messagesCount: body.messages?.length,
              reasoningSubtree: {
                reasoningEffort: body.reasoningEffort,
                reasoning_effort: body.reasoning_effort,
                reasoning: body.reasoning,
                providerOptions: body.providerOptions,
                thinkingConfig: body.thinkingConfig,
                providerOptionsThinkingConfig: body.providerOptions?.thinkingConfig
              }
            })
          } catch {}
        }

        const apiTimestamp = this.config.enable_log_api_request ? logger.getTimestamp() : null
        if (apiTimestamp) {
          this.logSdkRequest(sdkPrep, acc, apiTimestamp)
        }
        let sendResolved = false
        try {
          const client = this.makeSdkClient(auth, sdkPrep.region, sdkPrep.effort)
          const command = new GenerateAssistantResponseCommand({
            conversationState: sdkPrep.conversationState as any,
            profileArn: sdkPrep.profileArn
          })
          const attemptEpoch = this.nextAccountAttemptEpoch(acc.id)
          const isCurrentAttempt = (): boolean =>
            this.accountAttemptEpochs.get(acc.id) === attemptEpoch
          let completionDone = false
          const completeRequest = async (): Promise<void> => {
            if (completionDone) return
            completionDone = true
            if (!isCurrentAttempt()) return
            this.handleSuccessfulRequest(acc)
            await this.usageTracker.syncUsage(acc, auth, isCurrentAttempt)
          }

          let sdkResponse: GenerateAssistantResponseCommandOutput
          if (this.config.sdk_response_timeout_enabled) {
            const messageContext =
              sdkPrep.conversationState.currentMessage?.userInputMessage?.userInputMessageContext
            beginUpstreamWait('SDK response', this.config.sdk_response_timeout_ms, {
              model,
              effectiveModel: sdkPrep.effectiveModel,
              effort: sdkPrep.effort,
              region: sdkPrep.region,
              historyLength: sdkPrep.conversationState.history?.length ?? 0,
              toolCount: messageContext?.tools?.length ?? 0
            })
          }
          try {
            sdkResponse = await client.send(command, { abortSignal: signal })
          } finally {
            endUpstreamWait()
          }
          sendResolved = true

          if (apiTimestamp) {
            this.logSdkResponse(sdkPrep, apiTimestamp)
          }

          const response = await this.responseHandler.handleSdkSuccess(
            sdkResponse,
            model,
            sdkPrep.conversationId,
            sdkPrep.streaming,
            {
              signal,
              onUpstreamWaitStart: () =>
                beginUpstreamWait('stream event', this.config.request_timeout_ms, {
                  model,
                  effectiveModel: sdkPrep.effectiveModel,
                  region: sdkPrep.region
                }),
              onUpstreamWaitEnd: endUpstreamWait,
              onComplete: completeRequest,
              onTerminal: cleanupRequest,
              onCancel: (reason) => requestController.abort(reason),
              mapError: (error) => new UpstreamUnexpectedError(error, true)
            }
          )

          if (sdkPrep.streaming) {
            responseOwnsLifecycle = true
          } else {
            await completeRequest()
          }
          return response
        } catch (e: any) {
          if (signal.aborted) throw signal.reason

          if (e instanceof SdkEventStreamIterationError) {
            streamFailureCount++
            const streamError = new UpstreamUnexpectedError(e, false)
            if (streamFailureCount >= 3) return streamError.toResponse()

            await this.sleep(this.getStreamRetryDelay(streamFailureCount), signal)
            if (streamFailureCount === 1) {
              forcedStreamAccount = acc
            } else {
              forcedStreamAccount =
                (await this.accountSelector.selectAlternativeAccount(new Set([acc.id]))) ?? acc
            }
            continue
          }

          if (sendResolved) throw e

          const httpStatus = e?.$metadata?.httpStatusCode

          if (httpStatus) {
            if (apiTimestamp) {
              this.logSdkError(sdkPrep, e, acc, apiTimestamp)
            }

            const errorBody = JSON.stringify({ message: e.message, __type: e.name })
            const errorStatusText = e.name || 'Error'
            const jsonHeaders = { 'Content-Type': 'application/json' }

            const errorResult = await this.errorHandler.handle(
              e,
              new Response(errorBody, {
                status: httpStatus,
                statusText: errorStatusText,
                headers: jsonHeaders
              }),
              acc,
              handlerContext,
              showToast,
              signal
            )

            if (errorResult.shouldRetry) {
              if (errorResult.newContext) {
                handlerContext = errorResult.newContext
              }
              continue
            }

            // Terminal, non-retryable HTTP error. Return a fresh Response carrying
            // the real Kiro body so @ai-sdk/openai-compatible produces an
            // APICallError with status+body (not a bare Error that OpenCode
            // degrades to UnknownError). Remap size-overflow 400s to 413 so
            // OpenCode classifies context_overflow and auto-compacts.
            const terminalStatus =
              httpStatus === 400 && isKiroContextOverflowBody(e.message ?? '') ? 413 : httpStatus

            return new Response(errorBody, {
              status: terminalStatus,
              statusText: errorStatusText,
              headers: jsonHeaders
            })
          }

          const networkResult = await this.errorHandler.handleNetworkError(
            e,
            handlerContext,
            showToast,
            signal
          )

          if (networkResult.shouldRetry) {
            if (networkResult.newContext) {
              handlerContext = { ...handlerContext, ...networkResult.newContext }
            }
            continue
          }

          throw e
        }
      }
    } finally {
      if (!responseOwnsLifecycle) cleanupRequest()
    }
  }

  private extractModel(url: string): string | null {
    return url.match(/models\/([^/:]+)/)?.[1] || null
  }

  /**
   * Seam over the module-level SDK client factory so tests can inject a fake
   * client without a real network call or a leaky module mock. Behavior is
   * identical to calling createSdkClient directly.
   */
  private makeSdkClient(auth: KiroAuthDetails, region: string, effort?: any): any {
    return createSdkClient(auth, region, effort)
  }

  private prepareSdkRequest(
    body: any,
    model: string,
    auth: KiroAuthDetails,
    think: boolean,
    budget: number,
    showToast?: (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void
  ): SdkPreparedRequest {
    return transformToSdkRequest(body, model, auth, think, budget, showToast, {
      effort: this.config.effort,
      autoEffortMapping: this.config.auto_effort_mapping
    })
  }

  private handleSuccessfulRequest(acc: ManagedAccount): void {
    if (acc.failCount && acc.failCount > 0) {
      if (!isPermanentError(acc.unhealthyReason)) {
        acc.failCount = 0
        acc.isHealthy = true
        delete acc.unhealthyReason
        delete acc.recoveryTime
        this.repository.save(acc).catch(() => {})
      }
    }
  }

  private logSdkRequest(prep: SdkPreparedRequest, acc: ManagedAccount, timestamp: string): void {
    logger.logApiRequest(
      {
        url: `https://q.${prep.region}.amazonaws.com/generateAssistantResponse`,
        method: 'POST',
        headers: { 'x-amzn-kiro-agent-mode': 'vibe' },
        body: {
          conversationState: {
            chatTriggerType: prep.conversationState.chatTriggerType,
            conversationId: prep.conversationState.conversationId,
            historyLength: (prep.conversationState as any).history?.length || 0,
            currentMessage: prep.conversationState.currentMessage
          },
          profileArn: prep.profileArn
        },
        conversationId: prep.conversationId,
        model: prep.effectiveModel,
        email: acc.email
      },
      timestamp
    )
  }

  private logSdkResponse(prep: SdkPreparedRequest, timestamp: string): void {
    logger.logApiResponse(
      {
        status: 200,
        statusText: 'OK',
        headers: {},
        conversationId: prep.conversationId,
        model: prep.effectiveModel
      },
      timestamp
    )
  }

  private logSdkError(
    prep: SdkPreparedRequest,
    error: any,
    acc: ManagedAccount,
    apiTimestamp: string
  ): void {
    const status = error?.$metadata?.httpStatusCode || 0
    const rData = {
      status,
      statusText: error?.name || 'Error',
      headers: {},
      error: `Kiro Error: ${status} - ${error?.message || 'Unknown'}`,
      conversationId: prep.conversationId,
      model: prep.effectiveModel
    }
    if (!this.config.enable_log_api_request) {
      logger.logApiError(
        {
          url: `https://q.${prep.region}.amazonaws.com/generateAssistantResponse`,
          method: 'POST',
          headers: {},
          body: null,
          conversationId: prep.conversationId,
          model: prep.effectiveModel,
          email: acc.email
        },
        rData,
        logger.getTimestamp()
      )
    } else {
      logger.logApiResponse(rData, apiTimestamp)
    }
  }

  private async triggerReauth(showToast: ToastFunction): Promise<boolean> {
    if (!this.client) return false

    const cooldownRemaining = REAUTH_FAILURE_COOLDOWN_MS - (Date.now() - this.lastFailedReauthAt)
    if (cooldownRemaining > 0) {
      showToast(
        'Recent re-authentication failed. Please complete authentication manually.',
        'error'
      )
      return false
    }

    if (this.reauthInFlight) {
      return this.reauthInFlight
    }

    this.reauthInFlight = this.performReauth(showToast)
    const success = await this.reauthInFlight.finally(() => {
      this.reauthInFlight = null
    })
    if (!success) this.lastFailedReauthAt = Date.now()
    return success
  }

  private async performReauth(showToast: ToastFunction): Promise<boolean> {
    try {
      showToast('Session expired. Re-authenticating...', 'warning')
      await this.client.provider.oauth.authorize({
        path: { id: 'kiro-auth' },
        body: { method: 0 }
      })

      await this.client.provider.oauth.callback({
        path: { id: 'kiro-auth' },
        body: { method: 0 }
      })

      this.repository.invalidateCache()
      const accounts = await this.repository.findAll()
      for (const acc of accounts) {
        this.accountManager.addAccount(acc)
      }

      if (!this.hasUsableAccount(accounts)) {
        logger.warn('Re-auth completed but no usable Kiro account was found')
        showToast('Re-authentication completed but no usable Kiro account was found.', 'error')
        return false
      }

      showToast('Re-authentication successful.', 'success')
      return true
    } catch (e) {
      logger.error('Re-auth failed', e instanceof Error ? e : new Error(String(e)))
      return false
    }
  }

  private hasUsableAccount(accounts: ManagedAccount[]): boolean {
    const now = Date.now()
    return accounts.some(
      (acc) => acc.isHealthy && acc.expiresAt > now && !isPermanentError(acc.unhealthyReason)
    )
  }

  private allAccountsPermanentlyUnhealthy(): boolean {
    const accounts = this.accountManager.getAccounts()
    if (accounts.length === 0) {
      return false
    }
    return accounts.every((acc) => !acc.isHealthy && isPermanentError(acc.unhealthyReason))
  }

  private nextAccountAttemptEpoch(accountId: string): number {
    const next = (this.accountAttemptEpochs.get(accountId) ?? 0) + 1
    this.accountAttemptEpochs.set(accountId, next)
    return next
  }

  private getStreamRetryDelay(failureCount: number): number {
    const base = 250 * Math.pow(2, failureCount - 1)
    return base + base * 0.25 * this.streamRetryRandom()
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    let onAbort: (() => void) | undefined
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      onAbort = () => {
        clearTimeout(timer)
        reject(signal?.reason)
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    }).finally(() => {
      if (onAbort) signal?.removeEventListener('abort', onAbort)
    })
  }
}
