import { z } from 'zod'

export const AccountSelectionStrategySchema = z.enum(['sticky', 'round-robin', 'lowest-usage'])
export type AccountSelectionStrategy = z.infer<typeof AccountSelectionStrategySchema>

/**
 * Kiro effort levels control thinking/reasoning depth.
 * - low: minimal reasoning
 * - medium: balanced (default when thinking enabled)
 * - high: deeper reasoning
 * - xhigh: extended reasoning (opus-4.7, opus-4.8 only)
 * - max: maximum reasoning depth (128k thinking tokens on opus-4.7/4.8)
 */
export const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
export type Effort = z.infer<typeof EffortSchema>

/**
 * Recovery strategy applied when an upstream event stream fails after output.
 * - off: no recovery; behavior is byte-for-byte identical to pre-recovery builds
 * - reasoning_restart: restart the turn from accumulated reasoning instead of
 *   replaying already-emitted content
 * - exact_replay: includes reasoning_restart, then uses exact three-channel shadow
 *   replay when visible text or tools have already been delivered
 * The literal strings must stay identical to `StreamRecoveryMode` in
 * src/core/request/stream-recovery.ts (the coordinator consumes this value).
 */
export const StreamRecoveryModeSchema = z.enum(['off', 'reasoning_restart', 'exact_replay'])
export type StreamRecoveryMode = z.infer<typeof StreamRecoveryModeSchema>

export const RegionSchema = z.enum([
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'af-south-1',
  'ap-east-1',
  'ap-south-2',
  'ap-southeast-3',
  'ap-southeast-5',
  'ap-southeast-4',
  'ap-south-1',
  'ap-southeast-6',
  'ap-northeast-3',
  'ap-northeast-2',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-east-2',
  'ap-southeast-7',
  'ap-northeast-1',
  'ca-central-1',
  'ca-west-1',
  'eu-central-1',
  'eu-west-1',
  'eu-west-2',
  'eu-south-1',
  'eu-west-3',
  'eu-south-2',
  'eu-north-1',
  'eu-central-2',
  'il-central-1',
  'mx-central-1',
  'me-south-1',
  'me-central-1',
  'sa-east-1'
])
export type Region = z.infer<typeof RegionSchema>

export const KiroConfigSchema = z.object({
  $schema: z.string().optional(),

  idc_start_url: z.string().url().optional(),
  idc_region: RegionSchema.optional(),
  idc_profile_arn: z.string().optional(),

  account_selection_strategy: AccountSelectionStrategySchema.default('lowest-usage'),

  /**
   * Give each process a distinct start index so simultaneous starts spread
   * across accounts.
   */
  distribute_across_processes: z.boolean().default(true),

  /**
   * Re-pick the lowest-usage account for every request instead of pinning one.
   * Overrides sticky selection.
   */
  per_request_spread: z.boolean().default(false),

  /**
   * Softly avoid accounts whose usage ratio is at/above
   * `quota_reserve_threshold` when other accounts still have room. When ALL
   * healthy accounts are near-full they are drained anyway (the real 402 in
   * error-handler is the authoritative hard-switch). Only affects
   * multi-account selection; single-account behavior is unchanged.
   */
  quota_avoidance_enabled: z.boolean().default(true),

  /**
   * Usage ratio (used/limit) at/above which an account is considered
   * near-full and softly avoided. Default 0.95 (95%).
   */
  quota_reserve_threshold: z.number().min(0).max(1).default(0.95),

  /**
   * Exclude accounts that have entered AWS paid overage from selection.
   */
  stop_on_overage: z.boolean().default(true),

  /**
   * Paid-overage invocations tolerated before stopping an account. 0 means
   * stop on any overage.
   */
  overage_threshold: z.number().min(0).default(0),

  default_region: RegionSchema.default('us-east-1'),

  rate_limit_retry_delay_ms: z.number().min(1000).max(60000).default(5000),

  rate_limit_max_retries: z.number().min(0).max(10).default(3),

  max_request_iterations: z.number().min(5).max(1000).default(20),

  /**
   * Opt into a fixed deadline covering client.send() and the first stream event.
   * Disabled by default because a pending request is ambiguous: Kiro may
   * still be performing a valid long-running generation.
   */
  sdk_response_timeout_enabled: z.boolean().default(false),

  /**
   * Maximum wait for the initial SDK response and first stream event.
   * Only used when sdk_response_timeout_enabled is true.
   */
  sdk_response_timeout_ms: z.number().min(30000).max(600000).default(300000),

  /**
   * Reuse completed SDK HTTP connections across requests. Disabled by default
   * because Bun can surface stale pooled sockets as mid-stream ECONNRESET.
   * Active requests remain fully concurrent when this is false.
   */
  sdk_http_keep_alive: z.boolean().default(false),

  /**
   * Opt into a fixed inactivity deadline between upstream stream events.
   * Disabled by default because a silent event gap is ambiguous: Kiro may
   * still be performing a valid long-running generation.
   */
  stream_event_timeout_enabled: z.boolean().default(false),

  /**
   * Maximum inactivity between upstream stream events.
   * Only used when stream_event_timeout_enabled is true.
   */
  request_timeout_ms: z.number().min(30000).max(600000).default(120000),

  /**
   * Consume the complete Kiro event stream before exposing any semantic output
   * downstream. This trades live token display for safe retries after a
   * mid-stream transport failure without duplicating content or tool calls.
   */
  stream_buffer_until_complete: z.boolean().default(false),

  /**
   * Maximum number of complete event-stream attempts. Buffered mode can safely
   * use every attempt even when the failed upstream stream produced output.
   */
  stream_max_attempts: z.number().int().min(1).max(10).default(3),

  /**
   * Recovery strategy for an upstream event stream that fails after output.
   * Defaults to 'off' during Phase 1 rollout; the default flips to
   * 'reasoning_restart' only after Phase 1 acceptance.
   */
  stream_recovery_mode: StreamRecoveryModeSchema.default('off'),

  token_expiry_buffer_ms: z.number().min(30000).max(300000).default(300000),

  /**
   * Opt-in leader-elected keep-alive that proactively rotates idle-account
   * tokens near expiry. Disabled by default until proven in real sessions.
   */
  token_keepalive_enabled: z.boolean().default(false),

  /**
   * Interval for the leader-elected keep-alive scan that keeps idle-account
   * refresh tokens rotating. Default 10 minutes; bounded to 1 minute-1 hour.
   */
  token_keepalive_interval_ms: z.number().min(60000).max(3600000).default(600000),

  /** Minimum interval between automatic full account refresh passes. */
  refresh_all_cooldown_ms: z.number().min(0).max(3600000).default(60000),

  /** Maximum latency an automatic pre-switch refresh may add to a request. */
  refresh_all_deadline_ms: z.number().min(1000).max(30000).default(5000),

  /** Refresh all account tokens and usage before choosing a failover account. */
  refresh_before_switch_enabled: z.boolean().default(true),

  usage_sync_max_retries: z.number().min(0).max(5).default(3),

  auth_server_port_start: z.number().min(1024).max(65535).default(19847),

  auth_server_port_range: z.number().min(1).max(100).default(10),

  usage_tracking_enabled: z.boolean().default(true),
  auto_sync_kiro_cli: z.boolean().default(false),
  enable_log_api_request: z.boolean().default(false),

  /**
   * Delete archived and detailed logs after this many days.
   */
  log_retention_days: z.number().int().min(1).max(365).default(7),

  /**
   * Maximum combined size of managed log files. Oldest archived logs are
   * removed first; active files are rotated separately.
   */
  log_max_total_size_mb: z.number().int().min(16).max(102400).default(512),

  /**
   * Compress inactive API log segments after this many days.
   */
  log_compress_after_days: z.number().int().min(1).max(30).default(1),

  /**
   * Rotate plugin.log and detailed API NDJSON files at this size.
   */
  log_segment_size_mb: z.number().int().min(1).max(256).default(16),

  /**
   * Enable config-gated debug logging that records the inbound
   * OpenAI-compatible request body shape (top-level keys, reasoning-related
   * fields only — no message content) and the resolved Kiro effort for each
   * request. Independent from `enable_log_api_request`; off by default.
   */
  enable_log_effort_debug: z.boolean().default(false),

  /**
   * Default effort level for thinking models. Controls reasoning depth.
   * When set, this overrides the automatic budget-based mapping.
   * Values: 'low', 'medium', 'high', 'xhigh' (opus-4.7/4.8 only), 'max'
   */
  effort: EffortSchema.optional(),

  /**
   * Enable automatic effort mapping from OpenCode's thinking budget.
   * When true (default), maps budget ranges to effort levels.
   * When false, only uses explicit effort config or falls back to 'medium'.
   */
  auto_effort_mapping: z.boolean().default(true)
})

export type KiroConfig = z.infer<typeof KiroConfigSchema>

export const DEFAULT_CONFIG: KiroConfig = {
  account_selection_strategy: 'lowest-usage',
  distribute_across_processes: true,
  per_request_spread: false,
  quota_avoidance_enabled: true,
  quota_reserve_threshold: 0.95,
  stop_on_overage: true,
  overage_threshold: 0,
  default_region: 'us-east-1',
  rate_limit_retry_delay_ms: 5000,
  rate_limit_max_retries: 3,
  max_request_iterations: 20,
  sdk_response_timeout_enabled: false,
  sdk_response_timeout_ms: 300000,
  sdk_http_keep_alive: false,
  stream_event_timeout_enabled: false,
  request_timeout_ms: 120000,
  stream_buffer_until_complete: false,
  stream_max_attempts: 3,
  stream_recovery_mode: 'off',
  token_expiry_buffer_ms: 300000,
  token_keepalive_enabled: false,
  token_keepalive_interval_ms: 600000,
  refresh_all_cooldown_ms: 60000,
  refresh_all_deadline_ms: 5000,
  refresh_before_switch_enabled: true,
  usage_sync_max_retries: 3,
  auth_server_port_start: 19847,
  auth_server_port_range: 10,
  usage_tracking_enabled: true,
  auto_sync_kiro_cli: false,
  enable_log_api_request: false,
  log_retention_days: 7,
  log_max_total_size_mb: 512,
  log_compress_after_days: 1,
  log_segment_size_mb: 16,
  enable_log_effort_debug: false,
  auto_effort_mapping: true
}
