export type AccountFailureClass = 'quota_or_rate_limit' | 'other'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function statusCodeOf(error: Record<string, unknown>): number | undefined {
  const metadata = error['$metadata']
  const metadataStatus = isRecord(metadata) ? metadata['httpStatusCode'] : undefined
  if (typeof metadataStatus === 'number') return metadataStatus

  const statusCode = error['statusCode']
  if (typeof statusCode === 'number') return statusCode

  const status = error['status']
  return typeof status === 'number' ? status : undefined
}

export function classifyAccountFailure(
  error: unknown,
  responseStatus?: number
): AccountFailureClass {
  if (responseStatus === 402 || responseStatus === 429) return 'quota_or_rate_limit'

  const seen = new Set<object>()
  let current = error
  while (isRecord(current) && !seen.has(current)) {
    seen.add(current)
    if (
      current['name'] === 'ServiceQuotaExceededException' ||
      statusCodeOf(current) === 402 ||
      statusCodeOf(current) === 429
    ) {
      return 'quota_or_rate_limit'
    }
    current = current['cause']
  }

  return 'other'
}
