import { describe, expect, test } from 'bun:test'
import {
  consumeKiroRequestMetadata,
  hashDiagnosticIdentity,
  KIRO_DIAGNOSTIC_AGENT_HEADER,
  KIRO_DIAGNOSTIC_MESSAGE_HEADER,
  KIRO_DIAGNOSTIC_SESSION_HEADER,
  KIRO_DIAGNOSTIC_TRACE_HEADER,
  KIRO_REQUEST_KIND_HEADER
} from '../core/request/request-kind.js'

describe('Kiro request kind marker', () => {
  test('consumes the private compaction header before SDK handling', () => {
    const consumed = consumeKiroRequestMetadata('https://example.test', {
      headers: {
        [KIRO_REQUEST_KIND_HEADER]: 'compaction',
        'x-preserved': 'yes'
      }
    })
    const headers = new Headers(consumed.init?.headers)

    expect(consumed.requestKind).toBe('compaction')
    expect(headers.get(KIRO_REQUEST_KIND_HEADER)).toBeNull()
    expect(headers.get('x-preserved')).toBe('yes')
  })

  test('removes unknown marker values without treating them as compaction', () => {
    const consumed = consumeKiroRequestMetadata('https://example.test', {
      headers: { [KIRO_REQUEST_KIND_HEADER]: 'future-kind' }
    })

    expect(consumed.requestKind).toBe('unknown')
    expect(new Headers(consumed.init?.headers).has(KIRO_REQUEST_KIND_HEADER)).toBe(false)
  })

  test('consumes validated diagnostic correlation headers and preserves unrelated headers', () => {
    const trace = 'f95ab753-632a-4d4f-8dd2-fb4860123456'
    const sessionHash = hashDiagnosticIdentity('ses-private')!
    const agentHash = hashDiagnosticIdentity('build-private')!
    const messageHash = hashDiagnosticIdentity('msg-private')!
    const consumed = consumeKiroRequestMetadata('https://example.test', {
      headers: {
        [KIRO_DIAGNOSTIC_TRACE_HEADER]: trace,
        [KIRO_DIAGNOSTIC_SESSION_HEADER]: sessionHash,
        [KIRO_DIAGNOSTIC_AGENT_HEADER]: agentHash,
        [KIRO_DIAGNOSTIC_MESSAGE_HEADER]: messageHash,
        'x-preserved': 'yes'
      }
    })
    const headers = new Headers(consumed.init?.headers)

    expect(consumed.diagnostics).toEqual({
      diagnosticTraceId: trace,
      sessionHash,
      agentHash,
      messageHash
    })
    for (const name of [
      KIRO_DIAGNOSTIC_TRACE_HEADER,
      KIRO_DIAGNOSTIC_SESSION_HEADER,
      KIRO_DIAGNOSTIC_AGENT_HEADER,
      KIRO_DIAGNOSTIC_MESSAGE_HEADER
    ]) {
      expect(headers.has(name)).toBe(false)
    }
    expect(headers.get('x-preserved')).toBe('yes')
  })

  test('drops malformed diagnostic values instead of reflecting them into logs', () => {
    const consumed = consumeKiroRequestMetadata('https://example.test', {
      headers: {
        [KIRO_DIAGNOSTIC_TRACE_HEADER]: 'raw session content',
        [KIRO_DIAGNOSTIC_SESSION_HEADER]: 'not-a-hash'
      }
    })

    expect(consumed.diagnostics).toEqual({})
  })
})
