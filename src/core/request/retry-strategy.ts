interface RetryConfig {
  max_request_iterations: number
}

interface RetryContext {
  iterations: number
}

export class RetryStrategy {
  constructor(private config: RetryConfig) {}

  shouldContinue(context: RetryContext): { canContinue: boolean; error?: string } {
    context.iterations++

    if (context.iterations > this.config.max_request_iterations) {
      return {
        canContinue: false,
        error: `Exceeded max iterations (${this.config.max_request_iterations})`
      }
    }

    return { canContinue: true }
  }

  createContext(): RetryContext {
    return {
      iterations: 0
    }
  }
}
