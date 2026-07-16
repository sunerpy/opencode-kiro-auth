import { describe, expect, test } from 'bun:test'
import { SUPPORTED_MODELS } from '../constants.js'
import { resolveKiroModel } from '../plugin/models.js'

describe('resolveKiroModel', () => {
  test('resolves newly advertised model slugs', () => {
    expect(resolveKiroModel('auto')).toBe('auto')
    expect(resolveKiroModel('deepseek-3.2')).toBe('deepseek-3.2')
    expect(resolveKiroModel('minimax-m2.5')).toBe('minimax-m2.5')
    expect(resolveKiroModel('minimax-m2.1')).toBe('minimax-m2.1')
    expect(resolveKiroModel('qwen3-coder-next')).toBe('qwen3-coder-next')
  })

  test('resolves probe-confirmed GPT 5.6 slugs to their identity wire ids', () => {
    expect(resolveKiroModel('gpt-5.6-sol')).toBe('gpt-5.6-sol')
    expect(resolveKiroModel('gpt-5.6-terra')).toBe('gpt-5.6-terra')
    expect(resolveKiroModel('gpt-5.6-luna')).toBe('gpt-5.6-luna')
  })

  test('rejects the probe-rejected GPT 5.6 naming variants (400 "Invalid model")', () => {
    expect(() => resolveKiroModel('gpt-5.6')).toThrow('Unsupported model')
    expect(() => resolveKiroModel('gpt-5-6-sol')).toThrow('Unsupported model')
    expect(() => resolveKiroModel('openai-gpt-5.6-sol')).toThrow('Unsupported model')
    expect(() => resolveKiroModel('OPENAI_GPT_5_6_SOL')).toThrow('Unsupported model')
  })

  test('raw resolveKiroModel does not expand GPT effort variants (that is resolveModelVariant job)', () => {
    expect(() => resolveKiroModel('gpt-5.6-sol-max')).toThrow('Unsupported model')
    expect(() => resolveKiroModel('gpt-5.6-sol-thinking')).toThrow('Unsupported model')
  })

  test('keeps existing supported Claude slugs intact', () => {
    expect(resolveKiroModel('claude-sonnet-4-5')).toBe('claude-sonnet-4.5')
    expect(resolveKiroModel('claude-sonnet-4')).toBe('claude-sonnet-4')
    expect(resolveKiroModel('claude-opus-4-8')).toBe('claude-opus-4.8')
    expect(resolveKiroModel('claude-opus-4-8-thinking')).toBe('claude-opus-4.8')
  })

  // Opus model-resolution coverage. Wire ids confirmed against
  // src/constants.ts MODEL_MAPPING (lines: claude-opus-4-5 -> claude-opus-4.5,
  // 4-6 -> 4.6, 4-7 -> 4.7, 4-8 -> 4.8; each `-thinking` variant maps to the
  // same non-thinking wire id).
  test('resolves the full Opus 4.5 -> 4.8 slug range to dotted wire ids', () => {
    expect(resolveKiroModel('claude-opus-4-5')).toBe('claude-opus-4.5')
    expect(resolveKiroModel('claude-opus-4-6')).toBe('claude-opus-4.6')
    expect(resolveKiroModel('claude-opus-4-7')).toBe('claude-opus-4.7')
    expect(resolveKiroModel('claude-opus-4-8')).toBe('claude-opus-4.8')
  })

  test('Opus -thinking variants resolve to the same wire id as their base slug', () => {
    expect(resolveKiroModel('claude-opus-4-5-thinking')).toBe('claude-opus-4.5')
    expect(resolveKiroModel('claude-opus-4-6-thinking')).toBe('claude-opus-4.6')
    expect(resolveKiroModel('claude-opus-4-7-thinking')).toBe('claude-opus-4.7')
    expect(resolveKiroModel('claude-opus-4-8-thinking')).toBe('claude-opus-4.8')

    expect(resolveKiroModel('claude-opus-4-5-thinking')).toBe(resolveKiroModel('claude-opus-4-5'))
    expect(resolveKiroModel('claude-opus-4-6-thinking')).toBe(resolveKiroModel('claude-opus-4-6'))
    expect(resolveKiroModel('claude-opus-4-7-thinking')).toBe(resolveKiroModel('claude-opus-4-7'))
    expect(resolveKiroModel('claude-opus-4-8-thinking')).toBe(resolveKiroModel('claude-opus-4-8'))
  })

  test('rejects an unconfirmed Opus slug (claude-opus-9)', () => {
    expect(() => resolveKiroModel('claude-opus-9')).toThrow('Unsupported model')
  })

  test('resolves probe-confirmed Sonnet 5 to wire id claude-sonnet-5 (no dot suffix)', () => {
    expect(resolveKiroModel('claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(resolveKiroModel('claude-sonnet-5-thinking')).toBe('claude-sonnet-5')
    expect(resolveKiroModel('claude-sonnet-5-thinking')).toBe(resolveKiroModel('claude-sonnet-5'))
  })

  test('rejects the probe-rejected Sonnet 5 variants (.0 and -1m returned 400)', () => {
    expect(() => resolveKiroModel('claude-sonnet-5.0')).toThrow('Unsupported model')
    expect(() => resolveKiroModel('claude-sonnet-5-1m')).toThrow('Unsupported model')
  })

  test('rejects removed qwen3-coder-480b slug', () => {
    expect(() => resolveKiroModel('qwen3-coder-480b')).toThrow(
      'Unsupported model: qwen3-coder-480b'
    )
  })

  test('supported model list excludes removed qwen3-coder-480b slug', () => {
    expect(SUPPORTED_MODELS).not.toContain('qwen3-coder-480b')
  })

  test('rejects unknown slugs', () => {
    expect(() => resolveKiroModel('this-model-does-not-exist')).toThrow(
      'Unsupported model: this-model-does-not-exist'
    )
  })
})
