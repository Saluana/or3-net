export const platformErrorCodes = {
  authTokenExpired: "auth.token_expired",
  authTokenInvalid: "auth.token_invalid",
  authInsufficientScope: "auth.insufficient_scope",
  authWorkspaceMismatch: "auth.workspace_mismatch",
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

export type PlatformErrorCode = (typeof platformErrorCodes)[keyof typeof platformErrorCodes];
