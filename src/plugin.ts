import { KIRO_CONSTANTS } from './constants.js'
import { AuthHandler } from './core/auth/auth-handler.js'
import { KeepAliveController } from './core/auth/token-keepalive.js'
import { RequestHandler } from './core/request/request-handler.js'
import { AccountCache } from './infrastructure/database/account-cache.js'
import { AccountRepository } from './infrastructure/database/account-repository.js'
import { AccountManager } from './plugin/accounts.js'
import { bootstrapAuthIfNeeded } from './plugin/auth-bootstrap.js'
import { loadConfig } from './plugin/config/index.js'

type ToastFunction = (message: string, variant: string) => void

const KIRO_PROVIDER_ID = 'kiro-auth'

let activeKeepAliveController: KeepAliveController | null = null
let keepAliveTeardownRegistered = false

function disposeActiveKeepAliveController(): void {
  activeKeepAliveController?.dispose()
  activeKeepAliveController = null
}

function registerKeepAliveTeardown(): void {
  if (keepAliveTeardownRegistered) {
    return
  }

  keepAliveTeardownRegistered = true
  process.once('beforeExit', disposeActiveKeepAliveController)
  process.once('SIGTERM', disposeActiveKeepAliveController)
}

function installKeepAliveController(controller: KeepAliveController, enabled: boolean): void {
  disposeActiveKeepAliveController()
  activeKeepAliveController = controller
  if (enabled) {
    registerKeepAliveTeardown()
  }
  controller.start()
}

export function __getActiveKeepAliveControllerForTest(): KeepAliveController | null {
  return activeKeepAliveController
}

export const createKiroPlugin =
  (id: string) =>
  async ({ client, directory }: any) => {
    const config = loadConfig(directory)

    const showToast: ToastFunction = (message: string, variant: string) => {
      client.tui.showToast({ body: { message, variant } }).catch(() => {})
    }

    const cache = new AccountCache(60000)
    const repository = new AccountRepository(cache)

    const authHandler = new AuthHandler(config, repository)
    const accountManager = await AccountManager.loadFromDisk(config.account_selection_strategy, {
      quotaAvoidanceEnabled: config.quota_avoidance_enabled,
      quotaReserveThreshold: config.quota_reserve_threshold
    })
    authHandler.setAccountManager(accountManager)

    const requestHandler = new RequestHandler(accountManager, config, repository, client)
    installKeepAliveController(
      new KeepAliveController(
        config,
        accountManager,
        requestHandler.sharedTokenRefresher,
        repository
      ),
      config.token_keepalive_enabled
    )

    // Compute the base URL once so both the config hook and auth loader use the same value
    const baseURL = KIRO_CONSTANTS.BASE_URL.replace('/generateAssistantResponse', '').replace(
      '{{region}}',
      config.default_region || 'us-east-1'
    )

    return {
      config: async (input: any) => {
        // Ensure there's an auth entry so OpenCode calls the loader on startup.
        // This is a no-op if the entry already exists.
        bootstrapAuthIfNeeded(id)

        if (!input.provider) input.provider = {}
        if (!input.provider[id]) input.provider[id] = {}
        // Always set npm and api — these must be present regardless of whether
        // the user has already defined the provider in their opencode.json.
        input.provider[id].npm = '@ai-sdk/openai-compatible'
        // Set the base URL at the provider level. OpenCode reads provider.api as
        // model.api.url, which resolveSDK() uses to construct the endpoint URL.
        // Only set if not already overridden by the user.
        if (!input.provider[id].api) {
          input.provider[id].api = baseURL
        }
        if (!input.provider[id].models) {
          input.provider[id].models = {
            auto: {
              name: 'Auto (1.0x)',
              limit: { context: 200000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            // Claude Sonnet
            'claude-sonnet-4': {
              name: 'Claude Sonnet 4.0 (1.3x)',
              limit: { context: 200000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            'claude-sonnet-4-5': {
              name: 'Claude Sonnet 4.5 (1.3x)',
              limit: { context: 200000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            'claude-sonnet-4-6': {
              name: 'Claude Sonnet 4.6 (1.3x)',
              limit: { context: 1000000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            'claude-sonnet-4-6-low': {
              name: 'Claude Sonnet 4.6 (low) (1.3x)',
              limit: { context: 1000000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            'claude-sonnet-4-6-medium': {
              name: 'Claude Sonnet 4.6 (medium) (1.3x)',
              limit: { context: 1000000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            'claude-sonnet-4-6-high': {
              name: 'Claude Sonnet 4.6 (high) (1.3x)',
              limit: { context: 1000000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            'claude-sonnet-4-6-max': {
              name: 'Claude Sonnet 4.6 (max) (1.3x)',
              limit: { context: 1000000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            'claude-sonnet-5': {
              name: 'Claude Sonnet 5 (1.3x)',
              limit: { context: 1000000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            'claude-sonnet-5-low': {
              name: 'Claude Sonnet 5 (low) (1.3x)',
              limit: { context: 1000000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            'claude-sonnet-5-medium': {
              name: 'Claude Sonnet 5 (medium) (1.3x)',
              limit: { context: 1000000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            'claude-sonnet-5-high': {
              name: 'Claude Sonnet 5 (high) (1.3x)',
              limit: { context: 1000000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            'claude-sonnet-5-xhigh': {
              name: 'Claude Sonnet 5 (xhigh) (1.3x)',
              limit: { context: 1000000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            'claude-sonnet-5-max': {
              name: 'Claude Sonnet 5 (max) (1.3x)',
              limit: { context: 1000000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            // Claude Haiku
            'claude-haiku-4-5': {
              name: 'Claude Haiku 4.5 (0.4x)',
              limit: { context: 200000, output: 64000 },
              modalities: { input: ['text', 'image'], output: ['text'] }
            },
            // Claude Opus
            'claude-opus-4-5': {
              name: 'Claude Opus 4.5 (2.2x)',
              limit: { context: 200000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            'claude-opus-4-6': {
              name: 'Claude Opus 4.6 (2.2x)',
              limit: { context: 1000000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            'claude-opus-4-7': {
              name: 'Claude Opus 4.7 (2.2x)',
              limit: { context: 1000000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            'claude-opus-4-7-low': {
              name: 'Claude Opus 4.7 (low) (2.2x)',
              limit: { context: 1000000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            'claude-opus-4-7-medium': {
              name: 'Claude Opus 4.7 (medium) (2.2x)',
              limit: { context: 1000000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            'claude-opus-4-7-high': {
              name: 'Claude Opus 4.7 (high) (2.2x)',
              limit: { context: 1000000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            'claude-opus-4-7-xhigh': {
              name: 'Claude Opus 4.7 (xhigh) (2.2x)',
              limit: { context: 1000000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            'claude-opus-4-7-max': {
              name: 'Claude Opus 4.7 (max) (2.2x)',
              limit: { context: 1000000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            'claude-opus-4-8': {
              name: 'Claude Opus 4.8 (2.2x)',
              limit: { context: 1000000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            'claude-opus-4-8-low': {
              name: 'Claude Opus 4.8 (low) (2.2x)',
              limit: { context: 1000000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            'claude-opus-4-8-medium': {
              name: 'Claude Opus 4.8 (medium) (2.2x)',
              limit: { context: 1000000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            'claude-opus-4-8-high': {
              name: 'Claude Opus 4.8 (high) (2.2x)',
              limit: { context: 1000000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            'claude-opus-4-8-xhigh': {
              name: 'Claude Opus 4.8 (xhigh) (2.2x)',
              limit: { context: 1000000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            'claude-opus-4-8-max': {
              name: 'Claude Opus 4.8 (max) (2.2x)',
              limit: { context: 1000000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            'claude-opus-4-8-thinking': {
              name: 'Claude Opus 4.8 Thinking (2.2x)',
              limit: { context: 1000000, output: 64000 },
              modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
            },
            // Open weight models
            'deepseek-3.2': {
              name: 'DeepSeek 3.2 (0.25x)',
              limit: { context: 128000, output: 64000 },
              modalities: { input: ['text'], output: ['text'] }
            },
            'glm-5': {
              name: 'GLM-5 (0.5x)',
              limit: { context: 200000, output: 64000 },
              modalities: { input: ['text'], output: ['text'] }
            },
            'minimax-m2.5': {
              name: 'MiniMax M2.5 (0.25x)',
              limit: { context: 200000, output: 64000 },
              modalities: { input: ['text'], output: ['text'] }
            },
            'minimax-m2.1': {
              name: 'MiniMax M2.1 (0.15x)',
              limit: { context: 200000, output: 64000 },
              modalities: { input: ['text'], output: ['text'] }
            },
            'qwen3-coder-next': {
              name: 'Qwen3 Coder Next (0.05x)',
              limit: { context: 256000, output: 64000 },
              modalities: { input: ['text'], output: ['text'] }
            }
          }
        }
      },
      auth: {
        provider: id,
        loader: async (getAuth: any) => {
          await getAuth()
          await authHandler.initialize(showToast as any)

          return {
            apiKey: '',
            // Provide baseURL explicitly so the @ai-sdk/openai-compatible provider
            // always has a valid URL. The custom fetch below intercepts all Kiro
            // API calls, so this value is only used for URL construction.
            baseURL,
            fetch: (input: any, init?: any) => requestHandler.handle(input, init, showToast)
          }
        },
        methods: authHandler.getMethods()
      },
      provider: {
        id,
        models: async (provider: any) => {
          const models = provider?.models || {}
          const normalized: Record<string, any> = {}

          for (const [modelID, model] of Object.entries(models)) {
            const modelInfo = model as any
            normalized[modelID] = {
              ...modelInfo,
              api: {
                ...(modelInfo.api || {}),
                npm: '@ai-sdk/openai-compatible',
                // Ensure url is always set. modelInfo.api.url should already be
                // populated from the config hook's provider.api field, but we
                // set it explicitly as a fallback for any edge cases.
                url: modelInfo.api?.url || baseURL
              }
            }
          }

          return normalized
        }
      }
    }
  }

export const KiroOAuthPlugin = createKiroPlugin(KIRO_PROVIDER_ID)
