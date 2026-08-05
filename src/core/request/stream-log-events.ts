/** Stable denominator event written once per inbound streaming request. */
export const STREAM_REQUEST_STARTED_LOG = 'Kiro stream request started'

/** Diagnostic-level marker emitted when an SDK stream attempt is opened. */
export const STREAM_ATTEMPT_STARTED_LOG = 'Kiro stream attempt started'

/** Stable marker for a clean SDK `done` without completion metadata. */
export const STREAM_MISSING_COMPLETION_LOG = 'Kiro stream ended without completion metadata'

/** Unified request-terminal summary across success, failure, and cancellation. */
export const STREAM_TERMINAL_LOG = 'Kiro stream request terminal'
