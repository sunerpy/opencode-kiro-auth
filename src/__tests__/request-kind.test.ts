import { describe, expect, test } from 'bun:test'
import { consumeKiroRequestKind, KIRO_REQUEST_KIND_HEADER } from '../core/request/request-kind.js'

describe('Kiro request kind marker', () => {
  test('consumes the private compaction header before SDK handling', () => {
    const consumed = consumeKiroRequestKind('https://example.test', {
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
    const consumed = consumeKiroRequestKind('https://example.test', {
      headers: { [KIRO_REQUEST_KIND_HEADER]: 'future-kind' }
    })

    expect(consumed.requestKind).toBe('unknown')
    expect(new Headers(consumed.init?.headers).has(KIRO_REQUEST_KIND_HEADER)).toBe(false)
  })
})
