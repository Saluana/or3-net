/**
 * @module src/auth/service
 *
 * Purpose:
 * Core authentication service for OR3 Net. Bridges external session proofs and
 * stored API keys into a single workspace-scoped bearer-token model.
 *
 * Responsibilities:
 * - Exchange provider session proofs for OR3 bearer tokens
 * - Authenticate bearer tokens backed by workspace tokens or API keys
 * - Create, list, and revoke API keys within a workspace
 *
 * Non-responsibilities:
 * - Does not implement provider-specific proof validation itself
 * - Does not authorize individual API routes beyond token scope resolution
 */
import type { ControlPlaneDatabase, StoredApiKey } from "../db/index.ts";

import { createId } from "../lib/ids.ts";
import { hashApiKey } from "../lib/crypto.ts";
import type { AuthToken } from "../contracts/index.ts";
import { issueWorkspaceToken, validateWorkspaceToken, type WorkspacePrincipal } from "./tokens.ts";

/**
 * Purpose:
 * Provider boundary for validating an upstream login artifact before OR3 issues
 * a workspace-scoped bearer token.
 */
export interface SessionProofValidator {
  validateSessionProof(input: {
    provider: string;
    session_proof: Record<string, unknown>;
    workspace_hint?: string;
  }): Promise<{ user_id: string; workspace_id: string; scopes: string[] }>;
}

/**
 * Purpose:
 * Construction options for `AuthService`.
 *
 * Constraints:
 * - `secret` must remain stable for the lifetime of issued workspace tokens
 * - `database` must be the canonical control-plane store for API keys
 */
export interface AuthServiceOptions {
  readonly secret: string;
  readonly database: ControlPlaneDatabase;
  readonly sessionProofValidator: SessionProofValidator;
  readonly tokenTtlMs?: number;
}

/**
 * Purpose:
 * Payload accepted when exchanging a provider session proof for an OR3 token.
 */
export interface ExchangeSessionInput {
  readonly provider: string;
  readonly session_proof: Record<string, unknown>;
  readonly workspace_id?: string;
}

/**
 * Purpose:
 * Authenticates incoming callers and issues workspace-scoped access tokens.
 *
 * Behavior:
 * The service first prefers signed workspace tokens. If token validation fails
 * for reasons other than expiration, it falls back to API-key lookup so both
 * auth modes share the same bearer header surface.
 *
 * Constraints:
 * - Workspace-token TTL defaults to 15 minutes
 * - API key expiry is surfaced as an absolute Unix timestamp
 *
 * Non-Goals:
 * - Does not track refresh tokens or long-lived user sessions
 * - Does not perform per-route scope checks
 */
export class AuthService {
  private readonly tokenTtlMs: number;

  public constructor(private readonly options: AuthServiceOptions) {
    this.tokenTtlMs = options.tokenTtlMs ?? 15 * 60_000;
  }

  /**
   * Purpose:
   * Exchanges validated provider session proof for a signed OR3 auth token.
   */
  public async exchangeSessionProof(input: ExchangeSessionInput): Promise<AuthToken> {
    const validated = await this.options.sessionProofValidator.validateSessionProof({
      provider: input.provider,
      session_proof: input.session_proof,
      ...(input.workspace_id === undefined ? {} : { workspace_hint: input.workspace_id }),
    });

    return issueWorkspaceToken({
      secret: this.options.secret,
      subject: validated.user_id,
      workspace_id: validated.workspace_id,
      scopes: validated.scopes,
      ttlMs: this.tokenTtlMs,
    });
  }

  /**
   * Purpose:
   * Resolves a bearer header into a workspace principal.
   *
   * Behavior:
   * Accepts either a signed workspace token or a raw API key. Expired workspace
   * tokens are not treated as API keys so callers get the correct auth error.
   *
   * @throws Error when the header is missing, malformed, expired, or invalid.
   */
  public async authenticateBearerToken(headerValue: string | null): Promise<WorkspacePrincipal> {
    if (headerValue === null) {
      throw new Error("missing bearer token");
    }

    const [scheme, value] = headerValue.trim().split(/\s+/, 2);
    if (scheme?.toLowerCase() !== "bearer" || value === undefined || value.trim() === "") {
      throw new Error("missing bearer token");
    }

    try {
      return await validateWorkspaceToken(this.options.secret, value);
    } catch (error) {
      if (isExpiredWorkspaceTokenError(error)) {
        throw error;
      }
      const apiKey = await this.authenticateApiKey(value);
      const issuedAt = Math.floor(Date.parse(apiKey.created_at) / 1000);
      const expiresAt = apiKey.expires_at === null
        ? MAX_API_KEY_EXPIRY_SECONDS
        : Math.floor(Date.parse(apiKey.expires_at) / 1000);
      return {
        subject: apiKey.api_key_id,
        workspace_id: apiKey.workspace_id,
        scopes: apiKey.scopes,
        auth_type: "api-key",
        issued_at: issuedAt,
        expires_at: expiresAt,
      };
    }
  }

  /**
   * Purpose:
   * Creates a new workspace API key record and returns the only plaintext copy.
   *
   * Constraints:
   * - The returned `api_key` value cannot be recovered from storage later
   * - Stored records persist only the hashed token value
   */
  public async createApiKey(input: {
    readonly workspace_id: string;
    readonly name: string;
    readonly scopes: string[];
    readonly expires_at?: string;
  }): Promise<{ api_key: string; record: StoredApiKey }> {
    const rawToken = `or3k_${createId("token")}`;
    const keyHash = await hashApiKey(rawToken);
    const record = this.options.database.saveApiKey({
      api_key_id: createId("api"),
      workspace_id: input.workspace_id,
      name: input.name,
      key_hash: keyHash,
      scopes: input.scopes,
      ...(input.expires_at === undefined ? {} : { expires_at: input.expires_at }),
    });
    return { api_key: rawToken, record };
  }

  /**
   * Purpose:
   * Lists active and revoked API keys for a workspace from the control-plane
   * store.
   */
  public listApiKeys(workspaceId: string): StoredApiKey[] {
    return this.options.database.listApiKeys(workspaceId);
  }

  /**
   * Purpose:
   * Marks an API key as revoked so future bearer authentication fails.
   */
  public revokeApiKey(workspaceId: string, apiKeyId: string): StoredApiKey {
    return this.options.database.revokeApiKey(workspaceId, apiKeyId);
  }

  private async authenticateApiKey(rawToken: string): Promise<StoredApiKey> {
    const keyHash = await hashApiKey(rawToken);
    const apiKey = this.options.database.findActiveApiKeyByHash(keyHash);
    if (apiKey === null) {
      throw new Error("invalid bearer token");
    }
    return apiKey;
  }
}

/** Unix timestamp for 9999-12-31T23:59:59Z — effectively "never expires" for API keys. */
const MAX_API_KEY_EXPIRY_SECONDS = 253402300799;

const isExpiredWorkspaceTokenError = (error: unknown): boolean =>
  error instanceof Error && error.message.toLowerCase().includes("workspace token expired");