import type { ToolCall } from '../../plugin/types'

export function parseBracketToolCalls(text: string): ToolCall[] {
  const toolCalls: ToolCall[] = []
  const pattern = /\[Called\s+(\w+)\s+with\s+args:\s*(\{[^}]*(?:\{[^}]*\}[^}]*)*\})\]/gs

  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const funcName = match[1]
    const argsStr = match[2]

    if (!funcName || !argsStr) continue

    try {
      const args = JSON.parse(argsStr)
      toolCalls.push({
        toolUseId: `tool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: funcName,
        input: args
      })
    } catch {
      continue
    }
  }

  return toolCalls
}

export function deduplicateToolCalls(toolCalls: ToolCall[]): ToolCall[] {
  const seen = new Set<string>()
  const unique: ToolCall[] = []

  for (const tc of toolCalls) {
    if (!seen.has(tc.toolUseId)) {
      seen.add(tc.toolUseId)
      unique.push(tc)
    }
  }

  return unique
}

export function cleanToolCallsFromText(text: string, toolCalls: ToolCall[]): string {
  let cleaned = text

  for (const tc of toolCalls) {
    const funcName = tc.name
    const escapedName = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(
      `\\[Called\\s+${escapedName}\\s+with\\s+args:\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}\\]`,
      'gs'
    )
    cleaned = cleaned.replace(pattern, '')
  }

  cleaned = cleaned.replace(/\s+/g, ' ').trim()
  return cleaned
}

// ---------------------------------------------------------------------------
// Text-dialect tool-call recovery (bleed-stop)
//
// Some models emit tool calls as literal TEXT dialects instead of the
// structured toolUseEvent path:
//   (a) Anthropic XML:  <function_calls><invoke name="X"><parameter name="k">v</parameter></invoke></function_calls>
//                       (and a standalone <invoke name="X">...</invoke>)
//   (b) deepseek DSML:  <｜DSML｜function_calls...   (U+FF5C '｜', NOT ASCII '|')
//   (c) bracket:        [Called X with args:{...}]  (legacy, kept)
//
// These leak verbatim and stall the turn. `parseTextToolCalls` rescues them
// into structured ToolCalls and returns the text with EXACTLY the matched
// spans removed. It is deliberately conservative: only COMPLETE closed tags
// match, candidates inside fenced/inline code are skipped, and a dialect that
// cannot be parsed is stripped (never fabricated into a phantom call).
// ---------------------------------------------------------------------------

// deepseek DSML opening marker — the exact U+FF5C ('｜') form observed leaking.
export const DSML_MARKER = '<\uFF5CDSML\uFF5Cfunction_calls'

/** A matched dialect span in `text`, with the tool calls it yields (may be empty for strip-only). */
interface DialectMatch {
  start: number
  end: number
  toolCalls: ToolCall[]
}

function genToolUseId(): string {
  return `tool_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
}

/**
 * Compute char ranges that are inside fenced code blocks (``` ... ```) or
 * inline code spans (` ... `). Candidates overlapping any of these are skipped
 * so a model *explaining* or *showing* tool-call syntax is never executed.
 */
function computeCodeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []

  const fence = /```[\s\S]*?```/g
  let m: RegExpExecArray | null
  while ((m = fence.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length])
  }

  const inFence = (i: number): boolean => ranges.some(([s, e]) => i >= s && i < e)

  const inline = /`[^`\n]+`/g
  while ((m = inline.exec(text)) !== null) {
    if (!inFence(m.index)) ranges.push([m.index, m.index + m[0].length])
  }

  return ranges
}

function overlapsCode(start: number, end: number, codeRanges: Array<[number, number]>): boolean {
  return codeRanges.some(([s, e]) => start < e && end > s)
}

function overlapsClaimed(start: number, end: number, claimed: Array<[number, number]>): boolean {
  return claimed.some(([s, e]) => start < e && end > s)
}

/** Parse `<parameter name="K">V</parameter>` pairs from an invoke body into an input object. */
function parseInvokeParameters(body: string): Record<string, unknown> {
  const input: Record<string, unknown> = {}
  const paramRe = /<parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/parameter>/g
  let pm: RegExpExecArray | null
  while ((pm = paramRe.exec(body)) !== null) {
    const key = pm[1]
    const rawVal = pm[2]
    if (key === undefined) continue
    const val = rawVal ?? ''
    try {
      input[key] = JSON.parse(val)
    } catch {
      input[key] = val
    }
  }
  return input
}

/** Build a ToolCall from a single complete `<invoke name="...">...</invoke>` block. */
function toolCallFromInvoke(name: string, body: string): ToolCall {
  return {
    toolUseId: genToolUseId(),
    name,
    input: parseInvokeParameters(body)
  }
}

/**
 * Match complete Anthropic XML dialects:
 *   - `<function_calls>...(invoke)+...</function_calls>` blocks
 *   - standalone `<invoke name="X">...</invoke>` NOT inside a function_calls block
 * Skips candidates inside code and records claimed ranges to avoid double-match.
 */
function matchAnthropicXml(
  text: string,
  codeRanges: Array<[number, number]>,
  claimed: Array<[number, number]>
): DialectMatch[] {
  const matches: DialectMatch[] = []

  // (1) complete <function_calls>...</function_calls> blocks
  const blockRe = /<function_calls>[\s\S]*?<\/function_calls>/g
  let bm: RegExpExecArray | null
  while ((bm = blockRe.exec(text)) !== null) {
    const start = bm.index
    const end = start + bm[0].length
    if (overlapsCode(start, end, codeRanges)) continue

    const invokeRe = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g
    const toolCalls: ToolCall[] = []
    let im: RegExpExecArray | null
    while ((im = invokeRe.exec(bm[0])) !== null) {
      const name = im[1]
      if (!name) continue
      toolCalls.push(toolCallFromInvoke(name, im[2] ?? ''))
    }
    // Only treat as a tool-call span if at least one invoke parsed; otherwise
    // it is not a real dialect payload — leave the text untouched.
    if (toolCalls.length === 0) continue
    matches.push({ start, end, toolCalls })
    claimed.push([start, end])
  }

  // (2) standalone complete <invoke ...>...</invoke> not inside a claimed block
  const invokeRe = /<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/g
  let sm: RegExpExecArray | null
  while ((sm = invokeRe.exec(text)) !== null) {
    const start = sm.index
    const end = start + sm[0].length
    const name = sm[1]
    if (!name) continue
    if (overlapsCode(start, end, codeRanges)) continue
    if (overlapsClaimed(start, end, claimed)) continue
    matches.push({ start, end, toolCalls: [toolCallFromInvoke(name, sm[2] ?? '')] })
    claimed.push([start, end])
  }

  return matches
}

/**
 * Match the deepseek DSML dialect. The strip span runs from the exact U+FF5C
 * marker to its closing counterpart if one exists, else to end-of-text (the
 * observed trailing leak). Best-effort recovery of name/args; if not cleanly
 * recoverable the span is stripped WITHOUT fabricating a call.
 */
function matchDsml(
  text: string,
  codeRanges: Array<[number, number]>,
  claimed: Array<[number, number]>
): DialectMatch[] {
  const matches: DialectMatch[] = []
  let from = 0
  for (;;) {
    const start = text.indexOf(DSML_MARKER, from)
    if (start === -1) break

    // Closing counterpart: a DSML end token (U+FF5C ... end ... U+FF5C) after
    // the marker, else consume to end-of-text.
    const rest = text.slice(start + DSML_MARKER.length)
    const closeRe = /<\uFF5C[^>]*?end[^>]*?>|<\/\uFF5CDSML[^>]*?>/
    const cm = closeRe.exec(rest)
    const end = cm !== null ? start + DSML_MARKER.length + cm.index + cm[0].length : text.length

    from = end

    if (overlapsCode(start, end, codeRanges)) continue
    if (overlapsClaimed(start, end, claimed)) continue

    // Best-effort recovery — only fires on a clean name + JSON args pair.
    const span = text.slice(start, end)
    const toolCalls: ToolCall[] = []
    const nameM = /name["\uFF5C=:\s]+["']?([A-Za-z0-9_]+)/.exec(span)
    const jsonM = /(\{[\s\S]*\})/.exec(span)
    if (nameM?.[1] && jsonM?.[1]) {
      try {
        toolCalls.push({
          toolUseId: genToolUseId(),
          name: nameM[1],
          input: JSON.parse(jsonM[1])
        })
      } catch {
        // fall through to strip-only
      }
    }

    matches.push({ start, end, toolCalls })
    claimed.push([start, end])
  }
  return matches
}

/**
 * Match legacy `[Called X with args:{...}]` spans (for cleanedText) and their
 * tool calls, skipping candidates inside code.
 */
function matchBracket(
  text: string,
  codeRanges: Array<[number, number]>,
  claimed: Array<[number, number]>
): DialectMatch[] {
  const matches: DialectMatch[] = []
  const pattern = /\[Called\s+(\w+)\s+with\s+args:\s*(\{[^}]*(?:\{[^}]*\}[^}]*)*\})\]/gs
  let m: RegExpExecArray | null
  while ((m = pattern.exec(text)) !== null) {
    const start = m.index
    const end = start + m[0].length
    const name = m[1]
    const argsStr = m[2]
    if (!name || !argsStr) continue
    if (overlapsCode(start, end, codeRanges)) continue
    if (overlapsClaimed(start, end, claimed)) continue
    let input: Record<string, unknown>
    try {
      input = JSON.parse(argsStr)
    } catch {
      continue
    }
    matches.push({
      start,
      end,
      toolCalls: [{ toolUseId: genToolUseId(), name, input }]
    })
    claimed.push([start, end])
  }
  return matches
}

/**
 * Recognize Anthropic XML, deepseek DSML, and legacy bracket tool-call dialects
 * in `text`. Returns the parsed tool calls plus `cleanedText` with EXACTLY the
 * matched dialect spans removed (all other text preserved verbatim).
 *
 * Phantom-execution guards:
 *  - only COMPLETE closed tags match (an unclosed `<invoke name="x">` is text);
 *  - candidates inside fenced/inline code are skipped;
 *  - a dialect that yields no parseable call is stripped, never fabricated.
 */
export function parseTextToolCalls(text: string): { toolCalls: ToolCall[]; cleanedText: string } {
  if (!text) return { toolCalls: [], cleanedText: text }

  const codeRanges = computeCodeRanges(text)
  const claimed: Array<[number, number]> = []

  const matches: DialectMatch[] = [
    ...matchAnthropicXml(text, codeRanges, claimed),
    ...matchDsml(text, codeRanges, claimed),
    ...matchBracket(text, codeRanges, claimed)
  ]

  if (matches.length === 0) return { toolCalls: [], cleanedText: text }

  matches.sort((a, b) => a.start - b.start)

  const toolCalls: ToolCall[] = []
  let cleanedText = ''
  let cursor = 0
  for (const mt of matches) {
    if (mt.start < cursor) continue // defensive against any residual overlap
    cleanedText += text.slice(cursor, mt.start)
    cursor = mt.end
    toolCalls.push(...mt.toolCalls)
  }
  cleanedText += text.slice(cursor)

  return { toolCalls, cleanedText }
}
