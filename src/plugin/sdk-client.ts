import { CodeWhispererStreamingClient } from '@aws/codewhisperer-streaming-client'
import { KIRO_CONSTANTS } from '../constants.js'
import { buildEffortRequestFields } from './effort.js'
import type { Effort, KiroAuthDetails } from './types'

/**
 * Cache key includes effort to ensure separate clients for different effort levels,
 * since middleware is configured at client creation time.
 */
interface ClientCacheEntry {
  client: CodeWhispererStreamingClient
  token: string
  effort?: Effort
}

const clientCache = new Map<string, ClientCacheEntry>()
const KIRO_CLI_MAX_ATTEMPTS = 3

export function createSdkClient(
  auth: KiroAuthDetails,
  region: string,
  effort?: Effort
): CodeWhispererStreamingClient {
  const cacheKey = `${region}:${auth.email || 'default'}:${effort || 'none'}`
  const cached = clientCache.get(cacheKey)

  if (cached && cached.token === auth.access && cached.effort === effort) {
    return cached.client
  }

  const token = auth.access
  const client = new CodeWhispererStreamingClient({
    region,
    endpoint: `https://q.${region}.amazonaws.com`,
    token: () => Promise.resolve({ token }),
    maxAttempts: KIRO_CLI_MAX_ATTEMPTS,
    retryMode: 'standard',
    customUserAgent: [[KIRO_CONSTANTS.USER_AGENT]]
  })

  // Add Kiro-specific headers
  client.middlewareStack.add(
    (next: any) => async (args: any) => {
      args.request.headers['x-amzn-kiro-agent-mode'] = 'vibe'
      return next(args)
    },
    { step: 'build', name: 'addKiroHeaders' }
  )

  // Effort wire shape differs per family (GPT: reasoning.effort, Claude:
  // output_config.effort; each 400s the other), so derive it from the body's modelId.
  if (effort) {
    client.middlewareStack.add(
      (next: any) => async (args: any) => {
        if (args.request?.body) {
          try {
            const body = JSON.parse(args.request.body)
            const wireModel = body?.conversationState?.currentMessage?.userInputMessage?.modelId
            body.additionalModelRequestFields = buildEffortRequestFields(wireModel, effort)
            args.request.body = JSON.stringify(body)
          } catch {
            // If body parsing fails, continue without modification
          }
        }
        return next(args)
      },
      { step: 'build', name: 'addEffortConfig', priority: 'high' }
    )
  }

  clientCache.set(cacheKey, { client, token, effort })
  return client
}

export function clearSdkClientCache(): void {
  for (const entry of clientCache.values()) {
    entry.client.destroy()
  }
  clientCache.clear()
}
