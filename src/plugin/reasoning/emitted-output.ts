/**
 * Accumulates the OpenAI-shaped chunks the plugin actually emitted for one stream
 * attempt.
 *
 * The correlation fingerprint MUST be computed over this, never over raw SDK
 * content: visible text passes through `DialectGate`, whose `finalize()` strips
 * text-dialect tool-call spans out of `delta.content` and converts them into
 * structured `delta.tool_calls`, and tool arguments are JSON-normalized on the
 * way out. A fingerprint over raw SDK bytes would therefore never match the
 * assistant message OpenCode sends back on the next turn — text-dialect tool
 * calls would miss deterministically and silently.
 */
export interface EmittedToolUse {
  toolUseId: string
  name: string
  /** The emitted `function.arguments` string, byte-identical to what was streamed. */
  argumentsJson: string
}

interface ToolUseSlot {
  toolUseId: string
  name: string
  argumentsJson: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function extractDelta(chunk: unknown): Record<string, unknown> | undefined {
  const record = asRecord(chunk)
  if (!record) return undefined
  const choices = record.choices
  if (!Array.isArray(choices)) return undefined
  const first = asRecord(choices[0])
  if (!first) return undefined
  return asRecord(first.delta)
}

export class EmittedOutputAccumulator {
  private visible = ''
  private reasoning = ''
  private slots = new Map<number, ToolUseSlot>()

  /** Observe one emitted OpenAI chunk. Observation only — never mutates the chunk. */
  observeChunk(chunk: unknown): void {
    const delta = extractDelta(chunk)
    if (!delta) return

    if (typeof delta.content === 'string') this.visible += delta.content
    if (typeof delta.reasoning_content === 'string') this.reasoning += delta.reasoning_content

    const toolCalls = delta.tool_calls
    if (!Array.isArray(toolCalls)) return
    for (const entry of toolCalls) this.observeToolCall(entry)
  }

  private observeToolCall(entry: unknown): void {
    const record = asRecord(entry)
    if (!record) return
    const index = record.index
    if (typeof index !== 'number') return

    let slot = this.slots.get(index)
    if (!slot) {
      slot = { toolUseId: '', name: '', argumentsJson: '' }
      this.slots.set(index, slot)
    }

    if (typeof record.id === 'string' && record.id.length > 0) slot.toolUseId = record.id
    const fn = asRecord(record.function)
    if (!fn) return
    if (typeof fn.name === 'string' && fn.name.length > 0) slot.name = fn.name
    if (typeof fn.arguments === 'string') slot.argumentsJson += fn.arguments
  }

  get visibleText(): string {
    return this.visible
  }

  get reasoningText(): string {
    return this.reasoning
  }

  /** Emitted tool calls in emission order (the `tool_calls[].index` ordinal order). */
  toolUses(): EmittedToolUse[] {
    return [...this.slots.values()].map((slot) => ({
      toolUseId: slot.toolUseId,
      name: slot.name,
      argumentsJson: slot.argumentsJson
    }))
  }
}
