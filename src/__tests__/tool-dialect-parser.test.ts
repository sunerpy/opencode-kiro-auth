import { describe, expect, test } from 'bun:test'
import {
  DSML_MARKER,
  parseBracketToolCalls,
  parseTextToolCalls
} from '../infrastructure/transformers/tool-call-parser.js'
import { transformSdkStream } from '../plugin/streaming/sdk-stream-transformer.js'

function makeSdkResponse(events: any[]): any {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const e of events) yield e
    })()
  }
}

async function collectSdkChunks(events: any[]): Promise<any[]> {
  const chunks: any[] = []
  for await (const chunk of transformSdkStream(makeSdkResponse(events), 'auto', 'chatcmpl-test')) {
    chunks.push(chunk)
  }
  return chunks
}

function contentOf(chunk: any): string | undefined {
  return chunk?.choices?.[0]?.delta?.content
}

function toolStartChunks(chunks: any[]): any[] {
  return chunks.filter((c) => {
    const tc = c?.choices?.[0]?.delta?.tool_calls?.[0]
    return tc && tc.type === 'function' && tc.id !== undefined
  })
}

describe('parseTextToolCalls — Anthropic XML', () => {
  test('single complete invoke → correct name+input, span stripped', () => {
    const text =
      'before <invoke name="read"><parameter name="path">/tmp/x</parameter></invoke> after'
    const { toolCalls, cleanedText } = parseTextToolCalls(text)
    expect(toolCalls.length).toBe(1)
    expect(toolCalls[0]!.name).toBe('read')
    expect(toolCalls[0]!.input).toEqual({ path: '/tmp/x' })
    expect(cleanedText).toBe('before  after')
    expect(cleanedText).not.toContain('<invoke')
  })

  test('function_calls block with multiple invokes → 2 calls, JSON params parsed', () => {
    const text =
      '<function_calls>' +
      '<invoke name="a"><parameter name="n">5</parameter></invoke>' +
      '<invoke name="b"><parameter name="flag">true</parameter><parameter name="s">hi</parameter></invoke>' +
      '</function_calls>'
    const { toolCalls, cleanedText } = parseTextToolCalls(text)
    expect(toolCalls.length).toBe(2)
    expect(toolCalls[0]!.name).toBe('a')
    expect(toolCalls[0]!.input).toEqual({ n: 5 })
    expect(toolCalls[1]!.name).toBe('b')
    expect(toolCalls[1]!.input).toEqual({ flag: true, s: 'hi' })
    expect(cleanedText).not.toContain('<function_calls')
    expect(cleanedText).not.toContain('<invoke')
  })
})

describe('parseTextToolCalls — deepseek DSML (U+FF5C)', () => {
  test('trailing DSML fragment → marker stripped, unrelated text preserved', () => {
    const text = `Here is the answer.\n${DSML_MARKER} name="grep" {"pattern":"foo"}`
    const { cleanedText } = parseTextToolCalls(text)
    expect(cleanedText).not.toContain(DSML_MARKER)
    expect(cleanedText).toContain('Here is the answer.')
  })

  test('DSML with recoverable name+args → parsed tool call', () => {
    const text = `${DSML_MARKER} name="grep" {"pattern":"foo"}`
    const { toolCalls } = parseTextToolCalls(text)
    if (toolCalls.length > 0) {
      expect(toolCalls[0]!.name).toBe('grep')
      expect(toolCalls[0]!.input).toEqual({ pattern: 'foo' })
    }
    const { cleanedText } = parseTextToolCalls(text)
    expect(cleanedText).not.toContain(DSML_MARKER)
  })
})

describe('parseTextToolCalls — bracket regression', () => {
  test('[Called X with args:{...}] still parsed', () => {
    const text = 'ok [Called search with args: {"q":"cats"}] done'
    const { toolCalls, cleanedText } = parseTextToolCalls(text)
    expect(toolCalls.length).toBe(1)
    expect(toolCalls[0]!.name).toBe('search')
    expect(toolCalls[0]!.input).toEqual({ q: 'cats' })
    expect(cleanedText).not.toContain('[Called')
  })

  test('parseBracketToolCalls export still works', () => {
    const calls = parseBracketToolCalls('[Called foo with args: {"a":1}]')
    expect(calls.length).toBe(1)
    expect(calls[0]!.name).toBe('foo')
  })
})

describe('parseTextToolCalls — phantom / false-positive negatives', () => {
  test('prose mentioning invoke → 0 calls, text unchanged', () => {
    const text = 'we should invoke the read function to open the file'
    const { toolCalls, cleanedText } = parseTextToolCalls(text)
    expect(toolCalls.length).toBe(0)
    expect(cleanedText).toBe(text)
  })

  test('fenced code block containing <invoke> → 0 calls, text unchanged', () => {
    const text =
      'Example:\n```\n<invoke name="read"><parameter name="path">/etc/x</parameter></invoke>\n```\nend'
    const { toolCalls, cleanedText } = parseTextToolCalls(text)
    expect(toolCalls.length).toBe(0)
    expect(cleanedText).toBe(text)
  })

  test('fenced code block containing <function_calls> → 0 calls', () => {
    const text =
      'See:\n```xml\n<function_calls><invoke name="x"><parameter name="a">1</parameter></invoke></function_calls>\n```'
    const { toolCalls, cleanedText } = parseTextToolCalls(text)
    expect(toolCalls.length).toBe(0)
    expect(cleanedText).toBe(text)
  })

  test('inline code with <tag> → 0 calls', () => {
    const text = 'use the `<invoke name="x">` syntax carefully'
    const { toolCalls, cleanedText } = parseTextToolCalls(text)
    expect(toolCalls.length).toBe(0)
    expect(cleanedText).toBe(text)
  })

  test('[Called it a day] → 0 calls, text unchanged', () => {
    const text = 'we [Called it a day] and left'
    const { toolCalls, cleanedText } = parseTextToolCalls(text)
    expect(toolCalls.length).toBe(0)
    expect(cleanedText).toBe(text)
  })

  test('unclosed <invoke name="x"> (no close) → 0 calls, text unchanged', () => {
    const text = 'partial <invoke name="read"><parameter name="path">/x</parameter>'
    const { toolCalls, cleanedText } = parseTextToolCalls(text)
    expect(toolCalls.length).toBe(0)
    expect(cleanedText).toBe(text)
  })
})

describe('streaming suppression — no dialect leaks into delta.content', () => {
  function assertNoDialectLeak(chunks: any[]): void {
    const streamedText = chunks
      .map((c) => contentOf(c))
      .filter((s): s is string => s !== undefined)
      .join('')
    expect(streamedText).not.toContain('<invoke')
    expect(streamedText).not.toContain('<function_calls')
    expect(streamedText).not.toContain(DSML_MARKER)
  }

  test('XML tool call split across chunks → no leak, structured tool_call emitted', async () => {
    const events = [
      { assistantResponseEvent: { content: 'Let me read the file. ' } },
      { assistantResponseEvent: { content: '<invoke name="read"><parameter name="pa' } },
      { assistantResponseEvent: { content: 'th">/tmp/x</parameter></in' } },
      { assistantResponseEvent: { content: 'voke>' } }
    ]
    const chunks = await collectSdkChunks(events)
    assertNoDialectLeak(chunks)

    const starts = toolStartChunks(chunks)
    expect(starts.length).toBe(1)
    expect(starts[0]!.choices[0].delta.tool_calls[0].index).toBe(0)
    expect(starts[0]!.choices[0].delta.tool_calls[0].function.name).toBe('read')
  })

  test('function_calls block split across chunks → no leak, structured tool_call', async () => {
    const events = [
      { assistantResponseEvent: { content: 'Working on it.\n<function_' } },
      { assistantResponseEvent: { content: 'calls><invoke name="grep"><param' } },
      {
        assistantResponseEvent: {
          content: 'eter name="q">cats</parameter></invoke></function_calls>'
        }
      }
    ]
    const chunks = await collectSdkChunks(events)
    assertNoDialectLeak(chunks)

    const starts = toolStartChunks(chunks)
    expect(starts.length).toBe(1)
    expect(starts[0]!.choices[0].delta.tool_calls[0].function.name).toBe('grep')

    const leading = chunks
      .map((c) => contentOf(c))
      .filter((s): s is string => s !== undefined)
      .join('')
    expect(leading).toContain('Working on it.')
  })

  test('DSML marker split across chunks → no leak', async () => {
    const half = Math.floor(DSML_MARKER.length / 2)
    const events = [
      { assistantResponseEvent: { content: 'Answer done. ' } },
      { assistantResponseEvent: { content: DSML_MARKER.slice(0, half) } },
      { assistantResponseEvent: { content: DSML_MARKER.slice(half) + ' name="x" {"a":1}' } }
    ]
    const chunks = await collectSdkChunks(events)
    assertNoDialectLeak(chunks)
  })

  test('non-dialect text streams normally', async () => {
    const events = [
      { assistantResponseEvent: { content: 'Hello ' } },
      { assistantResponseEvent: { content: 'world, no tools here.' } }
    ]
    const chunks = await collectSdkChunks(events)
    const streamed = chunks
      .map((c) => contentOf(c))
      .filter((s): s is string => s !== undefined)
      .join('')
    expect(streamed).toBe('Hello world, no tools here.')
    expect(toolStartChunks(chunks).length).toBe(0)
  })
})
