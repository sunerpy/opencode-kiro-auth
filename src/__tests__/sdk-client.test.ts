import { GenerateAssistantResponseCommand } from '@aws/codewhisperer-streaming-client'
import { describe, expect, test } from 'bun:test'
import {
  clearSdkClientCache,
  createSdkClient,
  injectEffortIntoSerializedBody
} from '../plugin/sdk-client'
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

const serializedRequest = JSON.stringify({
  conversationState: {
    currentMessage: {
      userInputMessage: {
        modelId: 'claude-opus-4.7'
      }
    }
  }
})

class StrictJsonBytes extends Uint8Array {
  override toString(): string {
    throw new Error('request bytes must be decoded explicitly')
  }
}

describe('SDK client', () => {
  test('injects effort into a string request body without changing its representation', () => {
    const updated = injectEffortIntoSerializedBody(serializedRequest, 'max')

    expect(typeof updated).toBe('string')
    expect(JSON.parse(updated as string).additionalModelRequestFields).toEqual({
      output_config: { effort: 'max' }
    })
  })

  test('decodes and re-encodes Uint8Array request bodies explicitly', () => {
    const requestBytes = new StrictJsonBytes(new TextEncoder().encode(serializedRequest))
    const updated = injectEffortIntoSerializedBody(requestBytes, 'high')

    expect(updated).toBeInstanceOf(Uint8Array)
    expect(updated).not.toBe(requestBytes)
    const parsed = JSON.parse(new TextDecoder().decode(updated as Uint8Array))
    expect(parsed.additionalModelRequestFields).toEqual({
      output_config: { effort: 'high' }
    })
  })

  test('leaves empty, invalid, and unsupported request bodies unchanged', () => {
    const unsupportedBody = { serialized: false }
    const bodies = [undefined, null, '', 'not-json', unsupportedBody]

    for (const body of bodies) {
      expect(injectEffortIntoSerializedBody(body, 'low')).toBe(body)
    }
  })

  test('uses Kiro CLI-style standard SDK retries for throttling', async () => {
    clearSdkClientCache()

    const client = createSdkClient(auth(), 'us-east-1')

    expect(await client.config.maxAttempts()).toBe(3)
    const retryMode = client.config.retryMode
    expect(typeof retryMode === 'function' ? await retryMode() : retryMode).toBe('standard')

    clearSdkClientCache()
  })

  test('uses fresh sockets without reducing active stream capacity', async () => {
    clearSdkClientCache()

    const client = createSdkClient(auth(), 'us-east-1')
    const handlerConfig = await (client.config.requestHandler as any).configProvider

    expect(handlerConfig.httpsAgent.keepAlive).toBe(false)
    expect(handlerConfig.httpsAgent.maxSockets).toBe(50)

    clearSdkClientCache()
  })

  test('keeps transport modes in separate client cache entries', async () => {
    clearSdkClientCache()

    const fresh = createSdkClient(auth(), 'us-east-1', undefined, { keepAlive: false })
    const reused = createSdkClient(auth(), 'us-east-1', undefined, { keepAlive: true })
    const reusedAgain = createSdkClient(auth(), 'us-east-1', undefined, { keepAlive: true })
    const reusedConfig = await (reused.config.requestHandler as any).configProvider

    expect(fresh).not.toBe(reused)
    expect(reusedAgain).toBe(reused)
    expect(reusedConfig.httpsAgent.keepAlive).toBe(true)
    expect(reusedConfig.httpsAgent.maxSockets).toBe(50)

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
