import { GenerateAssistantResponseCommand } from '@aws/codewhisperer-streaming-client'
import { describe, expect, test } from 'bun:test'
import { clearSdkClientCache, createSdkClient } from '../plugin/sdk-client'
import type { KiroAuthDetails } from '../plugin/types'

function auth(): KiroAuthDetails {
  return {
    refresh: 'refresh-token',
    access: 'access-token',
    expires: Date.now() + 3600000,
    authMethod: 'idc',
    region: 'us-east-1',
    email: 'user@example.com'
  }
}

describe('SDK client', () => {
  test('uses Kiro CLI-style standard SDK retries for throttling', async () => {
    clearSdkClientCache()

    const client = createSdkClient(auth(), 'us-east-1')

    expect(await client.config.maxAttempts()).toBe(3)
    const retryMode = client.config.retryMode
    expect(typeof retryMode === 'function' ? await retryMode() : retryMode).toBe('standard')

    clearSdkClientCache()
  })

  test('injects effort before content-length is computed', async () => {
    clearSdkClientCache()

    const client = createSdkClient(auth(), 'us-east-1', 'max')
    let capturedRequest: any

    client.middlewareStack.add(
      () => async (args: any) => {
        capturedRequest = args.request
        throw new Error('captured-request')
      },
      { step: 'finalizeRequest', name: 'captureRequest', priority: 'high' }
    )

    const command = new GenerateAssistantResponseCommand({
      conversationState: {
        chatTriggerType: 'MANUAL',
        conversationId: 'test-conversation',
        currentMessage: {
          userInputMessage: {
            content: 'hello',
            modelId: 'claude-opus-4.7',
            origin: 'AI_EDITOR'
          }
        }
      }
    })

    await client.send(command).catch((error) => {
      if (error.message !== 'captured-request') throw error
    })

    const bodyText =
      typeof capturedRequest.body === 'string'
        ? capturedRequest.body
        : Buffer.from(capturedRequest.body).toString('utf8')
    const body = JSON.parse(bodyText)

    expect(body.additionalModelRequestFields.output_config.effort).toBe('max')
    expect(Number(capturedRequest.headers['content-length'])).toBe(Buffer.byteLength(bodyText))

    clearSdkClientCache()
  })
})
