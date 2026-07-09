export interface StreamEvent {
  type: string
  message?: any
  content_block?: any
  delta?: any
  index?: number
  usage?: any
}

export interface StreamState {
  thinkingRequested: boolean
  buffer: string
  inThinking: boolean
  thinkingExtracted: boolean
  thinkingBlockIndex: number | null
  textBlockIndex: number | null
  nextBlockIndex: number
  stoppedBlocks: Set<number>
}

export interface ToolCallState {
  toolUseId: string
  name: string
  input: string
}

export const THINKING_START_TAG = '<thinking>'
export const THINKING_END_TAG = '</thinking>'
