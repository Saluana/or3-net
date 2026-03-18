/**
 * @module src/nodes/registry
 *
 * Purpose:
 * Enrolls and approves remote nodes for a workspace, including short-lived
 * runtime credential issuance.
 */
import type { z } from "zod";
import { z as schema } from "zod";

import type { NodeHealthStatus } from "../contracts/index.ts";
import type { ControlPlaneDatabase, StoredNode } from "../db/index.ts";
import { createId } from "../lib/ids.ts";
import { hashApiKey, sha256Hex } from "../lib/crypto.ts";
import { nodeManifestSchema } from "../contracts/index.ts";
import { verifyNodeManifestSignature } from "./signatures.ts";

/** Purpose: Enrollment payload for a node manifest. */
export const enrollNodeRequestSchema = nodeManifestSchema;
export const issueNodeBootstrapTokenRequestSchema = schema.object({
  expires_at: schema.string().datetime().optional(),
});
export const redeemNodeBootstrapTokenRequestSchema = schema.object({
  token: schema.string().trim().min(1),
  manifest: nodeManifestSchema,
});

/** Purpose: Construction options for the node registry service. */
export interface NodeRegistryOptions {
  readonly database: ControlPlaneDatabase;
  readonly credentialTtlMs?: number;
  readonly bootstrapTokenTtlMs?: number;
}

/**
 * Purpose:
 * Manages node enrollment records and approval-time credential rotation.
 */
export class NodeRegistryService {
  private readonly credentialTtlMs: number;
  private readonly bootstrapTokenTtlMs: number;

  public constructor(private readonly options: NodeRegistryOptions) {
    this.credentialTtlMs = options.credentialTtlMs ?? 60 * 60_000;
    this.bootstrapTokenTtlMs = options.bootstrapTokenTtlMs ?? 15 * 60_000;
  }

  /** Purpose: Verifies and stores a node manifest for a workspace. */
  public async enrollNode(workspaceId: string, manifestInput: z.input<typeof enrollNodeRequestSchema>): Promise<StoredNode> {
    const manifest = enrollNodeRequestSchema.parse(manifestInput);
    if (!verifyNodeManifestSignature(manifest)) {
      throw new Error("invalid node manifest signature");
    }

    const workspaceStore = this.options.database.workspace(workspaceId);
    const existing = workspaceStore.listNodes().find((node) => node.manifest.node_id === manifest.node_id);
    const fingerprint = await sha256Hex(manifest.pubkey);
    if (existing !== undefined && existing.pubkey_fingerprint !== fingerprint) {
      throw new Error("node id already exists with a different public key");
    }

    return workspaceStore.saveNode({
      manifest,
      pubkey_fingerprint: fingerprint,
      status: "pending",
      ...(existing?.health_status === undefined ? {} : { health_status: existing.health_status as NodeHealthStatus }),
      last_seen_at: existing?.last_seen_at ?? new Date().toISOString(),
    });
  }

  /** Purpose: Lists enrolled nodes for a workspace. */
  public listNodes(workspaceId: string): StoredNode[] {
    return this.options.database.workspace(workspaceId).listNodes();
  }

  /** Purpose: Fetches a single enrolled node. */
  public getNode(workspaceId: string, nodeId: string): StoredNode {
    return this.options.database.workspace(workspaceId).getNode(nodeId);
  }

  /**
   * Purpose:
   * Approves a node and issues a fresh transport credential, rotating any prior
   * active credentials for that node.
   */
  public async approveNode(workspaceId: string, nodeId: string): Promise<{
    node: StoredNode;
    credential: { token: string; expires_at: string };
  }> {
    const workspaceStore = this.options.database.workspace(workspaceId);
    const current = workspaceStore.getNode(nodeId);
    const node = workspaceStore.saveNode({
      manifest: current.manifest,
      pubkey_fingerprint: current.pubkey_fingerprint,
      status: "approved",
      health_status:
        current.health_status === "unknown"
          ? "healthy"
          : (current.health_status as NodeHealthStatus),
      approved_at: new Date().toISOString(),
      last_seen_at: current.last_seen_at ?? new Date().toISOString(),
    });

    const credential = await this.issueRuntimeCredential(workspaceId, nodeId);

    return {
      node,
      credential,
    };
  }

  /** Purpose: Issues a short-lived bootstrap token for node enrollment. */
  public async issueBootstrapToken(workspaceId: string, input: z.input<typeof issueNodeBootstrapTokenRequestSchema> = {}): Promise<{
    bootstrap_token_id: string;
    token: string;
    expires_at: string;
  }> {
    const payload = issueNodeBootstrapTokenRequestSchema.parse(input);
    const token = `or3b_${createId("bootstrap")}`;
    const expiresAt = payload.expires_at ?? new Date(Date.now() + this.bootstrapTokenTtlMs).toISOString();
    const bootstrapTokenId = createId("nodeboot");
    this.options.database.workspace(workspaceId).saveNodeBootstrapToken({
      bootstrap_token_id: bootstrapTokenId,
      token_hash: await hashApiKey(token),
      token_ciphertext: token,
      expires_at: expiresAt,
    });
    return { bootstrap_token_id: bootstrapTokenId, token, expires_at: expiresAt };
  }

  /** Purpose: Redeems a bootstrap token to enroll a node and optionally retrieve its active runtime credential. */
  public async redeemBootstrapToken(input: z.input<typeof redeemNodeBootstrapTokenRequestSchema>): Promise<{
    workspace_id: string;
    node: StoredNode;
    credential: { token: string; expires_at: string } | null;
  }> {
    const payload = redeemNodeBootstrapTokenRequestSchema.parse(input);
    const tokenHash = await hashApiKey(payload.token);
    const bootstrapToken = this.options.database.findActiveNodeBootstrapTokenByHash(tokenHash);
    if (bootstrapToken === null) {
      throw new Error("invalid or expired node bootstrap token");
    }

    if (bootstrapToken.node_id !== null && bootstrapToken.node_id !== payload.manifest.node_id) {
      throw new Error("bootstrap token is already bound to a different node id");
    }

    const workspaceStore = this.options.database.workspace(bootstrapToken.workspace_id);
    const fingerprint = await sha256Hex(payload.manifest.pubkey);
    let node: StoredNode;
    try {
      const existing = workspaceStore.getNode(payload.manifest.node_id);
      if (existing.pubkey_fingerprint !== fingerprint) {
        throw new Error("node id already exists with a different public key");
      }

      if (existing.status === "approved") {
        node = existing;
      } else {
        node = await this.enrollNode(bootstrapToken.workspace_id, payload.manifest);
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("was not found")) {
        node = await this.enrollNode(bootstrapToken.workspace_id, payload.manifest);
      } else {
        throw error;
      }
    }

    this.options.database.workspace(bootstrapToken.workspace_id).saveNodeBootstrapToken({
      bootstrap_token_id: bootstrapToken.bootstrap_token_id,
      token_hash: bootstrapToken.token_hash,
      token_ciphertext: bootstrapToken.token_ciphertext ?? payload.token,
      node_id: node.manifest.node_id,
      created_at: bootstrapToken.created_at,
      expires_at: bootstrapToken.expires_at,
      ...(bootstrapToken.revoked_at === null ? {} : { revoked_at: bootstrapToken.revoked_at }),
    });

    const credential = node.status === "approved"
      ? await this.issueRuntimeCredential(bootstrapToken.workspace_id, node.manifest.node_id)
      : null;

    return {
      workspace_id: bootstrapToken.workspace_id,
      node: this.options.database.workspace(bootstrapToken.workspace_id).getNode(node.manifest.node_id),
      credential,
    };
  }

  private async issueRuntimeCredential(workspaceId: string, nodeId: string): Promise<{ token: string; expires_at: string }> {
    const workspaceStore = this.options.database.workspace(workspaceId);
    const token = `or3n_${createId("cred")}`;
    const rotatedAt = new Date().toISOString();
    for (const credential of workspaceStore.listNodeCredentials(nodeId).filter((item) => item.rotated_at === null)) {
      workspaceStore.saveNodeCredential({
        credential_id: credential.credential_id,
        node_id: credential.node_id,
        token_hash: credential.token_hash,
        issued_at: credential.issued_at,
        expires_at: credential.expires_at,
        rotated_at: rotatedAt,
        ...(credential.token_ciphertext === null ? {} : { token_ciphertext: credential.token_ciphertext }),
      });
    }
    const expiresAt = new Date(Date.now() + this.credentialTtlMs).toISOString();
    workspaceStore.saveNodeCredential({
      credential_id: createId("nodecred"),
      node_id: nodeId,
      token_hash: await hashApiKey(token),
      token_ciphertext: token,
      expires_at: expiresAt,
    });
    return { token, expires_at: expiresAt };
  }
}
