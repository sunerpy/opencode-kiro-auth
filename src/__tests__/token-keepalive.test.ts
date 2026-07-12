import { afterEach, describe, expect, mock, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { KeepAliveController, type KeepAliveConfig } from '../core/auth/token-keepalive.js'
import { TokenRefresher } from '../core/auth/token-refresher.js'
import { AccountCache } from '../infrastructure/database/account-cache.js'
import { AccountRepository } from '../infrastructure/database/account-repository.js'
import { AccountManager } from '../plugin/accounts.js'
import {
  getKeepAliveLockPath,
  tryAcquireKeepAliveLock
} from '../plugin/storage/locked-operations.js'
import type { KiroAuthDetails, ManagedAccount } from '../plugin/types.js'

type Variant = 'info' | 'warning' | 'success' | 'error'
type ToastFunction = (message: string, variant: Variant) => void
type RefreshResult = { account: ManagedAccount; shouldContinue: boolean }
type RefreshImplementation = (
  account: ManagedAccount,
  auth: KiroAuthDetails,
  showToast: ToastFunction
) => Promise<RefreshResult>

const keepAliveEnabledConfig: KeepAliveConfig = {
  token_keepalive_enabled: true,
  token_keepalive_interval_ms: 60000,
  token_expiry_buffer_ms: 120000
}

const keepAliveDisabledConfig: KeepAliveConfig = {
  ...keepAliveEnabledConfig,
  token_keepalive_enabled: false
}

const refresherConfig = {
  token_expiry_buffer_ms: 120000,
  auto_sync_kiro_cli: false,
  account_selection_strategy: 'sticky' as const
}

const controllers: KeepAliveController[] = []

afterEach(() => {
  for (const controller of controllers.splice(0)) {
    controller.dispose()
  }
  rmSync(getKeepAliveLockPath(), { force: true })
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | null = null
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  if (!resolvePromise) {
    throw new Error('Deferred resolver was not initialized')
  }
  return { promise, resolve: resolvePromise }
}

function makeAccount(overrides: Partial<ManagedAccount> & { id: string }): ManagedAccount {
  return {
    email: `${overrides.id}@example.com`,
    authMethod: 'idc',
    region: 'us-east-1',
    clientId: `cid-${overrides.id}`,
    clientSecret: `cs-${overrides.id}`,
    profileArn: `arn-${overrides.id}`,
    refreshToken: `refresh-${overrides.id}`,
    accessToken: `access-${overrides.id}`,
    expiresAt: Date.now() + 3600000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    ...overrides
  }
}

function makeRepository(): AccountRepository {
  return new AccountRepository(new AccountCache(60000))
}

function makeRefresher(
  manager: AccountManager,
  implementation?: RefreshImplementation
): { refresher: TokenRefresher; refreshIfNeeded: ReturnType<typeof mock<RefreshImplementation>> } {
  const refresher = new TokenRefresher(
    refresherConfig,
    manager,
    mock(async () => {}),
    makeRepository()
  )
  const refreshIfNeeded = mock<RefreshImplementation>(
    implementation ?? (async (account) => ({ account, shouldContinue: false }))
  )
  refresher.refreshIfNeeded = refreshIfNeeded
  return { refresher, refreshIfNeeded }
}

function makeController(
  config: KeepAliveConfig,
  manager: AccountManager,
  refresher: TokenRefresher
): KeepAliveController {
  const controller = new KeepAliveController(config, manager, refresher, makeRepository())
  controllers.push(controller)
  return controller
}

function firstRefreshCall(refreshIfNeeded: ReturnType<typeof mock<RefreshImplementation>>) {
  const call = refreshIfNeeded.mock.calls[0]
  if (!call) {
    throw new Error('Expected refreshIfNeeded to be called')
  }
  return call
}

describe('KeepAliveController.start', () => {
  test('does not register timers when token keep-alive is disabled by default', () => {
    const manager = new AccountManager([], 'sticky')
    const { refresher } = makeRefresher(manager)
    const controller = makeController(keepAliveDisabledConfig, manager, refresher)

    controller.start()

    expect(controller['initialDelayTimer']).toBeNull()
    expect(controller['intervalTimer']).toBeNull()
  })
})

describe('KeepAliveController.runOnceForTest', () => {
  test('leader refreshes only near-expiry healthy accounts', async () => {
    const nearExpiry = makeAccount({ id: 'near-expiry', expiresAt: Date.now() + 60000 })
    const fresh = makeAccount({ id: 'fresh', expiresAt: Date.now() + 3600000 })
    const permanentlyUnhealthy = makeAccount({
      id: 'permanent',
      expiresAt: Date.now() + 60000,
      isHealthy: false,
      unhealthyReason: 'invalid_grant',
      failCount: 10
    })
    const manager = new AccountManager([nearExpiry, fresh, permanentlyUnhealthy], 'sticky')
    const { refresher, refreshIfNeeded } = makeRefresher(manager)
    const controller = makeController(keepAliveEnabledConfig, manager, refresher)

    await controller.runOnceForTest()

    expect(refreshIfNeeded).toHaveBeenCalledTimes(1)
    const [refreshedAccount] = firstRefreshCall(refreshIfNeeded)
    expect(refreshedAccount.id).toBe('near-expiry')
  })

  test('skips refresh work when this process is not the keep-alive leader', async () => {
    const release = await tryAcquireKeepAliveLock()
    expect(release).not.toBeNull()
    if (!release) {
      throw new Error('Expected test process to acquire the leader lock first')
    }

    const nearExpiry = makeAccount({ id: 'non-leader', expiresAt: Date.now() + 60000 })
    const manager = new AccountManager([nearExpiry], 'sticky')
    const { refresher, refreshIfNeeded } = makeRefresher(manager)
    const controller = makeController(keepAliveEnabledConfig, manager, refresher)

    try {
      await controller.runOnceForTest()

      expect(refreshIfNeeded).toHaveBeenCalledTimes(0)
    } finally {
      await release()
    }
  })

  test('allows only one of two contending controllers to refresh while the leader holds the lock', async () => {
    const firstAccount = makeAccount({ id: 'leader-A', expiresAt: Date.now() + 60000 })
    const secondAccount = makeAccount({ id: 'leader-B', expiresAt: Date.now() + 60000 })
    const firstManager = new AccountManager([firstAccount], 'sticky')
    const secondManager = new AccountManager([secondAccount], 'sticky')
    const firstRefreshStarted = deferred()
    const releaseFirstRefresh = deferred()
    const { refresher: firstRefresher, refreshIfNeeded: firstRefreshIfNeeded } = makeRefresher(
      firstManager,
      async (account) => {
        firstRefreshStarted.resolve()
        await releaseFirstRefresh.promise
        return { account, shouldContinue: false }
      }
    )
    const { refresher: secondRefresher, refreshIfNeeded: secondRefreshIfNeeded } =
      makeRefresher(secondManager)
    const firstController = makeController(keepAliveEnabledConfig, firstManager, firstRefresher)
    const secondController = makeController(keepAliveEnabledConfig, secondManager, secondRefresher)

    const firstTick = firstController.runOnceForTest()
    await firstRefreshStarted.promise

    await secondController.runOnceForTest()

    expect(secondRefreshIfNeeded).toHaveBeenCalledTimes(0)

    releaseFirstRefresh.resolve()
    await firstTick

    expect(firstRefreshIfNeeded).toHaveBeenCalledTimes(1)
    expect(firstRefreshIfNeeded.mock.calls.length + secondRefreshIfNeeded.mock.calls.length).toBe(1)
  })

  test('lets a later controller take over after the per-tick leader releases the lock', async () => {
    const firstAccount = makeAccount({ id: 'takeover-A', expiresAt: Date.now() + 60000 })
    const secondAccount = makeAccount({ id: 'takeover-B', expiresAt: Date.now() + 60000 })
    const firstManager = new AccountManager([firstAccount], 'sticky')
    const secondManager = new AccountManager([secondAccount], 'sticky')
    const firstRefreshStarted = deferred()
    const releaseFirstRefresh = deferred()
    const { refresher: firstRefresher, refreshIfNeeded: firstRefreshIfNeeded } = makeRefresher(
      firstManager,
      async (account) => {
        firstRefreshStarted.resolve()
        await releaseFirstRefresh.promise
        return { account, shouldContinue: false }
      }
    )
    const { refresher: secondRefresher, refreshIfNeeded: secondRefreshIfNeeded } =
      makeRefresher(secondManager)
    const firstController = makeController(keepAliveEnabledConfig, firstManager, firstRefresher)
    const secondController = makeController(keepAliveEnabledConfig, secondManager, secondRefresher)

    const firstTick = firstController.runOnceForTest()
    await firstRefreshStarted.promise

    await secondController.runOnceForTest()

    expect(secondRefreshIfNeeded).toHaveBeenCalledTimes(0)

    releaseFirstRefresh.resolve()
    await firstTick

    // Keep-alive leadership is acquired and released once per tick. The stale
    // timeout only protects a process that crashes while holding the tick lock;
    // after normal release, the next process can deterministically take over.
    await secondController.runOnceForTest()

    expect(firstRefreshIfNeeded).toHaveBeenCalledTimes(1)
    expect(secondRefreshIfNeeded).toHaveBeenCalledTimes(1)
  })

  test('skips a concurrent tick while a previous tick is still running', async () => {
    const nearExpiry = makeAccount({ id: 'reentry', expiresAt: Date.now() + 60000 })
    const manager = new AccountManager([nearExpiry], 'sticky')
    const refreshStarted = deferred()
    const releaseRefresh = deferred()
    const { refresher, refreshIfNeeded } = makeRefresher(manager, async (account) => {
      refreshStarted.resolve()
      await releaseRefresh.promise
      return { account, shouldContinue: false }
    })
    const controller = makeController(keepAliveEnabledConfig, manager, refresher)

    const firstTick = controller.runOnceForTest()
    await refreshStarted.promise
    await controller.runOnceForTest()

    expect(refreshIfNeeded).toHaveBeenCalledTimes(1)

    releaseRefresh.resolve()
    await firstTick
  })

  test('clears timers on dispose and ignores later test ticks after disposal', async () => {
    const nearExpiry = makeAccount({ id: 'disposed', expiresAt: Date.now() + 60000 })
    const manager = new AccountManager([nearExpiry], 'sticky')
    const { refresher, refreshIfNeeded } = makeRefresher(manager)
    const controller = makeController(keepAliveEnabledConfig, manager, refresher)

    controller.start()
    expect(controller['initialDelayTimer']).not.toBeNull()
    expect(controller['intervalTimer']).not.toBeNull()

    controller.dispose()

    expect(controller['initialDelayTimer']).toBeNull()
    expect(controller['intervalTimer']).toBeNull()

    await controller.runOnceForTest()

    expect(refreshIfNeeded).toHaveBeenCalledTimes(0)
  })

  test('swallows refresh failures so a keep-alive tick does not reject', async () => {
    const nearExpiry = makeAccount({ id: 'failure', expiresAt: Date.now() + 60000 })
    const manager = new AccountManager([nearExpiry], 'sticky')
    const { refresher, refreshIfNeeded } = makeRefresher(manager, async () => {
      throw new Error('refresh failed')
    })
    const controller = makeController(keepAliveEnabledConfig, manager, refresher)

    await controller.runOnceForTest()

    expect(refreshIfNeeded).toHaveBeenCalledTimes(1)
  })
})
