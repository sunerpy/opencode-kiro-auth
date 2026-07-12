import { getContextWindowSize } from '../models.js'
import { estimateTokens } from '../response.js'
import { DialectGate } from './dialect-gate.js'
import { convertToOpenAI } from './openai-converter.js'
import { findRealTag } from './stream-parser.js'
import { createTextDeltaEvents, createThinkingDeltaEvents, stopBlock } from './stream-state.js'
import {
  StreamEvent,
  StreamState,
  THINKING_END_TAG,
  THINKING_START_TAG,
  ToolCallState
} from './types.js'

export async function* transformSdkStream(
  sdkResponse: any,
  model: string,
  conversationId: string
): AsyncGenerator<any> {
  const thinkingRequested = true

  const streamState: StreamState = {
    thinkingRequested,
    buffer: '',
    inThinking: false,
    thinkingExtracted: false,
    thinkingBlockIndex: null,
    textBlockIndex: null,
    nextBlockIndex: 0,
    stoppedBlocks: new Set()
  }

  let textOnlyContent = ''
  let outputTokens = 0
  let inputTokens = 0
  let contextUsagePercentage: number | null = null
  const toolCalls: ToolCallState[] = []
  let currentToolCall: ToolCallState | null = null

  // Text deltas route through the gate so a dialect span is withheld from the
  // visible stream once its opening marker appears (recovered at finalization).
  const dialectGate = new DialectGate()
  const toChunk = (ev: StreamEvent): any => {
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      const safe = dialectGate.push(ev.delta.text ?? '')
      if (!safe) return null
      const gated: StreamEvent = { ...ev, delta: { ...ev.delta, text: safe } }
      return convertToOpenAI(gated, conversationId, model)
    }
    return convertToOpenAI(ev, conversationId, model)
  }

  // Probe (opus-4.8): reasoning streams via `reasoningContentEvent{text,signature}` as a
  // contiguous run BEFORE `assistantResponseEvent.content`; no `<thinking>` tags emitted.
  // signature is metadata and ignored for rendering.
  let reasoningStarted = false
  let reasoningClosed = false

  const eventStream = sdkResponse.generateAssistantResponseResponse
  if (!eventStream) {
    throw new Error('SDK response has no event stream')
  }

  for await (const event of eventStream) {
    if (event.reasoningContentEvent?.text) {
      const reasoningText = event.reasoningContentEvent.text

      if (reasoningClosed) {
        // Defensive, normally unreached (probe: reasoning is contiguous-before-text).
        // The stopped thinking index cannot be reused, so open a fresh one.
        streamState.thinkingBlockIndex = null
        reasoningClosed = false
      }
      reasoningStarted = true
      for (const ev of createThinkingDeltaEvents(reasoningText, streamState)) {
        const _c = convertToOpenAI(ev, conversationId, model)
        if (_c !== null) yield _c
      }
      continue
    }

    if (event.assistantResponseEvent?.content) {
      const text = event.assistantResponseEvent.content
      textOnlyContent += text

      if (reasoningStarted && !reasoningClosed) {
        for (const ev of stopBlock(streamState.thinkingBlockIndex, streamState)) {
          const _c = convertToOpenAI(ev, conversationId, model)
          if (_c !== null) yield _c
        }
        reasoningClosed = true
      }

      if (reasoningStarted) {
        for (const ev of createTextDeltaEvents(text, streamState)) {
          const _c = toChunk(ev)
          if (_c !== null) yield _c
        }
        continue
      }

      if (!thinkingRequested) {
        for (const ev of createTextDeltaEvents(text, streamState)) {
          {
            const _c = toChunk(ev)
            if (_c !== null) yield _c
          }
        }
        continue
      }

      streamState.buffer += text
      const deltaEvents: any[] = []

      while (streamState.buffer.length > 0) {
        if (!streamState.inThinking && !streamState.thinkingExtracted) {
          const startPos = findRealTag(streamState.buffer, THINKING_START_TAG)
          if (startPos !== -1) {
            const before = streamState.buffer.slice(0, startPos)
            if (before) {
              deltaEvents.push(...createTextDeltaEvents(before, streamState))
            }
            streamState.buffer = streamState.buffer.slice(startPos + THINKING_START_TAG.length)
            streamState.inThinking = true
            continue
          }

          const safeLen = Math.max(0, streamState.buffer.length - THINKING_START_TAG.length)
          if (safeLen > 0) {
            const safeText = streamState.buffer.slice(0, safeLen)
            if (safeText) {
              deltaEvents.push(...createTextDeltaEvents(safeText, streamState))
            }
            streamState.buffer = streamState.buffer.slice(safeLen)
          }
          break
        }

        if (streamState.inThinking) {
          const endPos = findRealTag(streamState.buffer, THINKING_END_TAG)
          if (endPos !== -1) {
            const thinkingPart = streamState.buffer.slice(0, endPos)
            if (thinkingPart) {
              deltaEvents.push(...createThinkingDeltaEvents(thinkingPart, streamState))
            }
            streamState.buffer = streamState.buffer.slice(endPos + THINKING_END_TAG.length)
            streamState.inThinking = false
            streamState.thinkingExtracted = true
            deltaEvents.push(...createThinkingDeltaEvents('', streamState))
            deltaEvents.push(...stopBlock(streamState.thinkingBlockIndex, streamState))
            if (streamState.buffer.startsWith('\n\n')) {
              streamState.buffer = streamState.buffer.slice(2)
            }
            continue
          }

          const safeLen = Math.max(0, streamState.buffer.length - THINKING_END_TAG.length)
          if (safeLen > 0) {
            const safeThinking = streamState.buffer.slice(0, safeLen)
            if (safeThinking) {
              deltaEvents.push(...createThinkingDeltaEvents(safeThinking, streamState))
            }
            streamState.buffer = streamState.buffer.slice(safeLen)
          }
          break
        }

        if (streamState.thinkingExtracted) {
          const rest = streamState.buffer
          streamState.buffer = ''
          if (rest) {
            deltaEvents.push(...createTextDeltaEvents(rest, streamState))
          }
          break
        }
      }

      for (const ev of deltaEvents) {
        const chunk = toChunk(ev)
        if (chunk !== null) yield chunk
      }
    } else if (event.toolUseEvent) {
      const tc = event.toolUseEvent

      if (tc.name && tc.toolUseId) {
        if (currentToolCall && currentToolCall.toolUseId === tc.toolUseId) {
          currentToolCall.input += tc.input || ''
        } else {
          if (currentToolCall) toolCalls.push(currentToolCall)
          currentToolCall = {
            toolUseId: tc.toolUseId,
            name: tc.name,
            input: tc.input || ''
          }
        }
        if (tc.stop && currentToolCall) {
          toolCalls.push(currentToolCall)
          currentToolCall = null
        }
      }
    } else if (event.metadataEvent) {
      if (event.metadataEvent.contextUsagePercentage) {
        contextUsagePercentage = event.metadataEvent.contextUsagePercentage
      }
    } else if ((event as any).contextUsageEvent) {
      const cue = (event as any).contextUsageEvent
      if (cue.contextUsagePercentage) {
        contextUsagePercentage = cue.contextUsagePercentage
      }
    }
  }

  if (currentToolCall) {
    toolCalls.push(currentToolCall)
    currentToolCall = null
  }

  // Reasoning-only responses (reasoning but no reply text): close the thinking block.
  if (reasoningStarted && !reasoningClosed) {
    for (const ev of stopBlock(streamState.thinkingBlockIndex, streamState)) {
      const _c = convertToOpenAI(ev, conversationId, model)
      if (_c !== null) yield _c
    }
    reasoningClosed = true
  }

  if (thinkingRequested && streamState.buffer) {
    if (streamState.inThinking) {
      for (const ev of createThinkingDeltaEvents(streamState.buffer, streamState)) {
        const _c = convertToOpenAI(ev, conversationId, model)
        if (_c !== null) yield _c
      }
      streamState.buffer = ''
      for (const ev of createThinkingDeltaEvents('', streamState)) {
        const _c = convertToOpenAI(ev, conversationId, model)
        if (_c !== null) yield _c
      }
      for (const ev of stopBlock(streamState.thinkingBlockIndex, streamState)) {
        const _c = convertToOpenAI(ev, conversationId, model)
        if (_c !== null) yield _c
      }
    } else {
      for (const ev of createTextDeltaEvents(streamState.buffer, streamState)) {
        const _c = toChunk(ev)
        if (_c !== null) yield _c
      }
      streamState.buffer = ''
    }
  }

  const { toolCalls: dialectToolCalls, remainderText } = dialectGate.finalize()
  if (remainderText) {
    for (const ev of createTextDeltaEvents(remainderText, streamState)) {
      const _c = convertToOpenAI(ev, conversationId, model)
      if (_c !== null) yield _c
    }
  }

  for (const ev of stopBlock(streamState.textBlockIndex, streamState)) {
    const _c = convertToOpenAI(ev, conversationId, model)
    if (_c !== null) yield _c
  }

  if (dialectToolCalls.length > 0) {
    for (const btc of dialectToolCalls) {
      toolCalls.push({
        toolUseId: btc.toolUseId,
        name: btc.name,
        input: typeof btc.input === 'string' ? btc.input : JSON.stringify(btc.input)
      })
    }
  }

  if (toolCalls.length > 0) {
    // OpenAI tool_calls[].index must be the tool call's own 0-based ordinal,
    // NOT the Anthropic content_block global index (offset by reasoning/text
    // blocks) — a global index misaligns the AI-SDK accumulator and drops the call.
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]
      if (!tc) continue
      const blockIndex = i

      {
        const _c = convertToOpenAI(
          {
            type: 'content_block_start',
            index: blockIndex,
            content_block: {
              type: 'tool_use',
              id: tc.toolUseId,
              name: tc.name,
              input: {}
            }
          },
          conversationId,
          model
        )
        if (_c !== null) yield _c
      }

      let inputJson: string
      try {
        const parsed = JSON.parse(tc.input)
        inputJson = JSON.stringify(parsed)
      } catch {
        inputJson = tc.input
      }

      {
        const _c = convertToOpenAI(
          {
            type: 'content_block_delta',
            index: blockIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: inputJson
            }
          },
          conversationId,
          model
        )
        if (_c !== null) yield _c
      }

      {
        const _c = convertToOpenAI(
          { type: 'content_block_stop', index: blockIndex },
          conversationId,
          model
        )
        if (_c !== null) yield _c
      }
    }
  }

  outputTokens = estimateTokens(textOnlyContent)

  if (contextUsagePercentage !== null && contextUsagePercentage > 0) {
    const contextWindow = getContextWindowSize(model)
    const totalTokens = Math.round((contextWindow * contextUsagePercentage) / 100)
    inputTokens = Math.max(0, totalTokens - outputTokens)
  }

  {
    const _c = convertToOpenAI(
      {
        type: 'message_delta',
        delta: { stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn' },
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        }
      },
      conversationId,
      model
    )
    if (_c !== null) yield _c
  }

  {
    const _c = convertToOpenAI({ type: 'message_stop' }, conversationId, model)
    if (_c !== null) yield _c
  }
}
