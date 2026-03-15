/**
 * @module src/db/types
 *
 * Purpose:
 * Shared public types and small invariants for the OR3 Net control-plane
 * database layer.
 *
 * Responsibilities:
 * - Describe input shapes accepted by persistence methods
 * - Describe startup reconciliation output used by higher layers
 * - Hold low-level invariants reused across modules after the DB split
 *
 * Non-responsibilities:
 * - Does not execute SQL
 * - Does not parse stored rows; see `codecs.ts`
 * - Does not own schema definitions; those live in `contracts/**` and `schema.ts`
 *
 * @remarks
 * These types are part of the database API surface and are intentionally kept
 * colocated so internal module boundaries do not leak into callers.
 */
import type { z } from "zod";

import type {
  jobSchema,
  leaseSchema,
  nodeManifestSchema,
  NodeApprovalStatus,
  NodeHealthStatus,
  previewDescriptorSchema,
  taskPackageSchema,
} from "../contracts/index.ts";
import type { runtimeArtifactDescriptorSchema } from "../contracts/runtime/artifacts.ts";
import type {
  RuntimeCapability,
  RuntimeErrorEnvelope,
  runtimeSessionCreateInputSchema,
  RuntimeSessionState,
  RuntimeTrustTier,
  RuntimeWorkspaceStagingStatus,
  WorkspaceCommitResult,
} from "../contracts/runtime/index.ts";

/** Purpose: Summary returned after startup reconciliation repairs stale state. */
export interface StartupReconciliationSummary {
  readonly failed_jobs: number;
  readonly expired_leases: number;
  readonly released_leases: number;
  readonly stale_nodes: number;
}

/** Purpose: Construction options for the control-plane database client. */
export interface DatabaseOptions {
  readonly path?: string;
  readonly staleNodeThresholdMs?: number;
  readonly jobEventRetentionPerJob?: number;
  readonly runtimeSessionEventRetentionPerSession?: number;
}

/** Purpose: Input shape for persisting or updating an enrolled node. */
export interface SaveNodeInput {
  readonly manifest: Parameters<typeof nodeManifestSchema.parse>[0];
  readonly pubkey_fingerprint: string;
  readonly status?: NodeApprovalStatus;
  readonly health_status?: NodeHealthStatus;
  readonly approved_at?: string;
  readonly revoked_at?: string;
  readonly last_seen_at?: string;
  readonly last_error?: string;
  readonly created_at?: string;
}

/** Purpose: Input shape for persisting a job and its task package. */
export interface SaveJobInput {
  readonly job: Parameters<typeof jobSchema.parse>[0];
  readonly task_package: Parameters<typeof taskPackageSchema.parse>[0];
  readonly network_session_id?: string;
}

/** Purpose: Input shape for persisting a network session binding. */
export interface SaveNetworkSessionInput {
  readonly network_session_id: string;
  readonly client_kind: string;
  readonly client_session_id?: string;
  readonly intern_session_key: string;
  readonly initiator_subject?: string;
  readonly status: string;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly last_job_id?: string;
  readonly last_activity_at?: string;
  readonly closed_at?: string;
}

/** Purpose: Partial update for an existing network session binding. */
export interface TouchNetworkSessionInput {
  readonly status?: string;
  readonly last_job_id?: string;
  readonly last_activity_at?: string;
  readonly closed_at?: string;
}

/** Purpose: Input shape for appending a retained job event. */
export interface AppendJobEventInput {
  readonly job_id: string;
  readonly network_session_id?: string;
  readonly event_type: string;
  readonly payload: Record<string, unknown>;
  readonly created_at?: string;
}

/** Purpose: Filter options for querying retained job events. */
export interface ListJobEventsInput {
  readonly job_id?: string;
  readonly network_session_id?: string;
  readonly limit?: number;
}

/** Purpose: Input shape for persisting a lease record. */
export interface SaveLeaseInput {
  readonly lease: Parameters<typeof leaseSchema.parse>[0];
  readonly workspace_id: string;
  readonly job_id: string;
  readonly created_at?: string;
  readonly expires_at: string;
  readonly released_at?: string;
}

/** Purpose: Input shape for creating or replacing a runtime session record. */
export interface SaveRuntimeSessionInput {
  readonly session_id: string;
  readonly adapter_id: string;
  readonly adapter_session_ref?: string;
  readonly node_id?: string;
  readonly preset_id?: string;
  readonly status: RuntimeSessionState;
  readonly capabilities: Iterable<RuntimeCapability>;
  readonly config?: z.input<typeof runtimeSessionCreateInputSchema>;
  readonly host_workspace_root?: string;
  readonly workspace_stage_mode?: "read_only" | "read_write";
  readonly staging_status?: RuntimeWorkspaceStagingStatus;
  readonly last_commit?: WorkspaceCommitResult;
  readonly isolation_class: string;
  readonly trust_tier: RuntimeTrustTier;
  readonly error?: RuntimeErrorEnvelope;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly destroyed_at?: string;
}

/** Purpose: Partial update for an existing runtime session record. */
export interface TouchRuntimeSessionInput {
  readonly adapter_id?: string;
  readonly adapter_session_ref?: string | null;
  readonly node_id?: string | null;
  readonly preset_id?: string | null;
  readonly status?: RuntimeSessionState;
  readonly capabilities?: Iterable<RuntimeCapability>;
  readonly config?: z.input<typeof runtimeSessionCreateInputSchema> | null;
  readonly host_workspace_root?: string | null;
  readonly workspace_stage_mode?: "read_only" | "read_write" | null;
  readonly workspace_stage_transport?: "auto" | "archive" | "file_api" | null;
  readonly staging_status?: RuntimeWorkspaceStagingStatus;
  readonly last_commit?: WorkspaceCommitResult | null;
  readonly isolation_class?: string;
  readonly trust_tier?: RuntimeTrustTier;
  readonly error?: RuntimeErrorEnvelope | null;
  readonly updated_at?: string;
  readonly destroyed_at?: string | null;
}

/** Purpose: Filter options for listing runtime sessions. */
export interface ListRuntimeSessionsInput {
  readonly status?: string;
  readonly adapter_id?: string;
  readonly limit?: number;
}

/** Purpose: Input shape for appending a retained runtime session event. */
export interface AppendRuntimeSessionEventInput {
  readonly session_id: string;
  readonly event_type: string;
  readonly payload: Record<string, unknown>;
  readonly created_at?: string;
}

/** Purpose: Input shape for persisting a runtime artifact. */
export interface SaveRuntimeArtifactInput {
  readonly artifact: Parameters<typeof runtimeArtifactDescriptorSchema.parse>[0];
  readonly created_at?: string;
}

/** Purpose: Input shape for persisting a preview record. */
export interface SavePreviewInput {
  readonly preview: Parameters<typeof previewDescriptorSchema.parse>[0];
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly revoked_at?: string;
}

/** Purpose: Input shape for persisting an idempotency record. */
export interface SaveIdempotencyRecordInput {
  readonly scope: string;
  readonly owner_key: string;
  readonly idempotency_key: string;
  readonly request_body: string;
  readonly response_json: string;
  readonly status_code: number;
  readonly resource_id?: string;
  readonly created_at?: string;
  readonly expires_at: string;
}

/**
 * Purpose:
 * Enforces workspace scoping for values that already carry a `workspace_id`.
 *
 * Behavior:
 * Throws when a payload's declared workspace differs from the surrounding store
 * or control-plane context.
 *
 * Constraints:
 * - Intended for cheap invariant checks, not authorization
 * - Error messages stay generic to avoid leaking unrelated identifiers
 *
 * Non-Goals:
 * - Does not normalize ids
 * - Does not resolve or validate workspace existence
 */
export const assertWorkspaceMatch = (label: string, expectedWorkspaceId: string, actualWorkspaceId: string): void => {
  if (expectedWorkspaceId !== actualWorkspaceId) {
    throw new Error(`${label} workspace mismatch`);
  }
};

/**
 * Purpose:
 * Canonical set of non-terminal job states that should be repaired after a host
 * restart.
 *
 * Behavior:
 * Used by startup reconciliation to find jobs that were in-flight when the host
 * stopped unexpectedly.
 *
 * Constraints:
 * - Must stay aligned with `jobStatusSchema`
 * - Excludes terminal states by design
 */
export const recoverableStartupJobStatuses = ["pending", "scheduled", "running"] as const;

/**
 * Purpose:
 * Shared lease state literal used when selecting currently-held leases.
 *
 * Behavior:
 * Centralizes the active-state string so reconciliation and lease helpers do not
 * drift.
 */
export const activeLeaseState = "active";
