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
    // Retry-After is load-bearing, not advisory. opencode's retry.ts takes the
    // RETRY_MAX_DELAY (2^31) cap — not the 30s no-headers cap — for any error
    // that carries response headers, and its retry count is unbounded, so a 503
    // without Retry-After grows the host backoff 2s -> 4s -> ... -> 1024s+.
    // Present, it pins backoff to this constant. 2s rounds the plugin's own
    // stream retry backoff base (250/500ms + jitter) up to the host's
    // whole-second Retry-After granularity.
    return new Response(JSON.stringify(this.toPayload()), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '2' }
    })
  }
}
