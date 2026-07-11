import Database from 'libsql'
import { existsSync } from 'node:fs'
import { extractRegionFromArn, normalizeRegion } from '../../constants'
import { createDeterministicAccountId } from '../accounts'
import * as logger from '../logger'
import { kiroDb } from '../storage/sqlite'
import { fetchUsageLimits } from '../usage'
import {
  findClientCredsRecursive,
  getCliDbPath,
  isPlaceholderEmail,
  makePlaceholderEmail,
  normalizeExpiresAt,
  safeJsonParse
} from './kiro-cli-parser'
import { readActiveProfileArnFromKiroCli } from './kiro-cli-profile'
import {
  getStaleKiroCliAccountIds,
  STALE_CLI_ACCOUNT_REASON,
  type SyncedCliAccount
} from './stale-accounts'

export async function syncFromKiroCli() {
  const dbPath = getCliDbPath()
  if (!existsSync(dbPath)) return
  try {
    const cliDb = new Database(dbPath, { readonly: true })
    cliDb.pragma('busy_timeout = 5000')
    const rows = cliDb.prepare('SELECT key, value FROM auth_kv').all() as any[]
    let activeProfileArn: string | undefined
    try {
      const stateRow = cliDb
        .prepare('SELECT value FROM state WHERE key = ?')
        .get('api.codewhisperer.profile') as any
      const parsed = safeJsonParse(stateRow?.value)
      const arn = parsed?.arn || parsed?.profileArn || parsed?.profile_arn
      if (typeof arn === 'string' && arn.trim()) activeProfileArn = arn.trim()
    } catch {
      // Ignore state read failures; token import can proceed.
    }

    const deviceRegRow = rows.find(
      (r) => typeof r?.key === 'string' && r.key.includes('device-registration')
    )
    const deviceReg = safeJsonParse(deviceRegRow?.value)
    const regCreds = deviceReg ? findClientCredsRecursive(deviceReg) : {}
    const syncedAccounts: SyncedCliAccount[] = []
    let skippedRemoved = 0

    for (const row of rows) {
      if (row.key.includes(':token')) {
        const data = safeJsonParse(row.value)
        if (!data) continue

        const isIdc = row.key.includes('odic')
        const authMethod = isIdc ? 'idc' : 'desktop'
        const oidcRegion = normalizeRegion(data.region)
        let profileArn: string | undefined = data.profile_arn || data.profileArn
        if (!profileArn && isIdc) profileArn = activeProfileArn || readActiveProfileArnFromKiroCli()
        const serviceRegion = extractRegionFromArn(profileArn) || oidcRegion
        const startUrl: string | undefined =
          typeof data.start_url === 'string'
            ? data.start_url
            : typeof data.startUrl === 'string'
              ? data.startUrl
              : undefined

        const accessToken = data.access_token || data.accessToken || ''
        const refreshToken = data.refresh_token || data.refreshToken
        if (!refreshToken) continue

        const clientId = data.client_id || data.clientId || (isIdc ? regCreds.clientId : undefined)
        const clientSecret =
          data.client_secret || data.clientSecret || (isIdc ? regCreds.clientSecret : undefined)

        if (authMethod === 'idc' && (!clientId || !clientSecret)) {
          logger.warn('Kiro CLI sync: missing IDC device credentials; skipping token import')
          continue
        }

        const cliExpiresAt =
          normalizeExpiresAt(data.expires_at ?? data.expiresAt) || Date.now() + 3600000

        let usedCount = 0
        let limitCount = 0
        let email: string | undefined
        let usageOk = false

        try {
          const authForUsage: any = {
            refresh: '',
            access: accessToken,
            expires: cliExpiresAt,
            authMethod,
            region: serviceRegion,
            profileArn,
            clientId,
            clientSecret,
            email: ''
          }
          const u = await fetchUsageLimits(authForUsage)
          usedCount = u.usedCount || 0
          limitCount = u.limitCount || 0
          if (typeof u.email === 'string' && u.email) {
            email = u.email
            usageOk = true
          }
        } catch (e) {
          logger.warn('Kiro CLI sync: failed to fetch usage/email; falling back', {
            authMethod,
            serviceRegion,
            oidcRegion
          })
          logger.debug('Kiro CLI sync: usage fetch error', e)
        }

        const all = kiroDb.getAccounts()
        if (!email) {
          const sameIdentity = all.filter((a) => {
            if (profileArn && a.auth_method === authMethod && a.profile_arn === profileArn)
              return true
            if (
              authMethod === 'idc' &&
              clientId &&
              a.auth_method === 'idc' &&
              a.client_id === clientId
            )
              return true
            return false
          })
          const realAccount = sameIdentity.find(
            (a) => typeof a.email === 'string' && a.email && !isPlaceholderEmail(a.email)
          )
          if (realAccount) {
            email = realAccount.email
          } else {
            const placeholderId = createDeterministicAccountId(
              makePlaceholderEmail(authMethod, serviceRegion, clientId, profileArn),
              authMethod,
              clientId,
              profileArn
            )
            if (await kiroDb.isAccountRemoved(placeholderId)) {
              await kiroDb.clearRemovedAccount(placeholderId)
            }
            email = makePlaceholderEmail(authMethod, serviceRegion, clientId, profileArn)
          }
        }

        const resolvedEmail =
          email || makePlaceholderEmail(authMethod, serviceRegion, clientId, profileArn)
        const hasRealEmail = !!resolvedEmail && !isPlaceholderEmail(resolvedEmail)

        const id = createDeterministicAccountId(resolvedEmail, authMethod, clientId, profileArn)

        // Cleanup runs BEFORE the fresh-enough early-continue: a lingering
        // same-identity placeholder must be removed even when the real account
        // is already up to date and would otherwise skip the rest of the round.
        if (hasRealEmail) {
          for (const row of all) {
            if (row.id === id) continue
            const sameIdentity =
              (!!profileArn && row.auth_method === authMethod && row.profile_arn === profileArn) ||
              (authMethod === 'idc' &&
                !!clientId &&
                row.auth_method === 'idc' &&
                row.client_id === clientId)
            if (!sameIdentity) continue
            if (!isPlaceholderEmail(row.email)) continue
            // Prove the row is a genuine placeholder by self-consistency against
            // its OWN fields (clientId rotates across device re-registration, so
            // recomputing with the current token's clientId would miss it). A
            // real email can never equal its own makePlaceholderEmail recompute,
            // so this never deletes a real account.
            const rowPlaceholderEmail = makePlaceholderEmail(
              row.auth_method,
              row.region,
              row.client_id,
              row.profile_arn
            )
            const rowPlaceholderId = createDeterministicAccountId(
              rowPlaceholderEmail,
              row.auth_method,
              row.client_id,
              row.profile_arn
            )
            if (row.email === rowPlaceholderEmail && row.id === rowPlaceholderId) {
              await kiroDb.deleteAccount(row.id)
              await kiroDb.addRemovedAccount(row.id)
            }
          }
        }

        const existingById = all.find((a) => a.id === id)
        if (
          existingById &&
          existingById.is_healthy === 1 &&
          existingById.expires_at >= cliExpiresAt &&
          existingById.expires_at > Date.now()
        )
          continue

        if (await kiroDb.isAccountRemoved(id)) {
          skippedRemoved++
          continue
        }

        await kiroDb.upsertAccount({
          id,
          email: resolvedEmail,
          authMethod,
          region: serviceRegion,
          oidcRegion,
          clientId,
          clientSecret,
          profileArn,
          startUrl,
          refreshToken,
          accessToken,
          expiresAt: cliExpiresAt,
          rateLimitResetTime: 0,
          isHealthy: true,
          failCount: 0,
          usedCount,
          limitCount,
          lastSync: Date.now()
        })

        syncedAccounts.push({
          id,
          email: resolvedEmail,
          authMethod,
          clientId,
          profileArn
        })
      }
    }

    const staleIds = getStaleKiroCliAccountIds(kiroDb.getAccounts(), syncedAccounts)
    if (staleIds.length > 0) {
      await kiroDb.markAccountsUnhealthy(staleIds, STALE_CLI_ACCOUNT_REASON)
      logger.warn('Kiro CLI sync: deactivated stale cached accounts', { count: staleIds.length })
    }

    logger.log('Kiro CLI sync: done', { synced: syncedAccounts.length, skippedRemoved })

    cliDb.close()
  } catch (e) {
    logger.error('Sync failed', e)
  }
}

export async function writeToKiroCli(acc: any) {
  const dbPath = getCliDbPath()
  if (!existsSync(dbPath)) return
  try {
    const cliDb = new Database(dbPath)
    cliDb.pragma('busy_timeout = 5000')
    const rows = cliDb.prepare('SELECT key, value FROM auth_kv').all() as any[]
    const targetKey = acc.authMethod === 'idc' ? 'kirocli:odic:token' : 'kirocli:social:token'
    const row = rows.find((r) => r.key === targetKey || r.key.endsWith(targetKey))
    if (row) {
      const data = JSON.parse(row.value)
      data.access_token = acc.accessToken
      data.refresh_token = acc.refreshToken
      data.expires_at = new Date(acc.expiresAt).toISOString()
      cliDb.prepare('UPDATE auth_kv SET value = ? WHERE key = ?').run(JSON.stringify(data), row.key)
    }
    cliDb.close()
  } catch (e) {
    logger.warn('Write back failed', e)
  }
}
