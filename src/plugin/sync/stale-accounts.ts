import { isPermanentError } from '../health'

export type SyncedCliAccount = {
  id: string
  email: string
  authMethod: 'idc' | 'desktop'
  clientId?: string
  profileArn?: string
}

export const STALE_CLI_ACCOUNT_REASON =
  'InvalidTokenException: Replaced by active Kiro CLI account during sync'

export function getStaleKiroCliAccountIds(
  accounts: any[],
  syncedAccounts: SyncedCliAccount[]
): string[] {
  if (syncedAccounts.length === 0) return []

  const syncedIds = new Set(syncedAccounts.map((acc) => acc.id))

  return accounts
    .filter((account) => {
      if (!account?.id || syncedIds.has(account.id)) return false

      const authMethod = account.auth_method || account.authMethod
      const email = account.email
      const clientId = account.client_id || account.clientId
      const profileArn = account.profile_arn || account.profileArn
      const lastSync = account.last_sync || account.lastSync || 0
      const unhealthyReason = account.unhealthy_reason || account.unhealthyReason

      return syncedAccounts.some((synced) => {
        const sameAuthMethod = authMethod === synced.authMethod
        const sameEmail = !!email && email === synced.email
        const sameClient = !!clientId && clientId === synced.clientId
        const sameProfile = !!profileArn && profileArn === synced.profileArn
        const sameIdentity = sameEmail || sameClient || sameProfile

        if (sameAuthMethod && sameIdentity) return true
        if (sameAuthMethod && lastSync > 0) return true
        return isPermanentError(unhealthyReason) && sameIdentity
      })
    })
    .map((account) => account.id)
}
