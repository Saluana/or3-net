import type { ControlPlaneDatabase, StoredApiKey } from "../db/index.ts";

import { createId } from "../lib/ids.ts";
import { hashApiKey } from "../lib/crypto.ts";
import type { AuthToken } from "../contracts/index.ts";
import { issueWorkspaceToken, validateWorkspaceToken, type WorkspacePrincipal } from "./tokens.ts";

export interface SessionProofValidator {
  validateSessionProof(input: {
    provider: string;
    session_proof: Record<string, unknown>;
    workspace_hint?: string;
  }): Promise<{ user_id: string; workspace_id: string; scopes: string[] }>;
}

export interface AuthServiceOptions {
  readonly secret: string;
  readonly database: ControlPlaneDatabase;
  readonly sessionProofValidator: SessionProofValidator;
  readonly tokenTtlMs?: number;
}

export interface ExchangeSessionInput {
  readonly provider: string;
  readonly session_proof: Record<string, unknown>;
  readonly workspace_id?: string;
}

export class AuthService {
  private readonly tokenTtlMs: number;

  public constructor(private readonly options: AuthServiceOptions) {
    this.tokenTtlMs = options.tokenTtlMs ?? 15 * 60_000;
  }

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
    } catch {
      const apiKey = await this.authenticateApiKey(value);
      return {
        subject: apiKey.api_key_id,
        workspace_id: apiKey.workspace_id,
        scopes: apiKey.scopes,
        auth_type: "api-key",
      };
    }
  }

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

  public listApiKeys(workspaceId: string): StoredApiKey[] {
    return this.options.database.listApiKeys(workspaceId);
  }

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