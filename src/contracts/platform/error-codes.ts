/**
 * @module src/contracts/platform/error-codes
 *
 * Purpose:
 * Canonical platform error-code registry used by HTTP responses and stream
 * events. These values are stable identifiers that clients should branch on
 * instead of free-form error messages.
 */
export const platformErrorCodes = {
  authTokenExpired: "auth.token_expired",
  authTokenInvalid: "auth.token_invalid",
  authInsufficientScope: "auth.insufficient_scope",
  authWorkspaceMismatch: "auth.workspace_mismatch",
  runtimeUnsupportedCapability: "runtime.unsupported_capability",
  runtimePolicyDenied: "runtime.policy_denied",
  runtimeAdapterUnavailable: "runtime.adapter_unavailable",
  runtimeSessionNotFound: "runtime.session_not_found",
  runtimeExecFailed: "runtime.exec_failed",
  runtimeExecTimeout: "runtime.exec_timeout",
  resourceNotFound: "resource.not_found",
  resourceConflict: "resource.conflict",
  rateLimitExceeded: "rate.limit_exceeded",
  inputMalformedBody: "input.malformed_body",
  inputInvalidParameter: "input.invalid_parameter",
  capabilityExpired: "capability.expired",
  capabilityRevoked: "capability.revoked",
  serverInternal: "server.internal",
  serverUnavailable: "server.unavailable",
} as const;

/**
 * Purpose:
 * Union of all stable platform error-code literals.
 */
export type PlatformErrorCode = (typeof platformErrorCodes)[keyof typeof platformErrorCodes];
