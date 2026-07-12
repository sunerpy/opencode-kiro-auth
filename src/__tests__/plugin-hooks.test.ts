import { afterEach, describe, expect, test } from 'bun:test'
import { __getActiveKeepAliveControllerForTest, createKiroPlugin } from '../plugin.js'

const PROVIDER_ID = 'kiro-auth'

function makeFakeClient() {
  const toasts: Array<{ message: string; variant: string }> = []
  return {
    toasts,
    client: {
      tui: {
        showToast: async (arg: any) => {
          toasts.push({ message: arg.body.message, variant: arg.body.variant })
          return { data: {} }
        }
      }
    }
  }
}

afterEach(() => {
  __getActiveKeepAliveControllerForTest()?.dispose()
})

async function initPlugin() {
  const { client } = makeFakeClient()
  const plugin = await createKiroPlugin(PROVIDER_ID)({ client, directory: process.cwd() })
  return plugin
}

describe('config hook', () => {
  test('sets npm to @ai-sdk/openai-compatible and api to the region base URL', async () => {
    const plugin = await initPlugin()
    const input: any = {}
    await plugin.config(input)

    expect(input.provider[PROVIDER_ID].npm).toBe('@ai-sdk/openai-compatible')
    expect(input.provider[PROVIDER_ID].api).toBe('https://q.us-east-1.amazonaws.com')
  })

  test('populates the default models map including effort variants', async () => {
    const plugin = await initPlugin()
    const input: any = {}
    await plugin.config(input)

    const models = input.provider[PROVIDER_ID].models
    expect(models.auto).toBeDefined()
    expect(models['claude-sonnet-4-5']).toBeDefined()
    expect(models['claude-opus-4-8']).toBeDefined()
    expect(models['claude-opus-4-8-xhigh']).toBeDefined()
    expect(models['claude-sonnet-5-max']).toBeDefined()
    expect(models['deepseek-3.2']).toBeDefined()
    expect(models['glm-5']).toBeDefined()
  })

  test('a model entry carries name, limit, and modalities', async () => {
    const plugin = await initPlugin()
    const input: any = {}
    await plugin.config(input)

    const sonnet = input.provider[PROVIDER_ID].models['claude-sonnet-4-5']
    expect(sonnet.name).toBe('Claude Sonnet 4.5 (1.3x)')
    expect(sonnet.limit).toEqual({ context: 200000, output: 64000 })
    expect(sonnet.modalities).toEqual({ input: ['text', 'image', 'pdf'], output: ['text'] })
  })

  test('does not overwrite a user-defined api or models block', async () => {
    const plugin = await initPlugin()
    const input: any = {
      provider: {
        [PROVIDER_ID]: {
          api: 'https://custom.example.com',
          models: { 'my-model': { name: 'Custom' } }
        }
      }
    }
    await plugin.config(input)

    expect(input.provider[PROVIDER_ID].api).toBe('https://custom.example.com')
    expect(input.provider[PROVIDER_ID].models).toEqual({ 'my-model': { name: 'Custom' } })
    // npm is always forced regardless of user overrides
    expect(input.provider[PROVIDER_ID].npm).toBe('@ai-sdk/openai-compatible')
  })
})

describe('auth hook', () => {
  test('provider matches the plugin id and methods is an array', async () => {
    const plugin = await initPlugin()
    expect(plugin.auth.provider).toBe(PROVIDER_ID)
    expect(Array.isArray(plugin.auth.methods)).toBe(true)
  })

  test('loader returns baseURL, empty apiKey, and a fetch function', async () => {
    const plugin = await initPlugin()
    const getAuth = async () => ({})
    const loaded = await plugin.auth.loader(getAuth)

    expect(loaded.apiKey).toBe('')
    expect(loaded.baseURL).toBe('https://q.us-east-1.amazonaws.com')
    expect(typeof loaded.fetch).toBe('function')
  })
})

describe('provider hook', () => {
  test('normalizes each model to add api.npm and api.url fallback', async () => {
    const plugin = await initPlugin()
    const normalized = await plugin.provider.models({
      models: {
        'claude-sonnet-4-5': { name: 'Sonnet' }
      }
    })

    expect(normalized['claude-sonnet-4-5'].api.npm).toBe('@ai-sdk/openai-compatible')
    expect(normalized['claude-sonnet-4-5'].api.url).toBe('https://q.us-east-1.amazonaws.com')
    expect(normalized['claude-sonnet-4-5'].name).toBe('Sonnet')
  })

  test('preserves an already-set model api.url', async () => {
    const plugin = await initPlugin()
    const normalized = await plugin.provider.models({
      models: {
        m: { name: 'M', api: { url: 'https://explicit.example.com' } }
      }
    })
    expect(normalized.m.api.url).toBe('https://explicit.example.com')
    expect(normalized.m.api.npm).toBe('@ai-sdk/openai-compatible')
  })

  test('empty provider.models -> empty normalized map', async () => {
    const plugin = await initPlugin()
    expect(await plugin.provider.models({ models: {} })).toEqual({})
    expect(await plugin.provider.models({})).toEqual({})
  })

  test('provider hook id matches the plugin id', async () => {
    const plugin = await initPlugin()
    expect(plugin.provider.id).toBe(PROVIDER_ID)
  })
})

describe('keep-alive singleton guard', () => {
  test('disposes the previous controller when the plugin is initialized twice', async () => {
    await initPlugin()
    const firstController = __getActiveKeepAliveControllerForTest()
    expect(firstController).not.toBeNull()
    if (!firstController) {
      throw new Error('Expected first keep-alive controller to be installed')
    }
    expect(firstController['disposed']).toBe(false)

    await initPlugin()
    const secondController = __getActiveKeepAliveControllerForTest()
    expect(secondController).not.toBeNull()
    if (!secondController) {
      throw new Error('Expected second keep-alive controller to be installed')
    }

    expect(secondController).not.toBe(firstController)
    expect(firstController['disposed']).toBe(true)
    expect(firstController['initialDelayTimer']).toBeNull()
    expect(firstController['intervalTimer']).toBeNull()
    expect(secondController['disposed']).toBe(false)
  })
})
