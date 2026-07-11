import { describe, expect, test } from 'bun:test'
import { AccountCache } from '../infrastructure/database/account-cache.js'

// AccountCache is pure in-memory state. All assertions read back real cache
// contents. The one expiry test advances the wall clock with a *bounded* spin
// (not a scheduled timer), so it is deterministic rather than flaky.

function spinUntilClockAdvances(): void {
  const t = Date.now()
  // Bounded spin: guaranteed to exit once the ms clock ticks. Capped so a
  // pathological environment fails the test rather than hanging.
  let guard = 0
  while (Date.now() === t && guard < 5_000_000) guard++
}

describe('AccountCache getAll / setAll', () => {
  test('getAll returns null before anything is set', () => {
    const cache = new AccountCache(60000)
    expect(cache.getAll()).toBeNull()
  })

  test('setAll then getAll returns a copy of the stored accounts', () => {
    const cache = new AccountCache(60000)
    const accounts = [
      { id: 'A', usedCount: 1 },
      { id: 'B', usedCount: 2 }
    ]
    cache.setAll(accounts)
    const got = cache.getAll()
    expect(got).not.toBeNull()
    expect(got!.map((a) => a.id)).toEqual(['A', 'B'])
    // Defensive copy: mutating the returned array does not corrupt the cache.
    got!.pop()
    expect(cache.getAll()!.length).toBe(2)
  })

  test('setAll also populates the per-id map', () => {
    const cache = new AccountCache(60000)
    cache.setAll([{ id: 'A', usedCount: 1 }])
    expect(cache.get('A')).toEqual({ id: 'A', usedCount: 1 })
  })
})

describe('AccountCache get / set (per-id)', () => {
  test('get returns null for a missing id', () => {
    const cache = new AccountCache(60000)
    cache.set('A', { id: 'A' })
    expect(cache.get('B')).toBeNull()
  })

  test('set then get returns the stored account', () => {
    const cache = new AccountCache(60000)
    cache.set('A', { id: 'A', email: 'a@x' })
    expect(cache.get('A')).toEqual({ id: 'A', email: 'a@x' })
  })
})

describe('AccountCache TTL expiry', () => {
  test('getAll returns null once the TTL has elapsed', () => {
    const cache = new AccountCache(0) // 0ms TTL: expires as soon as the clock ticks
    cache.setAll([{ id: 'A' }])
    spinUntilClockAdvances()
    expect(cache.getAll()).toBeNull()
  })

  test('get returns null once the TTL has elapsed', () => {
    const cache = new AccountCache(0)
    cache.set('A', { id: 'A' })
    spinUntilClockAdvances()
    expect(cache.get('A')).toBeNull()
  })

  test('a generous TTL keeps entries live', () => {
    const cache = new AccountCache(60000)
    cache.setAll([{ id: 'A' }])
    expect(cache.getAll()).not.toBeNull()
    expect(cache.get('A')).not.toBeNull()
  })
})

describe('AccountCache invalidation', () => {
  test('invalidate(id) drops that id and clears the all-accounts cache', () => {
    const cache = new AccountCache(60000)
    cache.setAll([{ id: 'A' }, { id: 'B' }])
    cache.invalidate('A')
    expect(cache.get('A')).toBeNull()
    // The whole-list cache is dropped whenever a single id is invalidated.
    expect(cache.getAll()).toBeNull()
  })

  test('invalidateAll clears everything and forces getAll to null', () => {
    const cache = new AccountCache(60000)
    cache.setAll([{ id: 'A' }, { id: 'B' }])
    cache.invalidateAll()
    expect(cache.getAll()).toBeNull()
    expect(cache.get('A')).toBeNull()
    expect(cache.get('B')).toBeNull()
  })
})
