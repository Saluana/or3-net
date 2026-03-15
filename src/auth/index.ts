/**
 * @module src/auth/index
 *
 * Purpose:
 * Defines the external session-proof validation boundary used by OR3 Net auth.
 * This interface lets callers plug in provider-specific session verification
 * without coupling the core auth service to a single identity system.
 */
/**
 * Purpose:
 * Contract for converting provider-specific session proof into an internal
 * workspace-scoped identity.
 *
 * Behavior:
 * Implementations validate upstream identity material and return the resolved
 * user, workspace, and granted scopes used to mint OR3 workspace tokens.
 *
 * Constraints:
 * - Must reject invalid or expired proofs
 * - Must return a workspace that the user is allowed to access
 * - The returned scopes become the token's effective authorization surface
 *
 * Non-Goals:
 * - Does not mint OR3 bearer tokens directly
 * - Does not persist sessions on behalf of the auth service
 */
export interface SessionProofValidator {
  validateSessionProof(input: {
    provider: string;
    session_proof: Record<string, unknown>;
    workspace_hint?: string;
  }): Promise<{ user_id: string; workspace_id: string; scopes: string[] }>;
}