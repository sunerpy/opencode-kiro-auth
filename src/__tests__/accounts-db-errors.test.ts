import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { AccountManager } from '../plugin/accounts.js'
import * as logger from '../plugin/logger.js'
import { kiroDb } from '../plugin/storage/sqlite.js'
import * as kiroCli from '../plugin/sync/kiro-cli.js'
import type { ManagedAccount } from '../plugin/types.js'

// Exercises the fire-and-forget `.catch(logger.warn)` handlers each mutator
// attaches to its kiroDb write. We use scoped spyOn (restored in afterEach) so
// nothing leaks into the DB-backed suites, unlike a global mock.module. Each
// mutator's in-memory change still lands; the rejected write must be swallowed
// and surfaced through logger.warn with the right method tag.

function makeAccount(o: Partial<ManagedAccount> & { id: string }): ManagedAccount {
  return {
    email: `${o.id}@example.com`,
    authMethod: 'idc',
    region: 'us-east-1',
    clientId: `cid-${o.id}`,
    clientSecret: `cs-${o.id}`,
    refreshToken: `refresh-${o.id}`,
    accessToken: `access-${o.id}`,
    expiresAt: Date.now() + 3600000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    ...o
  }
}

async function drainMicrotasks(turns = 50): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve()
}

const spies: Array<{ mockRestore: () => void }> = []
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore()
})

function warnTags(warn: ReturnType<typeof spyOn>): string[] {
  return warn.mock.calls.map(
    (c: unknown[]) => (c[1] as { method?: string } | undefined)?.method ?? ''
  )
}

describe('AccountManager mutators swallow rejected DB writes and warn', () => {
  test('updateUsage: in-memory update lands, rejected upsert warns with method=updateUsage', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    const upsert = spyOn(kiroDb, 'upsertAccount').mockRejectedValue(new Error('boom'))
    spies.push(warn, upsert)

    const a = makeAccount({ id: 'A' })
    const mgr = new AccountManager([a], 'sticky')
    mgr.updateUsage('A', { usedCount: 3, limitCount: 100 })
    expect(mgr.getAccounts().find((x) => x.id === 'A')!.usedCount).toBe(3)

    await drainMicrotasks()
    expect(warnTags(warn)).toContain('updateUsage')
  })

  test('addAccount: appends the account, rejected upsert warns with method=addAccount', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    const upsert = spyOn(kiroDb, 'upsertAccount').mockRejectedValue(new Error('boom'))
    spies.push(warn, upsert)

    const mgr = new AccountManager([makeAccount({ id: 'A' })], 'sticky')
    mgr.addAccount(makeAccount({ id: 'B' }))
    expect(mgr.getAccountCount()).toBe(2)

    await drainMicrotasks()
    expect(warnTags(warn)).toContain('addAccount')
  })

  test('markRateLimited: sets reset time, rejected upsert warns with method=markRateLimited', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    const upsert = spyOn(kiroDb, 'upsertAccount').mockRejectedValue(new Error('boom'))
    spies.push(warn, upsert)

    const a = makeAccount({ id: 'A' })
    const mgr = new AccountManager([a], 'sticky')
    mgr.markRateLimited(a, 1000)
    expect(mgr.getAccounts().find((x) => x.id === 'A')!.rateLimitResetTime).toBeGreaterThan(0)

    await drainMicrotasks()
    expect(warnTags(warn)).toContain('markRateLimited')
  })

  test('markUnhealthy: records reason, rejected upsert warns with method=markUnhealthy', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    const upsert = spyOn(kiroDb, 'upsertAccount').mockRejectedValue(new Error('boom'))
    spies.push(warn, upsert)

    const a = makeAccount({ id: 'A' })
    const mgr = new AccountManager([a], 'sticky')
    mgr.markUnhealthy(a, 'transient')
    expect(mgr.getAccounts().find((x) => x.id === 'A')!.unhealthyReason).toBe('transient')

    await drainMicrotasks()
    expect(warnTags(warn)).toContain('markUnhealthy')
  })

  test('updateFromAuth: applies auth, rejected upsert AND rejected CLI write both warn', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    const upsert = spyOn(kiroDb, 'upsertAccount').mockRejectedValue(new Error('boom'))
    const cli = spyOn(kiroCli, 'writeToKiroCli').mockRejectedValue(new Error('cli boom'))
    spies.push(warn, upsert, cli)

    const a = makeAccount({ id: 'A' })
    const mgr = new AccountManager([a], 'sticky')
    mgr.updateFromAuth(a, {
      refresh: 'r|c|s|idc',
      access: 'fresh-access',
      expires: Date.now() + 1000,
      authMethod: 'idc',
      region: 'us-east-1'
    })
    expect(mgr.getAccounts().find((x) => x.id === 'A')!.accessToken).toBe('fresh-access')

    await drainMicrotasks()
    const tags = warnTags(warn)
    expect(tags).toContain('updateFromAuth')
  })

  test('removeAccount: drops the account, rejected delete AND rejected tombstone both warn', async () => {
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    const del = spyOn(kiroDb, 'deleteAccount').mockRejectedValue(new Error('del boom'))
    const tomb = spyOn(kiroDb, 'addRemovedAccount').mockRejectedValue(new Error('tomb boom'))
    spies.push(warn, del, tomb)

    const a = makeAccount({ id: 'A' })
    const b = makeAccount({ id: 'B' })
    const mgr = new AccountManager([a, b], 'round-robin')
    mgr.removeAccount(a)
    expect(mgr.getAccounts().find((x) => x.id === 'A')).toBeUndefined()

    await drainMicrotasks()
    const tags = warnTags(warn)
    expect(tags).toContain('removeAccount')
    expect(tags).toContain('removeAccount:tombstone')
  })
})
