import { describe, expect, test } from 'bun:test'
import {
  findClientCredsRecursive,
  getCliDbPath,
  isPlaceholderEmail,
  makePlaceholderEmail,
  normalizeExpiresAt,
  safeJsonParse
} from '../plugin/sync/kiro-cli-parser.js'

describe('safeJsonParse', () => {
  test('parses a valid JSON string', () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 })
  })

  test('returns null for malformed JSON', () => {
    expect(safeJsonParse('{not json')).toBeNull()
  })

  test('returns null for a non-string input', () => {
    expect(safeJsonParse(123)).toBeNull()
    expect(safeJsonParse(null)).toBeNull()
    expect(safeJsonParse(undefined)).toBeNull()
    expect(safeJsonParse({ already: 'object' })).toBeNull()
  })

  test('parses valid JSON arrays and primitives', () => {
    expect(safeJsonParse('[1,2,3]')).toEqual([1, 2, 3])
    expect(safeJsonParse('"str"')).toBe('str')
    expect(safeJsonParse('true')).toBe(true)
  })
})

describe('normalizeExpiresAt', () => {
  test('seconds epoch (< 10^10) is scaled to milliseconds', () => {
    const seconds = 1_700_000_000
    expect(normalizeExpiresAt(seconds)).toBe(seconds * 1000)
  })

  test('millisecond epoch (>= 10^10) is returned unchanged', () => {
    const ms = 1_700_000_000_000
    expect(normalizeExpiresAt(ms)).toBe(ms)
  })

  test('ISO date string is parsed to a millisecond timestamp', () => {
    const iso = '2030-01-01T00:00:00.000Z'
    expect(normalizeExpiresAt(iso)).toBe(new Date(iso).getTime())
  })

  test('numeric string is coerced then normalized as seconds', () => {
    expect(normalizeExpiresAt('1700000000')).toBe(1_700_000_000 * 1000)
  })

  test('empty / whitespace string returns 0', () => {
    expect(normalizeExpiresAt('')).toBe(0)
    expect(normalizeExpiresAt('   ')).toBe(0)
  })

  test('unparseable string returns 0', () => {
    expect(normalizeExpiresAt('not-a-date')).toBe(0)
  })

  test('non-number non-string input returns 0', () => {
    expect(normalizeExpiresAt(null)).toBe(0)
    expect(normalizeExpiresAt(undefined)).toBe(0)
    expect(normalizeExpiresAt({})).toBe(0)
  })
})

describe('findClientCredsRecursive', () => {
  test('finds top-level snake_case creds', () => {
    expect(findClientCredsRecursive({ client_id: 'cid', client_secret: 'secret' })).toEqual({
      clientId: 'cid',
      clientSecret: 'secret'
    })
  })

  test('finds camelCase creds', () => {
    expect(findClientCredsRecursive({ clientId: 'cid', clientSecret: 'sec' })).toEqual({
      clientId: 'cid',
      clientSecret: 'sec'
    })
  })

  test('finds creds nested several levels deep', () => {
    const input = { a: { b: { registration: { client_id: 'deep', client_secret: 'ds' } } } }
    expect(findClientCredsRecursive(input)).toEqual({ clientId: 'deep', clientSecret: 'ds' })
  })

  test('descends into arrays', () => {
    const input = { items: [{ noop: 1 }, { client_id: 'ac', client_secret: 'as' }] }
    expect(findClientCredsRecursive(input)).toEqual({ clientId: 'ac', clientSecret: 'as' })
  })

  test('returns empty object when no creds present', () => {
    expect(findClientCredsRecursive({ foo: 'bar', nested: { baz: 1 } })).toEqual({})
  })

  test('returns empty object for non-object input', () => {
    expect(findClientCredsRecursive(null)).toEqual({})
    expect(findClientCredsRecursive('string')).toEqual({})
    expect(findClientCredsRecursive(42)).toEqual({})
  })

  test('ignores empty-string creds and keeps searching', () => {
    const input = {
      empty: { client_id: '', client_secret: '' },
      real: { client_id: 'r', client_secret: 'rs' }
    }
    expect(findClientCredsRecursive(input)).toEqual({ clientId: 'r', clientSecret: 'rs' })
  })

  test('handles a circular structure without infinite loop', () => {
    const a: any = { name: 'a' }
    const b: any = { name: 'b', back: a }
    a.forward = b
    a.client_id = 'cyc'
    a.client_secret = 'cs'
    expect(findClientCredsRecursive(a)).toEqual({ clientId: 'cyc', clientSecret: 'cs' })
  })
})

describe('makePlaceholderEmail / isPlaceholderEmail', () => {
  test('placeholder email is deterministic and matches the isPlaceholder predicate', () => {
    const e1 = makePlaceholderEmail('idc', 'us-east-1', 'cid', 'arn')
    const e2 = makePlaceholderEmail('idc', 'us-east-1', 'cid', 'arn')
    expect(e1).toBe(e2)
    expect(isPlaceholderEmail(e1)).toBe(true)
    expect(e1.endsWith('@awsapps.local')).toBe(true)
    expect(e1.startsWith('idc-placeholder+')).toBe(true)
  })

  test('different identities produce different placeholders', () => {
    const a = makePlaceholderEmail('idc', 'us-east-1', 'cidA', 'arn')
    const b = makePlaceholderEmail('idc', 'us-east-1', 'cidB', 'arn')
    expect(a).not.toBe(b)
  })

  test('isPlaceholderEmail rejects real emails and non-strings', () => {
    expect(isPlaceholderEmail('real@example.com')).toBe(false)
    expect(isPlaceholderEmail('missing-marker@awsapps.local')).toBe(false)
    expect(isPlaceholderEmail('x-placeholder+abc@notlocal.com')).toBe(false)
    expect(isPlaceholderEmail(null)).toBe(false)
    expect(isPlaceholderEmail(123)).toBe(false)
  })
})

describe('getCliDbPath', () => {
  const saved = process.env.KIROCLI_DB_PATH
  test('honors the KIROCLI_DB_PATH override', () => {
    process.env.KIROCLI_DB_PATH = '/custom/path/data.sqlite3'
    expect(getCliDbPath()).toBe('/custom/path/data.sqlite3')
    if (saved === undefined) delete process.env.KIROCLI_DB_PATH
    else process.env.KIROCLI_DB_PATH = saved
  })

  test('without override, returns a data.sqlite3 path under a kiro-cli dir', () => {
    const saved2 = process.env.KIROCLI_DB_PATH
    delete process.env.KIROCLI_DB_PATH
    const p = getCliDbPath()
    expect(p).toContain('kiro-cli')
    expect(p.endsWith('data.sqlite3')).toBe(true)
    if (saved2 !== undefined) process.env.KIROCLI_DB_PATH = saved2
  })
})
