import * as logger from '../../plugin/logger'
import type { StreamTerminalSource } from '../../plugin/streaming/stream-observer'
import type { ManagedAccount } from '../../plugin/types'
import { classifyAccountFailure, type AccountFailureClass } from './account-failure-classifier'
import type { RecoveryAttemptFactory, RecoveryAttemptResult } from './recovery-attempt'
import { encodeSseChunk, type SdkStreamingAttempt } from './response-handler'
import { UpstreamUnexpectedError } from './stream-error'
import {
  StreamRecoveryCoordinator,
  type StreamRecoveryMode,
  type StreamRecoveryTerminationReason
} from './stream-recovery'

const RECOVERY_QUOTA_COOLDOWN_MS = 30_000

export type LiveRecoveryOptions = {
  readonly mode: StreamRecoveryMode
  readonly maxAttempts: number
  readonly priorStreamFailures: number
  readonly signal: AbortSignal
  readonly initialAccount: ManagedAccount
  readonly failedAccountIds: Set<string>
  readonly attemptFactory: Pick<RecoveryAttemptFactory, 'open'>
  readonly retryDelay: (failureCount: number) => number
  readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>
  readonly selectAlternativeAccount: (
    excludedAccountIds: ReadonlySet<string>
  ) => Promise<ManagedAccount | null>
  readonly markRateLimited: (account: ManagedAccount, milliseconds: number) => void
  readonly describeError: (error: unknown) => unknown
  /**
   * Request-level terminal ownership. Lifecycle ownership transfers to the
   * Response, so this only ever fires on a path where the Response was actually
   * delivered to the caller — i.e. from the coordinator, exactly once.
   */
  readonly onTerminal: (details: RecoveryTerminalLogDetails) => void
  /**
   * Attempt-level release for an initial `openAttempt(1)` failure. That failure is
   * pre-output and is re-thrown for the caller's outer retry loop, so ownership has
   * NOT transferred: this callback must not run request-level cleanup and must not
   * detach the inbound abort listener, or the retry loses caller cancellation.
   */
  readonly onInitialOpenFailure: () => void
  readonly onCancel: (reason: unknown) => void
}

type RecoveryTerminalLogDetails = Readonly<Record<string, unknown>> & {
  readonly terminalSource: StreamTerminalSource
}

type RecoveryFailurePhase = 'pre_stream_open' | 'stream_iteration'
type RecoveryLogPhase = RecoveryFailurePhase | 'exact_replay' | 'completed'

type RecoveryAttemptContext = {
  readonly attemptIndex: number
  readonly attemptedAccount: ManagedAccount
  resolvedAccount?: ManagedAccount
  logDetails?: RecoveryAttemptResult['logDetails']
  openFailed: boolean
  failureRecorded: boolean
}

type RequestLogIdentity = {
  readonly conversationId?: string
  readonly model?: string
  readonly processId?: number
}

function requestLogIdentity(details: Record<string, unknown>): RequestLogIdentity | undefined {
  const identity: RequestLogIdentity = {
    ...(typeof details['conversationId'] === 'string'
      ? { conversationId: details['conversationId'] }
      : {}),
    ...(typeof details['model'] === 'string' ? { model: details['model'] } : {}),
    ...(typeof details['processId'] === 'number' ? { processId: details['processId'] } : {})
  }
  return Object.keys(identity).length > 0 ? identity : undefined
}

export async function createLiveRecoveryResponse(options: LiveRecoveryOptions): Promise<Response> {
  let nextAccount = options.initialAccount
  let completedAttempt: SdkStreamingAttempt | undefined
  let currentAttempt: RecoveryAttemptContext | undefined
  let latestRequestLogIdentity: RequestLogIdentity | undefined
  const failedAccountIds = options.failedAccountIds
  let terminalFinished = false

  const getCurrentAttempt = (): RecoveryAttemptContext => {
    if (!currentAttempt) throw new Error('No active Kiro recovery attempt context is available')
    return currentAttempt
  }

  const failurePhase = (context: RecoveryAttemptContext): RecoveryFailurePhase =>
    context.openFailed ? 'pre_stream_open' : 'stream_iteration'

  const recordFailure = (
    failure: unknown
  ): {
    context: RecoveryAttemptContext
    phase: RecoveryFailurePhase
    failureClass: AccountFailureClass
  } => {
    const context = getCurrentAttempt()
    const failureClass = classifyAccountFailure(failure)
    if (!context.failureRecorded) {
      context.failureRecorded = true
      failedAccountIds.add(context.attemptedAccount.id)
      if (failureClass === 'quota_or_rate_limit') {
        options.markRateLimited(
          context.resolvedAccount ?? context.attemptedAccount,
          RECOVERY_QUOTA_COOLDOWN_MS
        )
      }
    }
    return {
      context,
      phase: failurePhase(context),
      failureClass
    }
  }

  const attemptLogDetails = (
    context: RecoveryAttemptContext,
    phase: RecoveryLogPhase,
    cause: unknown | undefined,
    details: Record<string, unknown> = {}
  ): Record<string, unknown> => {
    const baseDetails = context.logDetails
      ? context.logDetails(details)
      : {
          ...latestRequestLogIdentity,
          ...details,
          ...(latestRequestLogIdentity ? { identitySource: 'previous_attempt' } : {})
        }
    return {
      ...baseDetails,
      account: context.attemptedAccount.email,
      accountId: context.attemptedAccount.id,
      attemptedAccount: context.attemptedAccount.email,
      attemptedAccountId: context.attemptedAccount.id,
      ...(context.resolvedAccount
        ? {
            resolvedAccount: context.resolvedAccount.email,
            resolvedAccountId: context.resolvedAccount.id
          }
        : {}),
      attemptIndex: context.attemptIndex,
      phase,
      cause: cause === undefined ? null : options.describeError(cause),
      ...(cause === undefined ? {} : { failureClass: classifyAccountFailure(cause) })
    }
  }

  const observedTerminalSource = (
    details: Record<string, unknown>
  ): StreamTerminalSource | null => {
    const source = details['terminalSource']
    switch (source) {
      case 'clean_eof_without_completion_metadata':
      case 'completion_metadata_received':
      case 'iterator_failure':
      case 'semantic_truncation':
      case 'caller_abort':
      case 'stream_attempt_budget_exhausted':
      case 'stream_processing_failure':
        return source
      default:
        return null
    }
  }

  const finishTerminal = (terminationReason: StreamRecoveryTerminationReason): void => {
    if (terminalFinished) return
    terminalFinished = true
    if (currentAttempt) {
      const observed = currentAttempt.logDetails
        ? observedTerminalSource(currentAttempt.logDetails())
        : null
      const terminalSource: StreamTerminalSource = options.signal.aborted
        ? 'caller_abort'
        : terminationReason === 'coordinator_failure'
          ? 'stream_processing_failure'
          : terminationReason === 'attempt_budget_exhausted'
            ? 'stream_attempt_budget_exhausted'
            : observed === 'semantic_truncation'
              ? observed
              : (observed ?? 'iterator_failure')
      const phase: RecoveryLogPhase = currentAttempt.openFailed
        ? 'pre_stream_open'
        : terminalSource === 'clean_eof_without_completion_metadata' ||
            terminalSource === 'completion_metadata_received'
          ? 'completed'
          : 'stream_iteration'
      options.onTerminal({
        ...attemptLogDetails(currentAttempt, phase, undefined, {
          outcome: 'terminal',
          terminalSource
        }),
        terminalSource
      })
      return
    }
    options.onTerminal({
      outcome: 'terminal',
      phase: 'stream_iteration',
      terminalSource: options.signal.aborted
        ? 'caller_abort'
        : terminationReason === 'coordinator_failure'
          ? 'stream_processing_failure'
          : terminationReason === 'attempt_budget_exhausted'
            ? 'stream_attempt_budget_exhausted'
            : 'iterator_failure'
    })
  }

  const openAttempt = async (attemptIndex: number): Promise<SdkStreamingAttempt> => {
    const attemptedAccount = nextAccount
    const context: RecoveryAttemptContext = {
      attemptIndex,
      attemptedAccount,
      openFailed: false,
      failureRecorded: false
    }
    currentAttempt = context
    try {
      const result: RecoveryAttemptResult = await options.attemptFactory.open(
        attemptIndex,
        attemptedAccount
      )
      context.resolvedAccount = result.account
      context.logDetails = result.logDetails
      latestRequestLogIdentity = requestLogIdentity(result.logDetails())
      completedAttempt = result.handle
      return result.handle
    } catch (error) {
      context.openFailed = true
      recordFailure(error)
      throw error
    }
  }

  let initialAttempt: SdkStreamingAttempt
  try {
    initialAttempt = await openAttempt(1)
  } catch (error) {
    options.onInitialOpenFailure()
    throw error
  }
  const coordinator = new StreamRecoveryCoordinator({
    mode: options.mode,
    maxAttempts: options.maxAttempts,
    signal: options.signal,
    initialAttempt,
    attemptFactory: openAttempt,
    delayFn: async (failedAttemptIndex, recoverySignal, failure) => {
      const { context, phase, failureClass } = recordFailure(failure)
      const failureCount = options.priorStreamFailures + failedAttemptIndex
      const delayMs = options.retryDelay(failureCount)
      await options.wait(delayMs, recoverySignal)
      const currentAccount = context.resolvedAccount ?? context.attemptedAccount
      let selectionReason: string
      if (failureCount === 1 && failureClass !== 'quota_or_rate_limit') {
        nextAccount = currentAccount
        selectionReason = 'first_stream_retry_reuses_current_account'
      } else {
        const alternative = await options.selectAlternativeAccount(failedAccountIds)
        if (alternative && !failedAccountIds.has(alternative.id)) {
          nextAccount = alternative
          selectionReason = 'selected_untried_account'
        } else {
          nextAccount = currentAccount
          selectionReason = alternative
            ? 'selector_returned_excluded_account'
            : 'all_candidate_accounts_excluded'
        }
      }
      logger.warn(
        'Kiro SDK event stream iteration failed',
        attemptLogDetails(context, phase, failure, {
          outcome: 'retrying',
          platform: process.platform,
          nextAttempt: failureCount + 1,
          delayMs,
          nextAccount: nextAccount.email,
          nextAccountId: nextAccount.id,
          failedAccountIds: [...failedAccountIds],
          selectionReason
        })
      )
    },
    mapError: (error) => {
      const { context, phase } = recordFailure(error)
      logger.error(
        'Kiro SDK event stream iteration failed',
        attemptLogDetails(context, phase, error, {
          outcome: 'terminated_after_output',
          platform: process.platform,
          emittedOutput: true
        })
      )
      return new UpstreamUnexpectedError(error, true)
    },
    encodeChunk: encodeSseChunk,
    onComplete: async (completion) => {
      const attempt = completedAttempt
      if (!attempt) throw new Error('No completed Kiro recovery attempt is available')
      await attempt.complete(completion)
      if (options.priorStreamFailures > 0 || completion.recoveryTier !== 'none') {
        logger.log(
          'Kiro SDK event stream retry recovered',
          attemptLogDetails(getCurrentAttempt(), 'completed', undefined, {
            outcome: 'recovered',
            attempts: options.priorStreamFailures + completion.attemptIndex
          })
        )
      }
    },
    onReplayAttempt: (telemetry, failure) => {
      const context = getCurrentAttempt()
      if (failure !== undefined) recordFailure(failure)
      logger.log(
        'Kiro exact replay attempt finished',
        attemptLogDetails(
          context,
          failure === undefined ? 'exact_replay' : failurePhase(context),
          failure,
          {
            ...telemetry,
            quotaNote: 'each exact replay attempt consumes one real SDK send'
          }
        )
      )
    },
    onTerminal: finishTerminal,
    onCancel: options.onCancel
  })

  return new Response(coordinator.stream, {
    headers: { 'Content-Type': 'text/event-stream' }
  })
}
