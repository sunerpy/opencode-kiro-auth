// Failure classification for Kiro accounts.
//
// Two orthogonal classes drive the auth/health/refresh logic:
//
//   isAccessTokenError  — the ACCESS token is stale/invalid but the REFRESH
//                         token is (probably) still good. REFRESHABLE: force a
//                         refresh and retry; never mark the account dead just
//                         for this. "The bearer token included in the request
//                         is invalid" is the canonical signal.
//
//   isRefreshTokenDead  — the REFRESH token itself is dead (or the OIDC client
//                         registration expired). PERMANENT: the account needs a
//                         re-login. This is exactly the historical
//                         isPermanentError keyword set.
//
// isPermanentError is kept as an alias of isRefreshTokenDead so every existing
// caller (request-handler, accounts, stale-accounts, locked-operations) keeps
// its "permanent = exclude / don't auto-heal / needs-reauth" semantics: a
// refresh-token-dead account IS permanent. invalid-bearer is deliberately NOT
// in this set, so it is no longer treated as permanent.

/** REFRESH-token-dead signals (needs re-login). Historical permanent set. */
export function isRefreshTokenDead(reason?: string): boolean {
  if (!reason) return false
  return (
    reason.includes('Invalid refresh token') ||
    reason.includes('Invalid grant provided') ||
    reason.includes('invalid_grant') ||
    reason.includes('ExpiredTokenException') ||
    reason.includes('InvalidTokenException') ||
    reason.includes('ExpiredClientException') ||
    reason.includes('Client is expired') ||
    reason.includes('HTTP_401') ||
    reason.includes('HTTP_403')
  )
}

/**
 * ACCESS-token-error signals (refreshable, transient). The canonical case is
 * the CodeWhisperer invalid-bearer 403 whose message is "The bearer token
 * included in the request is invalid". Matched case-insensitively so a
 * capitalization drift on the wire does not misclassify it as dead.
 */
export function isAccessTokenError(reason?: string): boolean {
  if (!reason) return false
  const lower = reason.toLowerCase()
  return (
    lower.includes('bearer token included in the request is invalid') ||
    lower.includes('access token has expired') ||
    lower.includes('access_token expired') ||
    lower.includes('the access token expired')
  )
}

/**
 * Back-compat alias. Semantics == refresh-token-dead == permanent (needs
 * re-auth). Preserved so callers that gate exclude/auto-heal/needs-reauth on
 * "permanent" keep working unchanged.
 */
export function isPermanentError(reason?: string): boolean {
  return isRefreshTokenDead(reason)
}

/**
 * Ensure a reason string classifies as refresh-token-dead when persisted via
 * markUnhealthy (which decides permanence from the reason string). If the raw
 * message already matches a dead keyword it is returned unchanged; otherwise a
 * dead marker is prepended so the stored reason is recognized as permanent by
 * isRefreshTokenDead / isPermanentError.
 */
export function toDeadReason(reason?: string): string {
  const base = reason && reason.length > 0 ? reason : 'Account needs re-authentication'
  return isRefreshTokenDead(base) ? base : `InvalidTokenException: ${base}`
}
