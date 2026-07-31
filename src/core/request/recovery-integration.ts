import * as logger from '../../plugin/logger'
import type { ManagedAccount } from '../../plugin/types'
import type { RecoveryAttemptFactory, RecoveryAttemptResult } from './recovery-attempt'
import { encodeSseChunk, type SdkStreamingAttempt } from './response-handler'
import { UpstreamUnexpectedError } from './stream-error'
import { StreamRecoveryCoordinator, type StreamRecoveryMode } from './stream-recovery'

export type LiveRecoveryOptions = {
  readonly mode: StreamRecoveryMode
  readonly maxAttempts: number
  readonly priorStreamFailures: number
  readonly signal: AbortSignal
  readonly initialAccount: ManagedAccount
  readonly attemptFactory: Pick<RecoveryAttemptFactory, 'open'>
  readonly retryDelay: (failureCount: number) => number
  readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>
  readonly selectAlternativeAccount: (excludedAccountId: string) => Promise<ManagedAccount | null>
  readonly describeError: (error: unknown) => unknown
  readonly onTerminal: () => void
  readonly onCancel: (reason: unknown) => void
}

export async function createLiveRecoveryResponse(options: LiveRecoveryOptions): Promise<Response> {
  let activeAccount = options.initialAccount
  let nextAccount = options.initialAccount
  let completedAttempt: SdkStreamingAttempt | undefined
  let activeLogDetails = (_details: Record<string, unknown> = {}): Record<string, unknown> => ({})
  let terminalFinished = false
  const finishTerminal = (): void => {
    if (terminalFinished) return
    terminalFinished = true
    options.onTerminal()
  }

  const openAttempt = async (attemptIndex: number): Promise<SdkStreamingAttempt> => {
    const result: RecoveryAttemptResult = await options.attemptFactory.open(
      attemptIndex,
      nextAccount
    )
    activeAccount = result.account
    completedAttempt = result.handle
    activeLogDetails = result.logDetails
    return result.handle
  }

  let initialAttempt: SdkStreamingAttempt
  try {
    initialAttempt = await openAttempt(1)
  } catch (error) {
    finishTerminal()
    throw error
  }
  const coordinator = new StreamRecoveryCoordinator({
    mode: options.mode,
    maxAttempts: options.maxAttempts,
    signal: options.signal,
    initialAttempt,
    attemptFactory: openAttempt,
    delayFn: async (failedAttemptIndex, recoverySignal) => {
      const failureCount = options.priorStreamFailures + failedAttemptIndex
      const delayMs = options.retryDelay(failureCount)
      await options.wait(delayMs, recoverySignal)
      nextAccount =
        failureCount === 1
          ? activeAccount
          : ((await options.selectAlternativeAccount(activeAccount.id)) ?? activeAccount)
      logger.warn(
        'Kiro SDK event stream iteration failed',
        activeLogDetails({
          outcome: 'retrying',
          platform: process.platform,
          nextAttempt: failureCount + 1,
          delayMs,
          nextAccount: nextAccount.email
        })
      )
    },
    mapError: (error) => {
      logger.error(
        'Kiro SDK event stream iteration failed',
        activeLogDetails({
          outcome: 'terminated_after_output',
          platform: process.platform,
          emittedOutput: true,
          error: options.describeError(error)
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
          activeLogDetails({
            outcome: 'recovered',
            attempts: options.priorStreamFailures + completion.attemptIndex
          })
        )
      }
    },
    onReplayAttempt: (telemetry) => {
      logger.log(
        'Kiro exact replay attempt finished',
        activeLogDetails({
          ...telemetry,
          quotaNote: 'each exact replay attempt consumes one real SDK send'
        })
      )
    },
    onTerminal: finishTerminal,
    onCancel: options.onCancel
  })

  return new Response(coordinator.stream, {
    headers: { 'Content-Type': 'text/event-stream' }
  })
}
