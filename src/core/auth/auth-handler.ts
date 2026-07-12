import type { AuthHook } from '@opencode-ai/plugin'
import type { AccountRepository } from '../../infrastructure/database/account-repository.js'
import { RegionSchema } from '../../plugin/config/schema.js'
import { isRefreshTokenDead } from '../../plugin/health.js'
import * as logger from '../../plugin/logger.js'
import { IdcAuthMethod } from './idc-auth-method.js'
import { isInteractiveTty, ttyConfirm, ttySelect } from './tty-menu.js'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

export class AuthHandler {
  private accountManager?: any

  constructor(
    private config: any,
    private repository: AccountRepository
  ) {}

  async initialize(showToast?: ToastFunction): Promise<void> {
    const { syncFromKiroCli } = await import('../../plugin/sync/kiro-cli.js')

    logger.log('Auth init', { autoSyncKiroCli: !!this.config.auto_sync_kiro_cli })
    if (this.config.auto_sync_kiro_cli) {
      logger.log('Kiro CLI sync: start')
      await syncFromKiroCli()
      this.repository.invalidateCache()
      const accounts = await this.repository.findAll()
      if (this.accountManager) {
        for (const a of accounts) this.accountManager.addAccount(a)
      }
      logger.log('Kiro CLI sync: done', { importedAccounts: accounts.length })
    }

    this.logUsageSummary(showToast)
  }

  private logUsageSummary(showToast?: ToastFunction): void {
    if (!this.accountManager) return
    const accounts = this.accountManager.getAccounts()
    if (!accounts.length) return

    for (const acc of accounts) {
      const used = acc.usedCount ?? 0
      const limit = acc.limitCount ?? 0
      if (limit > 0) {
        const pct = Math.round((used / limit) * 100)
        const msg = `Kiro usage (${acc.email}): ${used}/${limit} (${pct}%)`
        logger.log(msg)
        if (showToast) {
          const variant = pct >= 90 ? 'warning' : 'info'
          setTimeout(() => showToast(msg, variant), 3000)
        }
      } else if (used > 0) {
        const msg = `Kiro usage (${acc.email}): ${used} requests used`
        logger.log(msg)
        if (showToast) setTimeout(() => showToast(msg, 'info'), 3000)
      }
    }
  }

  setAccountManager(am: any): void {
    this.accountManager = am
  }

  /** Summarize stored accounts for a label; guards limit=0 divide-by-zero. */
  private buildUsageSummary(accounts: any[]): string {
    if (!accounts.length) return ''

    const CAP = 3
    const parts = accounts.slice(0, CAP).map((acc) => {
      const email = acc.email || 'unknown'
      const used = acc.usedCount ?? 0
      const limit = acc.limitCount ?? 0
      const marker = isRefreshTokenDead(acc.unhealthyReason) ? ' (needs re-login)' : ''
      if (limit > 0) {
        const pct = Math.round((used / limit) * 100)
        return `${email} ${used}/${limit} (${pct}%)${marker}`
      }
      return `${email} ${used} used${marker}`
    })

    const remaining = accounts.length - Math.min(accounts.length, CAP)
    const body = remaining > 0 ? `${parts.join(' · ')} +${remaining} more` : parts.join(' · ')
    return `[current: ${body}]`
  }

  /** Format a single account as a select-option label for the remove flow. */
  private formatAccountOption(acc: any): string {
    const email = acc.email || 'unknown'
    const used = acc.usedCount ?? 0
    const limit = acc.limitCount ?? 0
    const region = acc.region || 'unknown-region'
    const health = acc.isHealthy ? 'healthy' : 'unhealthy'
    return `${email} — ${used}/${limit} (${region}, ${health})`
  }

  getMethods(): AuthHook['methods'] {
    if (!this.accountManager) {
      return []
    }

    const currentAccounts: any[] = this.accountManager.getAccounts?.() ?? []
    const usageSummary = this.buildUsageSummary(currentAccounts)
    const firstLabelBase = 'Add account · AWS Builder ID / IAM Identity Center'
    const firstLabel = usageSummary ? `${firstLabelBase}  ${usageSummary}` : firstLabelBase

    const idcMethod = new IdcAuthMethod(this.config, this.repository, this.accountManager)

    const configStartUrl = this.config.idc_start_url
    const configRegion = this.config.idc_region

    const methods: AuthHook['methods'] = [
      {
        label: firstLabel,
        type: 'oauth' as const,
        prompts: [
          {
            type: 'text' as const,
            key: 'start_url',
            message: configStartUrl
              ? `IAM Identity Center Start URL (current: ${configStartUrl}, leave blank to keep)`
              : 'IAM Identity Center Start URL (leave blank for AWS Builder ID)',
            placeholder: 'https://your-company.awsapps.com/start',
            validate: (value: string) => {
              if (!value) return undefined
              try {
                new URL(value)
                return undefined
              } catch {
                return 'Please enter a valid URL'
              }
            }
          },
          {
            type: 'text' as const,
            key: 'idc_region',
            message:
              configRegion && configRegion !== 'us-east-1'
                ? `IAM Identity Center region (sso_region) (current: ${configRegion}, leave blank to keep)`
                : 'IAM Identity Center region (sso_region) (leave blank for us-east-1)',
            placeholder: 'us-east-1',
            validate: (value: string) => {
              if (!value) return undefined
              return RegionSchema.safeParse(value.trim()).success
                ? undefined
                : 'Please enter a valid AWS region'
            }
          }
        ],
        authorize: (inputs?: any) => idcMethod.authorize(inputs)
      },
      {
        label: 'Add account · IAM Identity Center (with Profile ARN)',
        type: 'oauth' as const,
        prompts: [
          {
            type: 'text' as const,
            key: 'start_url',
            message: configStartUrl
              ? `IAM Identity Center Start URL (current: ${configStartUrl}, leave blank to keep)`
              : 'IAM Identity Center Start URL (leave blank for AWS Builder ID)',
            placeholder: 'https://your-company.awsapps.com/start',
            validate: (value: string) => {
              if (!value) return undefined
              try {
                new URL(value)
                return undefined
              } catch {
                return 'Please enter a valid URL'
              }
            }
          },
          {
            type: 'text' as const,
            key: 'idc_region',
            message:
              configRegion && configRegion !== 'us-east-1'
                ? `IAM Identity Center region (sso_region) (current: ${configRegion}, leave blank to keep)`
                : 'IAM Identity Center region (sso_region) (leave blank for us-east-1)',
            placeholder: 'us-east-1',
            validate: (value: string) => {
              if (!value) return undefined
              return RegionSchema.safeParse(value.trim()).success
                ? undefined
                : 'Please enter a valid AWS region'
            }
          },
          {
            type: 'text' as const,
            key: 'profile_arn',
            message: this.config.idc_profile_arn
              ? `Profile ARN (current: ${this.config.idc_profile_arn}, leave blank to keep)`
              : 'Profile ARN (e.g. arn:aws:codewhisperer:eu-central-1:428597928572:profile/HE7XVERQ9VXW)',
            placeholder: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/XXXXXXXXXX',
            validate: (value: string) => {
              if (!value && this.config.idc_profile_arn) return undefined
              if (!value) return 'Profile ARN is required for this method'
              return value.startsWith('arn:aws:codewhisperer:') ||
                value.startsWith('arn:aws:qdeveloper:')
                ? undefined
                : 'Please enter a valid CodeWhisperer or Q Developer profile ARN'
            }
          }
        ],
        authorize: (inputs?: any) => idcMethod.authorize(inputs)
      }
    ]

    // Removal must be `type:'oauth'`, not `type:'api'`: OpenCode forces an
    // "Enter your API key" prompt on `api` methods, breaking a removal flow.
    methods.push({
      label: 'Manage / remove accounts',
      type: 'oauth' as const,
      authorize: async () => this.authorizeRemoveAccounts()
    })

    return methods
  }

  /** Ends the auth flow cleanly with no key prompt and no credential written. */
  private endWithoutCredential(instructions: string): {
    url: string
    instructions: string
    method: 'auto'
    callback: () => Promise<{ type: 'failed' }>
  } {
    return {
      url: '',
      instructions,
      method: 'auto' as const,
      callback: async () => ({ type: 'failed' as const })
    }
  }

  /**
   * Ends the flow after a successful deletion. If a healthy account (or any
   * account with a usable access token) remains, returns a SUCCESS callback
   * keyed on that account's token so OpenCode shows success and persists a
   * still-valid credential. If nothing usable remains, falls back to a failed
   * callback (nothing left to authorize with).
   */
  private endWithRemainingCredentialOrFailed(instructions: string):
    | {
        url: string
        instructions: string
        method: 'auto'
        callback: () => Promise<{ type: 'success'; key: string }>
      }
    | {
        url: string
        instructions: string
        method: 'auto'
        callback: () => Promise<{ type: 'failed' }>
      } {
    const remaining: any[] = this.accountManager?.getAccounts?.() ?? []
    const hasToken = (acc: any): boolean =>
      typeof acc?.accessToken === 'string' && acc.accessToken.length > 0
    const fallback =
      remaining.find((acc) => acc?.isHealthy && hasToken(acc)) ??
      remaining.find((acc) => hasToken(acc))

    if (fallback) {
      const key: string = fallback.accessToken
      return {
        url: '',
        instructions: `${instructions} Using ${fallback.email || 'a remaining account'} for future requests.`,
        method: 'auto' as const,
        callback: async () => ({ type: 'success' as const, key })
      }
    }

    return this.endWithoutCredential(
      `${instructions} No accounts remain — run \`opencode auth login\` to reauthenticate.`
    )
  }

  /**
   * Self-drawn account-removal flow. No-op paths (cancel / no accounts /
   * not-confirmed / non-TTY) end with method:'auto' + a failed callback so no
   * key prompt appears and no bogus success is shown. The actual-deletion path
   * ends with a remaining-account success (or failed if none remain), so a
   * successful removal is not misreported as "Failed to authorize".
   */
  private async authorizeRemoveAccounts(): Promise<{
    url: string
    instructions: string
    method: 'auto'
    callback: () => Promise<{ type: 'failed' } | { type: 'success'; key: string }>
  }> {
    const accounts: any[] = this.accountManager?.getAccounts?.() ?? []

    if (accounts.length === 0) {
      logger.log('Remove Kiro account: no accounts to remove')
      return this.endWithoutCredential('No accounts to remove.')
    }

    if (!isInteractiveTty()) {
      logger.log('Remove Kiro account: non-TTY, skipping interactive menu')
      const sqliteHint =
        'sqlite3 ~/.config/opencode/kiro.db "DELETE FROM accounts WHERE email=\'<email>\';"'
      return this.endWithoutCredential(
        'Account removal requires an interactive terminal. Run `opencode auth login` ' +
          `in a TTY, or remove via: ${sqliteHint}`
      )
    }

    const items = accounts.map((acc) => ({
      label: this.formatAccountOption(acc),
      value: acc
    }))
    items.push({ label: 'Cancel', value: null as any })

    const target = await ttySelect<any>(items, { message: 'Select an account to remove' })
    if (!target) {
      logger.log('Remove Kiro account: cancelled (no-op)')
      return this.endWithoutCredential('Cancelled. No account removed.')
    }

    const confirmed = await ttyConfirm(`Delete ${target.email || 'this account'}?`)
    if (!confirmed) {
      logger.log('Remove Kiro account: delete not confirmed (no-op)')
      return this.endWithoutCredential('Cancelled. No account removed.')
    }

    this.accountManager.removeAccount(target)
    logger.log('Removed Kiro account', { email: target.email, accountId: String(target.id) })
    process.stdout.write('Account deleted.\n')
    return this.endWithRemainingCredentialOrFailed(`Account deleted: ${target.email || 'unknown'}.`)
  }
}
