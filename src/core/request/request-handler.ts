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
import { reasoningCorrelationCache } from '../../plugin/reasoning/correlation-cache'
import { EmittedOutputAccumulator } from '../../plugin/reasoning/emitted-output'
import { deriveInheritedLoopId, normalizeToolArguments } from '../../plugin/reasoning/turn-identity'
import { transformToSdkRequest } from '../../plugin/request'
import { createSdkClient } from '../../plugin/sdk-client'
import {
  StreamObserver,
  type RequestTerminalSource,
  type StreamTerminalSource
} from '../../plugin/streaming/stream-observer'
import { syncFromKiroCli } from '../../plugin/sync/kiro-cli'
import type { KiroAuthDetails, ManagedAccount, SdkPreparedRequest } from '../../plugin/types'
import { AccountSelector } from '../account/account-selector'
import { UsageTracker } from '../account/usage-tracker'
import { TokenRefresher } from '../auth/token-refresher'
import { ErrorHandler, isKiroContextOverflowBody, type RequestContext } from './error-handler'
import { RecoveryAttemptFactory } from './recovery-attempt'
import { createLiveRecoveryResponse } from './recovery-integration'
import { ResponseHandler, type SdkCompletionPayload } from './response-handler'
import { RetryStrategy } from './retry-strategy'
import { buildSdkRequestLogPayload } from './sdk-log-payload'
import { SdkEventStreamIterationError, UpstreamUnexpectedError } from './stream-error'
import {
  STREAM_MISSING_COMPLETION_LOG,
  STREAM_REQUEST_STARTED_LOG,
  STREAM_TERMINAL_LOG
} from './stream-log-events'

export {
  STREAM_MISSING_COMPLETION_LOG,
  STREAM_REQUEST_STARTED_LOG,
  STREAM_TERMINAL_LOG
} from './stream-log-events'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

const KIRO_API_PATTERN = /^(https?:\/\/)?q\.[a-z0-9-]+\.amazonaws\.com/
const REAUTH_FAILURE_COOLDOWN_MS = 60000
type UpstreamWaitPhase = 'SDK response' | 'stream event'
type RequestTerminalLogDetails = Readonly<Record<string, unknown>> & {
  readonly terminalSource: RequestTerminalSource
}

function describeError(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) return String(error)
  const code = (error as Error & { code?: unknown }).code
  return {
    name: error.name,
    message: error.message,
    ...(code !== undefined ? { code } : {}),
    ...(depth < 2 && error.cause !== undefined
      ? { cause: describeError(error.cause, depth + 1) }
      : {})
  }
}

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
    let streamStartRecorded = false
    let terminalSummaryRecorded = false
    let latestStreamLogDetails:
      ((details?: Record<string, unknown>) => Record<string, unknown>) | undefined
    const logTerminalSummary = (details: RequestTerminalLogDetails): void => {
      if (terminalSummaryRecorded || !streamStartRecorded) return
      terminalSummaryRecorded = true
      const terminalDetails = { outcome: 'terminal', ...details }
      logger.log(
        STREAM_TERMINAL_LOG,
        latestStreamLogDetails ? latestStreamLogDetails(terminalDetails) : terminalDetails
      )
    }
    let streamFailureCount = 0
    const failedAccountIds = new Set<string>()
    let forcedStreamAccount: ManagedAccount | null = null
    let pinnedAccount: ManagedAccount | null = null
    let currentAttemptId = ''
    const inheritedLoopId = deriveInheritedLoopId(body.messages)
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

        let acc: ManagedAccount | null = forcedStreamAccount ?? pinnedAccount
        forcedStreamAccount = null
        pinnedAccount = null
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

        const sdkPrep = this.prepareSdkRequest(
          init?.body,
          model,
          auth,
          think,
          budget,
          showToast,
          handlerContext.disableReasoningReplay === true
        )
        const streamAttempt = streamFailureCount + 1
        const streamAttemptStartedAt = Date.now()
        const streamStartedAt = new Date(streamAttemptStartedAt).toISOString()
        const streamObserver = new StreamObserver()
        const emittedOutput = new EmittedOutputAccumulator()
        let upstreamEventCount = 0
        // OpenCode's provider fetch boundary supplies only input/init; it exposes
        // no session/message hook context. Keep real transport correlation below
        // rather than emitting permanently empty sessionId/messageId fields.
        const streamLogDetails = (
          details: Record<string, unknown> = {}
        ): Record<string, unknown> => {
          const observed = streamObserver.snapshot()
          return {
            conversationId: sdkPrep.conversationId,
            model,
            effectiveModel: sdkPrep.effectiveModel,
            region: sdkPrep.region,
            account: acc.email,
            accountId: acc.id,
            streamAttempt,
            maxStreamAttempts: this.config.stream_max_attempts,
            streamDeliveryMode: this.config.stream_buffer_until_complete ? 'buffered' : 'live',
            sdkHttpKeepAlive: this.config.sdk_http_keep_alive,
            processId: process.pid,
            bunVersion: process.versions.bun,
            streamStartedAt,
            upstreamEventCount,
            eventTypeCounts: observed.eventTypeCounts,
            streamElapsedMs: Date.now() - streamAttemptStartedAt,
            // Volume only, never content: the same redaction rule the API log sink
            // follows. A char count cannot reconstruct reasoning or reply text.
            emittedReasoningChars: emittedOutput.reasoningText.length,
            emittedVisibleChars: emittedOutput.visibleText.length,
            emittedToolCount: emittedOutput.toolUses().length,
            sawToolIntent: observed.sawToolIntent,
            hasOpenToolIntent: observed.hasOpenToolIntent,
            reasoningPhase: observed.reasoningPhase,
            dialectActive: observed.dialectActive,
            dialectMarkerIndex: observed.dialectMarkerIndex,
            dialectMarkerInCodeRegion: observed.dialectMarkerInCodeRegion,
            dialectResolution: observed.dialectResolution,
            terminalSource: observed.terminalSource,
            ...details
          }
        }
        latestStreamLogDetails = streamLogDetails

        if (sdkPrep.streaming && streamAttempt === 1 && !streamStartRecorded) {
          streamStartRecorded = true
          logger.log(STREAM_REQUEST_STARTED_LOG, {
            conversationId: sdkPrep.conversationId,
            model,
            effectiveModel: sdkPrep.effectiveModel,
            processId: process.pid
          })
        }

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
          const liveRecoveryEnabled =
            sdkPrep.streaming &&
            !this.config.stream_buffer_until_complete &&
            (this.config.stream_recovery_mode === 'reasoning_restart' ||
              this.config.stream_recovery_mode === 'exact_replay')
          if (liveRecoveryEnabled) {
            const priorStreamFailures = streamFailureCount
            const availableStreamAttempts = this.config.stream_max_attempts - priorStreamFailures
            const availableRequestIterations =
              this.config.max_request_iterations - retryContext.iterations + 1
            const maxAttempts = Math.max(
              1,
              Math.min(availableStreamAttempts, availableRequestIterations)
            )
            const attemptFactory = new RecoveryAttemptFactory({
              config: this.config,
              request: {
                body: init?.body,
                model,
                think,
                budget,
                disableReasoningReplay: handlerContext.disableReasoningReplay === true,
                inheritedLoopId,
                signal,
                priorStreamFailures
              },
              initial: {
                account: acc,
                auth,
                prepared: sdkPrep,
                observer: streamObserver,
                emitted: emittedOutput,
                eventCount: upstreamEventCount,
                startedAt: streamAttemptStartedAt,
                apiTimestamp
              },
              services: {
                consumeRequestIteration: () => {
                  const check = this.retryStrategy.shouldContinue(retryContext)
                  if (!check.canContinue) throw new Error(check.error)
                },
                toAuthDetails: (account) => this.accountManager.toAuthDetails(account),
                refreshAccount: (account, accountAuth) =>
                  this.tokenRefresher.refreshIfNeeded(account, accountAuth, showToast),
                wait: (milliseconds, waitSignal) => this.sleep(milliseconds, waitSignal),
                prepareRequest: (_account, accountAuth) =>
                  this.prepareSdkRequest(
                    init?.body,
                    model,
                    accountAuth,
                    think,
                    budget,
                    showToast,
                    handlerContext.disableReasoningReplay === true
                  ),
                makeSdkClient: (accountAuth, prepared) =>
                  this.makeSdkClient(accountAuth, prepared.region, prepared.effort),
                responseHandler: this.responseHandler,
                beginUpstreamWait,
                endUpstreamWait,
                nextAccountAttemptEpoch: (accountId) => this.nextAccountAttemptEpoch(accountId),
                isAccountAttemptCurrent: (accountId, epoch) =>
                  this.accountAttemptEpochs.get(accountId) === epoch,
                setCurrentAttemptId: (attemptId) => {
                  currentAttemptId = attemptId
                },
                getCurrentAttemptId: () => currentAttemptId,
                markSuccessful: (account) => this.handleSuccessfulRequest(account),
                syncUsage: (account, accountAuth, isCurrent) =>
                  this.usageTracker.syncUsage(account, accountAuth, isCurrent),
                commitReasoning: (completed, accountId, owningAttemptId, latestAttemptId) =>
                  this.commitReasoningCorrelation(
                    completed,
                    accountId,
                    owningAttemptId,
                    latestAttemptId
                  ),
                logSdkRequest: (prepared, account, timestamp) =>
                  this.logSdkRequest(prepared, account, timestamp),
                logSdkResponse: (prepared, timestamp) => this.logSdkResponse(prepared, timestamp),
                markSendResolved: () => {
                  sendResolved = true
                },
                describeError
              }
            })
            const response = await createLiveRecoveryResponse({
              mode: this.config.stream_recovery_mode,
              maxAttempts,
              priorStreamFailures,
              signal,
              initialAccount: acc,
              failedAccountIds,
              attemptFactory,
              retryDelay: (failureCount) => this.getStreamRetryDelay(failureCount),
              wait: (milliseconds, waitSignal) => this.sleep(milliseconds, waitSignal),
              selectAlternativeAccount: (excludedAccountIds) =>
                this.accountSelector.selectAlternativeAccount(excludedAccountIds),
              markRateLimited: (account, milliseconds) =>
                this.accountManager.markRateLimited(account, milliseconds),
              describeError,
              onTerminal: (details) => {
                logTerminalSummary(details)
                cleanupRequest()
              },
              // Attempt-level only: an initial-open failure is pre-output and is
              // retried below, so request-level cleanup (which detaches the inbound
              // abort listener) must stay with the outer finally.
              onInitialOpenFailure: endUpstreamWait,
              onCancel: (reason) => requestController.abort(reason)
            })

            responseOwnsLifecycle = true
            sendResolved = true
            return response
          }

          const client = this.makeSdkClient(auth, sdkPrep.region, sdkPrep.effort)
          const command = new GenerateAssistantResponseCommand({
            conversationState: sdkPrep.conversationState as any,
            profileArn: sdkPrep.profileArn
          })
          const attemptEpoch = this.nextAccountAttemptEpoch(acc.id)
          const isCurrentAttempt = (): boolean =>
            this.accountAttemptEpochs.get(acc.id) === attemptEpoch
          // Request-scoped, deliberately NOT the per-account epoch: an unrelated
          // request selecting the same account bumps that epoch and would discard
          // a healthy concurrent stream's envelope.
          const attemptId = crypto.randomUUID()
          currentAttemptId = attemptId
          let completionDone = false
          const completeRequest = async (): Promise<void> => {
            if (completionDone) return
            completionDone = true
            if (!isCurrentAttempt()) return
            this.handleSuccessfulRequest(acc)
            await this.usageTracker.syncUsage(acc, auth, isCurrentAttempt)
          }
          const accountId = acc.id
          const onStreamComplete = async (completed?: SdkCompletionPayload): Promise<void> => {
            await completeRequest()
            this.commitReasoningCorrelation(completed, accountId, attemptId, currentAttemptId)
          }

          let sdkResponse: GenerateAssistantResponseCommandOutput
          if (this.config.sdk_response_timeout_enabled) {
            const messageContext =
              sdkPrep.conversationState.currentMessage?.userInputMessage?.userInputMessageContext
            beginUpstreamWait('SDK response', this.config.sdk_response_timeout_ms, {
              conversationId: sdkPrep.conversationId,
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
          } catch (error) {
            endUpstreamWait()
            throw error
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
              onUpstreamWaitStart: ({ eventIndex }) => {
                upstreamEventCount = eventIndex
                if (eventIndex === 0) {
                  if (!this.config.sdk_response_timeout_enabled) endUpstreamWait()
                  return
                }
                if (!this.config.stream_event_timeout_enabled) return
                beginUpstreamWait('stream event', this.config.request_timeout_ms, {
                  conversationId: sdkPrep.conversationId,
                  model,
                  effectiveModel: sdkPrep.effectiveModel,
                  region: sdkPrep.region,
                  eventIndex
                })
              },
              onUpstreamWaitEnd: endUpstreamWait,
              onIterationError: (error, afterCompletionMetadata) => {
                if (!afterCompletionMetadata) return
                streamObserver.noteTerminalSource('completion_metadata_received')
                logger.log(
                  'Kiro SDK event stream closed after completion metadata',
                  streamLogDetails({
                    outcome: 'ignored_after_completion_metadata',
                    platform: process.platform,
                    afterCompletionMetadata,
                    error: describeError(error)
                  })
                )
              },
              onCleanEofWithoutCompletionMetadata: () => {
                logger.warn(
                  STREAM_MISSING_COMPLETION_LOG,
                  streamLogDetails({ outcome: 'clean_eof_without_completion_metadata' })
                )
              },
              onComplete: onStreamComplete,
              streamObserver,
              emittedOutput,
              attemptId,
              ...(inheritedLoopId !== undefined ? { inheritedLoopId } : {}),
              effectiveModel: sdkPrep.effectiveModel,
              recoveryMode: this.config.stream_recovery_mode,
              onTerminal: () => {
                logTerminalSummary({
                  phase: 'stream_iteration',
                  terminalSource:
                    streamObserver.snapshot().terminalSource ?? 'stream_processing_failure'
                })
                cleanupRequest()
              },
              onCancel: (reason) => requestController.abort(reason),
              bufferUntilComplete: this.config.stream_buffer_until_complete,
              mapError: (error) => {
                logger.error(
                  'Kiro SDK event stream iteration failed',
                  streamLogDetails({
                    outcome: 'terminated_after_output',
                    platform: process.platform,
                    emittedOutput: true,
                    error: describeError(error)
                  })
                )
                return new UpstreamUnexpectedError(error, true)
              }
            }
          )

          if (streamFailureCount > 0) {
            logger.log(
              'Kiro SDK event stream retry recovered',
              streamLogDetails({ outcome: 'recovered', attempts: streamAttempt })
            )
          }
          if (sdkPrep.streaming) {
            responseOwnsLifecycle = true
          } else {
            await completeRequest()
          }
          return response
        } catch (e: any) {
          if (signal.aborted) {
            streamObserver.noteTerminalSource('caller_abort')
            logTerminalSummary({ terminalSource: 'caller_abort' })
            throw signal.reason
          }

          if (e instanceof SdkEventStreamIterationError) {
            streamFailureCount++
            failedAccountIds.add(acc.id)
            const streamError = new UpstreamUnexpectedError(e, false)
            if (streamFailureCount >= this.config.stream_max_attempts) {
              const observedSource = streamObserver.snapshot().terminalSource
              const terminalSource: StreamTerminalSource =
                observedSource === 'semantic_truncation'
                  ? 'semantic_truncation'
                  : 'stream_attempt_budget_exhausted'
              streamObserver.noteTerminalSource(terminalSource)
              logger.error(
                'Kiro SDK event stream iteration failed',
                streamLogDetails({
                  outcome: 'exhausted',
                  platform: process.platform,
                  attempts: streamFailureCount,
                  error: describeError(e)
                })
              )
              logTerminalSummary({ terminalSource })
              return streamError.toResponse()
            }

            const delayMs = this.getStreamRetryDelay(streamFailureCount)
            await this.sleep(delayMs, signal)
            let selectionReason: string
            if (streamFailureCount === 1) {
              forcedStreamAccount = acc
              selectionReason = 'first_stream_retry_reuses_current_account'
            } else {
              const alternative =
                await this.accountSelector.selectAlternativeAccount(failedAccountIds)
              if (alternative && !failedAccountIds.has(alternative.id)) {
                forcedStreamAccount = alternative
                selectionReason = 'selected_untried_account'
              } else {
                forcedStreamAccount = acc
                selectionReason = alternative
                  ? 'selector_returned_excluded_account'
                  : 'all_candidate_accounts_excluded'
              }
            }
            logger.warn(
              'Kiro SDK event stream iteration failed',
              streamLogDetails({
                outcome: 'retrying',
                platform: process.platform,
                nextAttempt: streamFailureCount + 1,
                delayMs,
                nextAccount: forcedStreamAccount.email,
                nextAccountId: forcedStreamAccount.id,
                failedAccountIds: [...failedAccountIds],
                selectionReason,
                error: describeError(e)
              })
            )
            continue
          }

          if (sendResolved) {
            const terminalSource =
              streamObserver.snapshot().terminalSource ?? 'stream_processing_failure'
            logTerminalSummary({
              phase: 'stream_iteration',
              terminalSource,
              error: describeError(e)
            })
            throw e
          }

          const httpStatus = e?.$metadata?.httpStatusCode

          if (httpStatus) {
            if (apiTimestamp) {
              this.logSdkError(sdkPrep, e, acc, apiTimestamp)
            }

            // ErrorHandler branches on `errorData.reason` (INVALID_MODEL_ID,
            // TEMPORARILY_SUSPENDED, THINKING_SIGNATURE_INVALID), so the modeled
            // exception's reason code must survive into the synthetic body.
            const errorReasonCode = typeof e?.reason === 'string' ? e.reason : undefined
            const errorBody = JSON.stringify({
              message: e.message,
              __type: e.name,
              ...(errorReasonCode !== undefined ? { reason: errorReasonCode } : {})
            })
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
              if (errorResult.pinAccount) {
                pinnedAccount = acc
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

            logTerminalSummary({
              phase: 'pre_stream_open',
              terminalSource: 'http_error',
              httpStatus: terminalStatus,
              error: describeError(e)
            })

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

          logTerminalSummary({
            phase: 'pre_stream_open',
            terminalSource: 'network_error',
            error: describeError(e)
          })
          throw e
        }
      }
    } finally {
      if (!responseOwnsLifecycle) {
        logTerminalSummary({
          phase: 'pre_stream_open',
          terminalSource: signal.aborted ? 'caller_abort' : 'request_error'
        })
        cleanupRequest()
      }
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
    return createSdkClient(auth, region, effort, {
      keepAlive: this.config.sdk_http_keep_alive
    })
  }

  private prepareSdkRequest(
    body: any,
    model: string,
    auth: KiroAuthDetails,
    think: boolean,
    budget: number,
    showToast?: (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void,
    disableReasoningReplay = false
  ): SdkPreparedRequest {
    return transformToSdkRequest(body, model, auth, think, budget, showToast, {
      effort: this.config.effort,
      autoEffortMapping: this.config.auto_effort_mapping,
      disableReasoningReplay
    })
  }

  private handleSuccessfulRequest(acc: ManagedAccount): void {
    this.accountManager.markHealthy(acc)
  }

  private logSdkRequest(prep: SdkPreparedRequest, acc: ManagedAccount, timestamp: string): void {
    logger.logApiRequest(buildSdkRequestLogPayload(prep, acc), timestamp)
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

  private commitReasoningCorrelation(
    completed: SdkCompletionPayload | undefined,
    accountId: string,
    owningAttemptId: string,
    latestAttemptId: string
  ): void {
    if (!completed || completed.loopId === undefined) return
    if (completed.attemptId === '' || completed.attemptId !== owningAttemptId) return
    if (owningAttemptId !== latestAttemptId) return

    // A final answer ends the loop, so its entries are torn down. A tool-emitting
    // turn that produced no signed envelope merely skips publication — the loop
    // continues and its other turns' envelopes must survive.
    if (completed.toolUses.length === 0) {
      reasoningCorrelationCache.clearLoop(completed.loopId)
      return
    }
    if (completed.recovered) return
    if (!completed.envelope) return

    reasoningCorrelationCache.publish({
      envelope: completed.envelope,
      reasoningText: completed.reasoningText,
      visibleText: completed.visibleText,
      toolUses: completed.toolUses.map((tool) => ({
        toolUseId: tool.toolUseId,
        name: tool.name,
        argumentsJson: normalizeToolArguments(tool.argumentsJson)
      })),
      effectiveModel: completed.effectiveModel,
      loopId: completed.loopId,
      accountId,
      attemptId: completed.attemptId
    })
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
