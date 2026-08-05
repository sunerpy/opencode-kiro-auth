export const KIRO_REQUEST_KIND_HEADER = 'x-opencode-kiro-request-kind'

export type KiroRequestKind = 'normal' | 'compaction' | 'unknown'

function headerValue(headers: HeadersInit | undefined): string | null {
  if (!headers) return null
  try {
    return new Headers(headers).get(KIRO_REQUEST_KIND_HEADER)
  } catch {
    return null
  }
}

export function consumeKiroRequestKind(
  input: unknown,
  init: RequestInit | undefined
): { readonly requestKind: KiroRequestKind; readonly init: RequestInit | undefined } {
  const inputHeaders =
    typeof input === 'object' && input !== null && 'headers' in input
      ? ((input as { headers?: HeadersInit }).headers ?? undefined)
      : undefined
  const raw = headerValue(init?.headers) ?? headerValue(inputHeaders)
  const requestKind: KiroRequestKind =
    raw === null ? 'normal' : raw === 'compaction' ? 'compaction' : 'unknown'

  if (!init?.headers) return { requestKind, init }

  const headers = new Headers(init.headers)
  headers.delete(KIRO_REQUEST_KIND_HEADER)
  return {
    requestKind,
    init: {
      ...init,
      headers
    }
  }
}
