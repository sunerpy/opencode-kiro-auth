import { describe, expect, test } from 'bun:test'
import {
  convertToolsToCodeWhisperer,
  deduplicateToolResults
} from '../infrastructure/transformers/tool-transformer.js'

describe('convertToolsToCodeWhisperer', () => {
  test('OpenAI function tool -> toolSpecification (exact shape)', () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather for a city',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city']
          }
        }
      }
    ]

    expect(convertToolsToCodeWhisperer(tools)).toEqual([
      {
        toolSpecification: {
          name: 'get_weather',
          description: 'Get weather for a city',
          inputSchema: {
            json: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city']
            }
          }
        }
      }
    ])
  })

  test('Anthropic-style tool (name/description/input_schema) -> toolSpecification', () => {
    const tools = [
      {
        name: 'search',
        description: 'Search the web',
        input_schema: { type: 'object', properties: { q: { type: 'string' } } }
      }
    ]

    expect(convertToolsToCodeWhisperer(tools)).toEqual([
      {
        toolSpecification: {
          name: 'search',
          description: 'Search the web',
          inputSchema: {
            json: { type: 'object', properties: { q: { type: 'string' } } }
          }
        }
      }
    ])
  })

  test('missing description defaults to empty string', () => {
    const result = convertToolsToCodeWhisperer([{ name: 'noop' }])
    expect(result[0].toolSpecification.description).toBe('')
    expect(result[0].toolSpecification.name).toBe('noop')
  })

  test('missing schema defaults to empty object', () => {
    const result = convertToolsToCodeWhisperer([{ name: 'noop' }])
    expect(result[0].toolSpecification.inputSchema).toEqual({ json: {} })
  })

  test('description longer than 9216 chars is truncated', () => {
    const longDesc = 'x'.repeat(10000)
    const result = convertToolsToCodeWhisperer([
      { function: { name: 't', description: longDesc, parameters: {} } }
    ])
    expect(result[0].toolSpecification.description.length).toBe(9216)
  })

  test('OpenAI name/params take precedence via function.* when top-level absent', () => {
    const result = convertToolsToCodeWhisperer([
      { function: { name: 'fn_name', parameters: { type: 'object' } } }
    ])
    expect(result[0].toolSpecification.name).toBe('fn_name')
    expect(result[0].toolSpecification.inputSchema.json).toEqual({ type: 'object' })
  })

  test('empty tools array -> empty array', () => {
    expect(convertToolsToCodeWhisperer([])).toEqual([])
  })
})

describe('deduplicateToolResults', () => {
  test('keeps first occurrence of each toolUseId, drops later duplicates', () => {
    const trs = [
      { toolUseId: 'a', content: [{ text: 'first-a' }], status: 'success' },
      { toolUseId: 'b', content: [{ text: 'first-b' }], status: 'success' },
      { toolUseId: 'a', content: [{ text: 'dup-a' }], status: 'success' }
    ]
    expect(deduplicateToolResults(trs)).toEqual([
      { toolUseId: 'a', content: [{ text: 'first-a' }], status: 'success' },
      { toolUseId: 'b', content: [{ text: 'first-b' }], status: 'success' }
    ])
  })

  test('no duplicates -> unchanged order and content', () => {
    const trs = [
      { toolUseId: 'x', content: [{ text: '1' }] },
      { toolUseId: 'y', content: [{ text: '2' }] }
    ]
    expect(deduplicateToolResults(trs)).toEqual(trs)
  })

  test('empty input -> empty output', () => {
    expect(deduplicateToolResults([])).toEqual([])
  })
})
