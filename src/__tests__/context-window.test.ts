import { describe, expect, test } from 'bun:test'
import { createKiroPlugin } from '../plugin.js'
import { getContextWindowSize } from '../plugin/models.js'

// Single-source-of-truth guard: the token-usage accounting path
// (getContextWindowSize, used by the stream transformers to report input
// tokens back to OpenCode) MUST agree with the context window the plugin
// advertises to OpenCode in the config hook (models[id].limit.context).
//
// When they disagree — as they did for gpt-5.6-* (advertised 272000, but
// getContextWindowSize hard-capped at 200000) — OpenCode's overflow check
// never trips before Kiro's real limit and the request hard-fails with
// HTTP 400 "Input is too long." This test locks the two sources together.

async function registeredModels(): Promise<Record<string, { limit: { context: number } }>> {
  const client = { tui: { showToast: async () => ({ data: {} }) } }
  const plugin = await createKiroPlugin('kiro-auth')({ client, directory: process.cwd() })
  const input: any = {}
  await plugin.config(input)
  return input.provider['kiro-auth'].models
}

describe('context-window SSOT: getContextWindowSize matches advertised limit.context', () => {
  test('every registered model agrees with its advertised context limit', async () => {
    const models = await registeredModels()
    const ids = Object.keys(models)
    expect(ids.length).toBeGreaterThan(0)
    for (const id of ids) {
      expect({ id, ctx: getContextWindowSize(id) }).toEqual({
        id,
        ctx: models[id]!.limit.context
      })
    }
  })
})

describe('context-window: effort/thinking suffixes resolve to the base limit', () => {
  test('gpt-5.6-sol family is 272000, suffix-independent', () => {
    expect(getContextWindowSize('gpt-5.6-sol')).toBe(272000)
    expect(getContextWindowSize('gpt-5.6-sol-max')).toBe(272000)
    expect(getContextWindowSize('gpt-5.6-sol-xhigh')).toBe(getContextWindowSize('gpt-5.6-sol'))
    expect(getContextWindowSize('gpt-5.6-terra-high')).toBe(272000)
    expect(getContextWindowSize('gpt-5.6-luna-low')).toBe(272000)
  })

  test('claude opus/sonnet long-context families are 1000000, suffix-independent', () => {
    expect(getContextWindowSize('claude-opus-4-8')).toBe(1000000)
    expect(getContextWindowSize('claude-opus-4-8-xhigh')).toBe(1000000)
    expect(getContextWindowSize('claude-opus-4-8-thinking')).toBe(1000000)
    expect(getContextWindowSize('claude-sonnet-5-max')).toBe(1000000)
    expect(getContextWindowSize('claude-sonnet-4-6-medium')).toBe(1000000)
  })

  test('standard-context and open-weight bases keep their advertised sizes', () => {
    expect(getContextWindowSize('claude-sonnet-4-5')).toBe(200000)
    expect(getContextWindowSize('claude-haiku-4-5')).toBe(200000)
    expect(getContextWindowSize('auto')).toBe(200000)
    expect(getContextWindowSize('deepseek-3.2')).toBe(128000)
    expect(getContextWindowSize('qwen3-coder-next')).toBe(256000)
    expect(getContextWindowSize('glm-5')).toBe(200000)
  })

  test('1m wire variants stay at 1000000', () => {
    expect(getContextWindowSize('claude-sonnet-4-6-1m')).toBe(1000000)
    expect(getContextWindowSize('claude-opus-4-6-1m')).toBe(1000000)
  })

  test('unknown / legacy ids fall back to 200000 (never throws)', () => {
    expect(getContextWindowSize('unknown-model')).toBe(200000)
    expect(getContextWindowSize('')).toBe(200000)
    expect(getContextWindowSize('claude-3-7-sonnet')).toBe(200000)
  })
})
