export interface UpstreamUnexpectedPayload {
  retryable: true
  phase: 'stream'
  emittedOutput: boolean
  code: 'UPSTREAM_UNEXPECTED'
}

export class SdkEventStreamIterationError extends Error {
  override readonly name = 'SdkEventStreamIterationError'

  constructor(cause: unknown) {
    super('Kiro SDK event stream iteration failed', { cause })
  }
}

export class UpstreamUnexpectedError extends Error {
  override readonly name = 'UpstreamUnexpectedError'
  readonly retryable = true
  readonly phase = 'stream'
  readonly code = 'UPSTREAM_UNEXPECTED'

  constructor(
    cause: unknown,
    readonly emittedOutput: boolean
  ) {
    super('Kiro upstream event stream failed unexpectedly', { cause })
  }

  toPayload(): UpstreamUnexpectedPayload {
    return {
      retryable: true,
      phase: 'stream',
      emittedOutput: this.emittedOutput,
      code: 'UPSTREAM_UNEXPECTED'
    }
  }

  toResponse(): Response {
    return new Response(JSON.stringify(this.toPayload()), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}
