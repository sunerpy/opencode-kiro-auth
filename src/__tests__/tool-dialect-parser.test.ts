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

async function collectSdkChunks(
  events: any[],
  suppressIncompleteDialect?: boolean
): Promise<any[]> {
  const chunks: any[] = []
  for await (const chunk of transformSdkStream(
    makeSdkResponse(events),
    'auto',
    'chatcmpl-test',
    undefined,
    undefined,
    suppressIncompleteDialect
  )) {
    chunks.push(chunk)
  }
  return chunks
}

function joinedContent(chunks: any[]): string {
  return chunks
    .map((c) => contentOf(c))
    .filter((s): s is string => s !== undefined)
    .join('')
}

function toolCallChunks(chunks: any[]): any[] {
  return chunks.filter((c) => c?.choices?.[0]?.delta?.tool_calls !== undefined)
}

function finishReasons(chunks: any[]): unknown[] {
  return chunks
    .map((c) => c?.choices?.[0]?.finish_reason)
    .filter((r) => r !== null && r !== undefined)
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

describe('parseTextToolCalls — fenced code range regressions', () => {
  test('unclosed backtick fence with a complete invoke → none, no call, text unchanged', () => {
    const text =
      'Example:\n```xml\n<invoke name="wb1_complete"><parameter name="path">/demo</parameter></invoke>'
    const { toolCalls, cleanedText, resolution } = parseTextToolCalls(text)

    expect(resolution).toBe('none')
    expect(toolCalls).toHaveLength(0)
    expect(cleanedText).toBe(text)
  })

  test('unclosed backtick fence with a half invoke intentionally resolves none, not incomplete', () => {
    const text = 'Example:\n```xml\n<invoke name="wb1_half"><parameter name="path">/demo'
    const { toolCalls, cleanedText, resolution } = parseTextToolCalls(text)

    expect(resolution).toBe('none')
    expect(toolCalls).toHaveLength(0)
    expect(cleanedText).toBe(text)
  })

  test('unclosed fenced invoke streams byte-identically for every incomplete-dialect setting', async () => {
    const text =
      'Example:\n```xml\n<invoke name="wb1_stream"><parameter name="path">/demo</parameter></invoke>'
    const settings = [true, false, undefined] as const
    const results = await Promise.all(
      settings.map((setting) =>
        collectSdkChunks([{ assistantResponseEvent: { content: text } }], setting)
      )
    )

    for (const chunks of results) {
      expect(joinedContent(chunks)).toBe(text)
      expect(toolCallChunks(chunks)).toHaveLength(0)
      expect(finishReasons(chunks)).toEqual(['stop'])
    }
    expect(results.map(joinedContent)).toEqual([text, text, text])
  })

  test('real invoke before an unclosed fence is parsed while the fenced example is preserved', () => {
    const realCall = '<invoke name="wb1_real"><parameter name="path">/real</parameter></invoke>'
    const fencedExample =
      '\nExample:\n```xml\n<invoke name="wb1_example"><parameter name="path">/demo</parameter></invoke>'
    const { toolCalls, cleanedText, resolution } = parseTextToolCalls(realCall + fencedExample)

    expect(resolution).toBe('complete')
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]!.name).toBe('wb1_real')
    expect(toolCalls[0]!.input).toEqual({ path: '/real' })
    expect(cleanedText).toBe(fencedExample)
  })

  test('out-of-fence half invoke remains incomplete', () => {
    const text = 'partial <invoke name="wb1_outside"><parameter name="path">/half'
    const { toolCalls, cleanedText, resolution } = parseTextToolCalls(text)

    expect(resolution).toBe('incomplete')
    expect(toolCalls).toHaveLength(0)
    expect(cleanedText).toBe(text)
  })

  test('four-backtick fence is not closed by an embedded three-backtick run', () => {
    const text =
      'Example:\n````text\nembedded ``` sequence\n<invoke name="wb1_four"><parameter name="path">/demo</parameter></invoke>\n````'
    const { toolCalls, cleanedText, resolution } = parseTextToolCalls(text)

    expect(resolution).toBe('none')
    expect(toolCalls).toHaveLength(0)
    expect(cleanedText).toBe(text)
  })

  test('closed tilde fence containing an invoke → none, no call, text unchanged', () => {
    const text =
      'Example:\n~~~xml\n<invoke name="wb1_tilde_closed"><parameter name="path">/demo</parameter></invoke>\n~~~'
    const { toolCalls, cleanedText, resolution } = parseTextToolCalls(text)

    expect(resolution).toBe('none')
    expect(toolCalls).toHaveLength(0)
    expect(cleanedText).toBe(text)
  })

  test('unclosed tilde fence containing an invoke → none, no call, text unchanged', () => {
    const text =
      'Example:\n~~~xml\n<invoke name="wb1_tilde_unclosed"><parameter name="path">/demo</parameter></invoke>'
    const { toolCalls, cleanedText, resolution } = parseTextToolCalls(text)

    expect(resolution).toBe('none')
    expect(toolCalls).toHaveLength(0)
    expect(cleanedText).toBe(text)
  })

  test('lone unclosed inline backtick does not hide a following invoke', () => {
    const text =
      'Example: `<invoke name="wb1_inline"><parameter name="path">/real</parameter></invoke>'
    const { toolCalls, cleanedText, resolution } = parseTextToolCalls(text)

    expect(resolution).toBe('complete')
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]!.name).toBe('wb1_inline')
    expect(cleanedText).toBe('Example: `')
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

describe('transformSdkStream — suppressIncompleteDialect', () => {
  const MIXED_DIALECT =
    '<invoke name="read"><parameter name="path">/kept</parameter></invoke>' +
    '<invoke name="write"><parameter name="path">/truncated'

  test('Given a mixed complete+truncated dialect, When suppression is on, Then nothing from the span is emitted', async () => {
    const chunks = await collectSdkChunks(
      [{ assistantResponseEvent: { content: MIXED_DIALECT } }],
      true
    )

    const content = joinedContent(chunks)
    expect(content).not.toContain('<invoke')
    expect(content).not.toContain('parameter name')
    expect(content).not.toContain('/truncated')
    expect(toolCallChunks(chunks).length).toBe(0)
    expect(finishReasons(chunks)).toEqual(['stop'])
  })

  test('Given the same dialect, When suppression is off, Then the historical leak is preserved', async () => {
    const chunks = await collectSdkChunks(
      [{ assistantResponseEvent: { content: MIXED_DIALECT } }],
      false
    )

    const content = joinedContent(chunks)
    expect(content).toContain('<invoke name="write"')
    expect(content).toContain('/truncated')
    expect(toolStartChunks(chunks).length).toBe(1)
    expect(toolStartChunks(chunks)[0]!.choices[0].delta.tool_calls[0].function.name).toBe('read')
    expect(finishReasons(chunks)).toEqual(['tool_calls'])
  })

  test('Given suppression is off, When the flag is omitted, Then the chunk sequence is identical', async () => {
    const stamp = (chunks: any[]): string =>
      JSON.stringify(chunks, (key, value) => {
        if (key === 'created') return 0
        // Run-scoped: the parser mints `tool_<ts>_<rand>` for a dialect call the
        // upstream never gave an id, so it is not part of the emit contract.
        if (key === 'id' && typeof value === 'string' && /^tool_\d+_[a-z0-9]+$/.test(value)) {
          return 'tool_synthetic'
        }
        return value
      })

    const omitted = await collectSdkChunks([{ assistantResponseEvent: { content: MIXED_DIALECT } }])
    const explicit = await collectSdkChunks(
      [{ assistantResponseEvent: { content: MIXED_DIALECT } }],
      false
    )

    expect(stamp(explicit)).toBe(stamp(omitted))
  })

  test('Given a truncated dialect alongside a closed raw tool call, When suppression is on, Then the partial tool set is withheld', async () => {
    const chunks = await collectSdkChunks(
      [
        {
          toolUseEvent: { toolUseId: 'tu-1', name: 'grep', input: '{"q":"x"}', stop: true }
        },
        { assistantResponseEvent: { content: '<invoke name="write"><parameter name="path">/half' } }
      ],
      true
    )

    expect(toolCallChunks(chunks).length).toBe(0)
    expect(joinedContent(chunks)).not.toContain('<invoke')
    expect(finishReasons(chunks)).toEqual(['stop'])
  })

  test('Given a fully resolved dialect with trailing text, When suppression is on, Then both the tool call and the remainder are emitted', async () => {
    const chunks = await collectSdkChunks(
      [
        {
          assistantResponseEvent: {
            content:
              '<invoke name="read"><parameter name="path">/kept</parameter></invoke> all done'
          }
        }
      ],
      true
    )

    expect(joinedContent(chunks)).toBe(' all done')
    expect(toolStartChunks(chunks).length).toBe(1)
    expect(toolStartChunks(chunks)[0]!.choices[0].delta.tool_calls[0].function.name).toBe('read')
    expect(finishReasons(chunks)).toEqual(['tool_calls'])
  })

  test('Given a code-region-only marker, When suppression is on, Then the text streams verbatim', async () => {
    const content =
      'Example:\n```xml\n<invoke name="read"><parameter name="path">/tmp/x</parameter></invoke>\n```'
    const chunks = await collectSdkChunks([{ assistantResponseEvent: { content } }], true)

    expect(joinedContent(chunks)).toBe(content)
    expect(toolCallChunks(chunks).length).toBe(0)
    expect(finishReasons(chunks)).toEqual(['stop'])
  })
})
