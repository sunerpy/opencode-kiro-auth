import {
  GenerateAssistantResponseCommand,
  type GenerateAssistantResponseCommandOutput
} from '@aws/codewhisperer-streaming-client'
import type { KiroConfig } from '../../plugin/config'
import * as logger from '../../plugin/logger'
import { EmittedOutputAccumulator } from '../../plugin/reasoning/emitted-output'
import { StreamObserver } from '../../plugin/streaming/stream-observer'
import type { KiroAuthDetails, ManagedAccount, SdkPreparedRequest } from '../../plugin/types'
import type {
  ResponseHandler,
  SdkCompletionPayload,
  SdkResponseLifecycle,
  SdkStreamingAttempt
} from './response-handler'
import { SdkEventStreamIterationError } from './stream-error'
import { STREAM_MISSING_COMPLETION_LOG } from './stream-log-events'

type RecoveryConfig = Pick<
  KiroConfig,
  | 'enable_log_api_request'
  | 'request_timeout_ms'
  | 'sdk_http_keep_alive'
  | 'sdk_response_timeout_enabled'
  | 'sdk_response_timeout_ms'
  | 'stream_event_timeout_enabled'
  | 'stream_max_attempts'
  | 'stream_recovery_mode'
>

export type RecoveryAttemptSeed = {
  readonly account: ManagedAccount
  readonly auth: KiroAuthDetails
  readonly prepared: SdkPreparedRequest
  readonly observer: StreamObserver
  readonly emitted: EmittedOutputAccumulator
  readonly eventCount: number
  readonly startedAt: number
  readonly apiTimestamp: string | null
}

export type RecoveryRequestContext = {
  readonly body: unknown
  readonly model: string
  readonly think: boolean
  readonly budget: number
  readonly disableReasoningReplay: boolean
  readonly inheritedLoopId: string | undefined
  readonly signal: AbortSignal
  readonly priorStreamFailures: number
}

export type RecoveryAttemptServices = {
  readonly consumeRequestIteration: () => void
  readonly toAuthDetails: (account: ManagedAccount) => KiroAuthDetails
  readonly refreshAccount: (
    account: ManagedAccount,
    auth: KiroAuthDetails
  ) => Promise<{ readonly account: ManagedAccount; readonly shouldContinue: boolean }>
  readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>
  readonly prepareRequest: (account: ManagedAccount, auth: KiroAuthDetails) => SdkPreparedRequest
  readonly makeSdkClient: (
    auth: KiroAuthDetails,
    prepared: SdkPreparedRequest
  ) => {
    readonly send: (
      command: GenerateAssistantResponseCommand,
      options: { readonly abortSignal: AbortSignal }
    ) => Promise<GenerateAssistantResponseCommandOutput>
  }
  readonly responseHandler: ResponseHandler
  readonly beginUpstreamWait: (
    phase: 'SDK response' | 'stream event',
    timeoutMs: number,
    details: Record<string, unknown>
  ) => void
  readonly endUpstreamWait: () => void
  readonly nextAccountAttemptEpoch: (accountId: string) => number
  readonly isAccountAttemptCurrent: (accountId: string, epoch: number) => boolean
  readonly setCurrentAttemptId: (attemptId: string) => void
  readonly getCurrentAttemptId: () => string
  readonly markSuccessful: (account: ManagedAccount) => void
  readonly syncUsage: (
    account: ManagedAccount,
    auth: KiroAuthDetails,
    isCurrent: () => boolean
  ) => Promise<void>
  readonly commitReasoning: (
    completed: SdkCompletionPayload | undefined,
    accountId: string,
    owningAttemptId: string,
    latestAttemptId: string
  ) => void
  readonly logSdkRequest: (
    prepared: SdkPreparedRequest,
    account: ManagedAccount,
    timestamp: string
  ) => void
  readonly logSdkResponse: (prepared: SdkPreparedRequest, timestamp: string) => void
  readonly markSendResolved: () => void
  readonly describeError: (error: unknown) => unknown
}

export type RecoveryAttemptResult = {
  readonly account: ManagedAccount
  readonly handle: SdkStreamingAttempt
  readonly logDetails: (details?: Record<string, unknown>) => Record<string, unknown>
}

export type RecoveryAttemptFactoryOptions = {
  readonly config: RecoveryConfig
  readonly request: RecoveryRequestContext
  readonly initial: RecoveryAttemptSeed
  readonly services: RecoveryAttemptServices
}

export class RecoveryAttemptFactory {
  private readonly config: RecoveryConfig
  private readonly request: RecoveryRequestContext
  private readonly initial: RecoveryAttemptSeed
  private readonly services: RecoveryAttemptServices

  constructor(options: RecoveryAttemptFactoryOptions) {
    this.config = options.config
    this.request = options.request
    this.initial = options.initial
    this.services = options.services
  }

  async open(
    attemptIndex: number,
    selectedAccount: ManagedAccount
  ): Promise<RecoveryAttemptResult> {
    const state = await this.resolveAttemptState(attemptIndex, selectedAccount)
    let eventCount = state.eventCount
    const absoluteAttempt = this.request.priorStreamFailures + attemptIndex
    const logDetails = (details: Record<string, unknown> = {}): Record<string, unknown> => ({
      conversationId: state.prepared.conversationId,
      model: this.request.model,
      effectiveModel: state.prepared.effectiveModel,
      region: state.prepared.region,
      account: state.account.email,
      accountId: state.account.id,
      streamAttempt: absoluteAttempt,
      maxStreamAttempts: this.config.stream_max_attempts,
      streamDeliveryMode: 'live',
      sdkHttpKeepAlive: this.config.sdk_http_keep_alive,
      processId: process.pid,
      bunVersion: process.versions.bun,
      upstreamEventCount: eventCount,
      streamElapsedMs: Date.now() - state.startedAt,
      emittedReasoningChars: state.emitted.reasoningText.length,
      emittedVisibleChars: state.emitted.visibleText.length,
      emittedToolCount: state.emitted.toolUses().length,
      sawToolIntent: state.observer.sawToolIntent,
      ...details
    })

    if (state.apiTimestamp && attemptIndex > 1) {
      this.services.logSdkRequest(state.prepared, state.account, state.apiTimestamp)
    }

    const epoch = this.services.nextAccountAttemptEpoch(state.account.id)
    const isCurrent = (): boolean => this.services.isAccountAttemptCurrent(state.account.id, epoch)
    const attemptId = crypto.randomUUID()
    this.services.setCurrentAttemptId(attemptId)
    let completionDone = false
    const onComplete = async (completed?: SdkCompletionPayload): Promise<void> => {
      if (!completionDone) {
        completionDone = true
        if (isCurrent()) {
          this.services.markSuccessful(state.account)
          await this.services.syncUsage(state.account, state.auth, isCurrent)
        }
      }
      this.services.commitReasoning(
        completed,
        state.account.id,
        attemptId,
        this.services.getCurrentAttemptId()
      )
    }
    const lifecycle: SdkResponseLifecycle = {
      signal: this.request.signal,
      onUpstreamWaitStart: ({ eventIndex }) => {
        eventCount = eventIndex
        if (eventIndex === 0) {
          if (!this.config.sdk_response_timeout_enabled) this.services.endUpstreamWait()
          return
        }
        if (!this.config.stream_event_timeout_enabled) return
        this.services.beginUpstreamWait('stream event', this.config.request_timeout_ms, {
          conversationId: state.prepared.conversationId,
          model: this.request.model,
          effectiveModel: state.prepared.effectiveModel,
          region: state.prepared.region,
          eventIndex
        })
      },
      onUpstreamWaitEnd: this.services.endUpstreamWait,
      onIterationError: (error, afterCompletionMetadata) => {
        if (!afterCompletionMetadata) return
        logger.log(
          'Kiro SDK event stream closed after completion metadata',
          logDetails({
            outcome: 'ignored_after_completion_metadata',
            platform: process.platform,
            afterCompletionMetadata,
            error: this.services.describeError(error)
          })
        )
      },
      onCleanEofWithoutCompletionMetadata: () => {
        logger.warn(
          STREAM_MISSING_COMPLETION_LOG,
          logDetails({ outcome: 'clean_eof_without_completion_metadata' })
        )
      },
      onComplete,
      streamObserver: state.observer,
      emittedOutput: state.emitted,
      attemptId,
      ...(this.request.inheritedLoopId !== undefined
        ? { inheritedLoopId: this.request.inheritedLoopId }
        : {}),
      effectiveModel: state.prepared.effectiveModel,
      recoveryMode: this.config.stream_recovery_mode
    }

    const client = this.services.makeSdkClient(state.auth, state.prepared)
    const command = new GenerateAssistantResponseCommand({
      conversationState: state.prepared.conversationState as never,
      profileArn: state.prepared.profileArn
    })
    this.beginSdkResponseWait(state.prepared)

    let sdkResponse: GenerateAssistantResponseCommandOutput
    try {
      sdkResponse = await client.send(command, { abortSignal: this.request.signal })
    } catch (error) {
      this.services.endUpstreamWait()
      throw error
    }
    this.services.markSendResolved()
    if (state.apiTimestamp) this.services.logSdkResponse(state.prepared, state.apiTimestamp)

    const handle = await this.services.responseHandler.prepareSdkStreamingAttempt({
      sdkResponse,
      model: this.request.model,
      conversationId: state.prepared.conversationId,
      lifecycle,
      recoveryMode: this.config.stream_recovery_mode
    })
    return { account: state.account, handle, logDetails }
  }

  private async resolveAttemptState(
    attemptIndex: number,
    selectedAccount: ManagedAccount
  ): Promise<RecoveryAttemptSeed> {
    if (attemptIndex === 1) return this.initial
    this.services.consumeRequestIteration()

    let account = selectedAccount
    let auth = this.services.toAuthDetails(account)
    const refreshed = await this.services.refreshAccount(account, auth)
    account = refreshed.account
    if (refreshed.shouldContinue) {
      await this.services.wait(500, this.request.signal)
      throw new SdkEventStreamIterationError(
        new Error('Kiro token refresh requested another recovery iteration')
      )
    }
    auth = this.services.toAuthDetails(account)
    return {
      account,
      auth,
      prepared: this.services.prepareRequest(account, auth),
      observer: new StreamObserver(),
      emitted: new EmittedOutputAccumulator(),
      eventCount: 0,
      startedAt: Date.now(),
      apiTimestamp: this.config.enable_log_api_request ? logger.getTimestamp() : null
    }
  }

  private beginSdkResponseWait(prepared: SdkPreparedRequest): void {
    if (!this.config.sdk_response_timeout_enabled) return
    const messageContext =
      prepared.conversationState.currentMessage?.userInputMessage?.userInputMessageContext
    this.services.beginUpstreamWait('SDK response', this.config.sdk_response_timeout_ms, {
      conversationId: prepared.conversationId,
      model: this.request.model,
      effectiveModel: prepared.effectiveModel,
      effort: prepared.effort,
      region: prepared.region,
      historyLength: prepared.conversationState.history?.length ?? 0,
      toolCount: messageContext?.tools?.length ?? 0
    })
  }
}
