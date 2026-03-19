/**
 * @module src/db/codecs
 *
 * Purpose:
 * Row-to-object conversion helpers for the OR3 Net control-plane database.
 *
 * Responsibilities:
 * - Parse SQLite row payloads into validated stored objects
 * - Reuse contract schemas so stored JSON stays aligned with the public API
 * - Centralize conversion between epoch timestamps and ISO strings
 *
 * Non-responsibilities:
 * - Does not execute writes or reads itself
 * - Does not own database lifecycle or migration logic
 *
 * @remarks
 * Internal API. These helpers are exported so database modules can share them,
 * but callers should prefer `WorkspaceStore` and `ControlPlaneDatabase`.
 */
import {
  agentSchema,
  jobErrorSchema,
  jobSchema,
  jobResultSchema,
  leaseSchema,
  nodeRequirementsSchema,
  nodeManifestSchema,
  toolPolicySchema,
  previewDescriptorSchema,
  taskPackageSchema,
} from "../contracts/index.ts";
import {
  runtimeArtifactDescriptorSchema,
  runtimeCapabilitySetSchema,
  runtimeErrorEnvelopeSchema,
  runtimeSessionCreateInputSchema,
  runtimeSessionDescriptorSchema,
  runtimeWorkspaceStagingStatusSchema,
  workspaceCommitResultSchema,
} from "../contracts/runtime/index.ts";
import { jsonObjectSchema, parseOptionalWithSchema, parseWithSchema } from "../contracts/shared.ts";
import { toIsoDateTime } from "../lib/time.ts";
import type {
  AgentRow,
  ApiKeyRow,
  JobEventRow,
  JobRow,
  IdempotencyRecordRow,
  LeaseRow,
  NetworkSessionRow,
  NodeCredentialRow,
  NodeRow,
  PreviewRow,
  RuntimeArtifactRow,
  RuntimeSessionEventRow,
  RuntimeSessionRow,
  NodeBootstrapTokenRow,
  StoredAgent,
  StoredApiKey,
  StoredIdempotencyRecord,
  StoredJobEvent,
  StoredJobWithDiagnostics,
  StoredLease,
  StoredNetworkSession,
  StoredNode,
  StoredNodeBootstrapToken,
  StoredNodeCredential,
  StoredPreview,
  StoredRuntimeArtifact,
  StoredRuntimeSession,
  StoredRuntimeSessionEvent,
  StoredWorkspace,
  WorkspaceRow,
} from "./schema.ts";

const stringArraySchema = agentSchema.shape.node_requirements.shape.capabilities;

/**
 * Purpose:
 * Canonical terminal job-state set used by lease and reconciliation helpers.
 *
 * Behavior:
 * Exposes a single membership test for code paths that must avoid mutating jobs
 * which have already completed, failed, or been aborted.
 */
export const terminalJobStatuses = new Set<JobRow["status"]>(["completed", "failed", "aborted"]);

/**
 * Purpose:
 * Converts a raw workspace row into the stored workspace view returned by the
 * database layer.
 */
export const parseWorkspaceRow = (row: WorkspaceRow): StoredWorkspace => {
  const config = row.config_json === null ? undefined : parseWithSchema(jsonObjectSchema, row.config_json);
  return {
    workspace_id: row.id,
    name: row.name,
    created_at: toIsoDateTime(row.created_at),
    updated_at: toIsoDateTime(row.updated_at),
    config,
  };
};

/** Purpose: Converts a raw API key row into the stored API key view. */
export const parseApiKeyRow = (row: ApiKeyRow): StoredApiKey => ({
  api_key_id: row.id,
  workspace_id: row.workspace_id,
  name: row.name,
  key_hash: row.key_hash,
  scopes: parseWithSchema(stringArraySchema, row.scopes_json),
  created_at: toIsoDateTime(row.created_at),
  expires_at: row.expires_at === null ? null : toIsoDateTime(row.expires_at),
  revoked_at: row.revoked_at === null ? null : toIsoDateTime(row.revoked_at),
});

/** Purpose: Converts a raw node row into the stored node view. */
export const parseNodeRow = (row: NodeRow): StoredNode => ({
  workspace_id: row.workspace_id,
  manifest: nodeManifestSchema.parse(JSON.parse(row.manifest_json) as unknown),
  pubkey_fingerprint: row.pubkey_fingerprint,
  status: row.status,
  health_status: row.health_status,
  approved_at: row.approved_at === null ? null : toIsoDateTime(row.approved_at),
  revoked_at: row.revoked_at === null ? null : toIsoDateTime(row.revoked_at),
  last_seen_at: row.last_seen_at === null ? null : toIsoDateTime(row.last_seen_at),
  last_error: row.last_error,
  created_at: toIsoDateTime(row.created_at),
});

/** Purpose: Converts a raw job row into the stored job view with parsed diagnostics. */
export const parseJobRow = (row: JobRow): StoredJobWithDiagnostics => {
  const result = parseOptionalWithSchema(jobResultSchema, row.result_json);
  const error = parseOptionalWithSchema(jobErrorSchema, row.error_json);
  const taskPackage = parseWithSchema(taskPackageSchema, row.task_package_json);
  return {
    network_session_id: row.network_session_id,
    job: jobSchema.parse({
      job_id: row.id,
      workspace_id: row.workspace_id,
      status: row.status,
      node_id: row.node_id ?? undefined,
      created_at: toIsoDateTime(row.created_at),
      started_at: row.started_at === null ? undefined : toIsoDateTime(row.started_at),
      completed_at: row.completed_at === null ? undefined : toIsoDateTime(row.completed_at),
      result: result ?? undefined,
      error: error ?? undefined,
    }),
    task_package: taskPackage,
    result,
    error,
  };
};

/** Purpose: Converts a raw network-session row into the stored binding view. */
export const parseNetworkSessionRow = (row: NetworkSessionRow): StoredNetworkSession => ({
  network_session_id: row.id,
  workspace_id: row.workspace_id,
  client_kind: row.client_kind,
  client_session_id: row.client_session_id,
  intern_session_key: row.intern_session_key,
  initiator_subject: row.initiator_subject,
  status: row.status,
  created_at: toIsoDateTime(row.created_at),
  updated_at: toIsoDateTime(row.updated_at),
  last_job_id: row.last_job_id,
  last_activity_at: toIsoDateTime(row.last_activity_at),
  closed_at: row.closed_at === null ? null : toIsoDateTime(row.closed_at),
});

/** Purpose: Converts a raw job-event row into the stored retained-event view. */
export const parseJobEventRow = (row: JobEventRow): StoredJobEvent => ({
  event_id: row.id,
  workspace_id: row.workspace_id,
  job_id: row.job_id,
  network_session_id: row.network_session_id,
  event_type: row.event_type,
  sequence: row.sequence,
  payload_json: row.payload_json,
  created_at: toIsoDateTime(row.created_at),
});

/** Purpose: Converts a raw runtime-session row into the validated stored runtime-session view. */
export const parseRuntimeSessionRow = (row: RuntimeSessionRow): StoredRuntimeSession => {
  const capabilities = parseWithSchema(runtimeCapabilitySetSchema, row.capabilities_json);
  const config = parseOptionalWithSchema(runtimeSessionCreateInputSchema, row.config_json);
  const error = parseOptionalWithSchema(runtimeErrorEnvelopeSchema, row.error_json);
  const lastCommit = parseOptionalWithSchema(workspaceCommitResultSchema, row.last_commit_json);
  const stagingStatus = row.staging_status === null ? "none" : runtimeWorkspaceStagingStatusSchema.parse(row.staging_status);

  return {
    adapter_session_ref: row.adapter_session_ref,
    config,
    session: runtimeSessionDescriptorSchema.parse({
      session_id: row.id,
      workspace_id: row.workspace_id,
      adapter_id: row.adapter_id,
      node_id: row.node_id ?? undefined,
      status: row.status,
      capabilities,
      isolation_class: row.isolation_class,
      trust_tier: row.trust_tier,
      preset_id: row.preset_id ?? undefined,
      created_at: toIsoDateTime(row.created_at),
      updated_at: toIsoDateTime(row.updated_at),
      destroyed_at: row.destroyed_at === null ? undefined : toIsoDateTime(row.destroyed_at),
      workspace_stage: config?.workspace_stage,
      host_workspace_root: row.host_workspace_root ?? undefined,
      workspace_stage_mode: row.workspace_stage_mode ?? undefined,
      workspace_stage_transport: row.workspace_stage_transport ?? config?.workspace_stage?.transport,
      staging_status: stagingStatus,
      last_commit: lastCommit ?? undefined,
      error: error ?? undefined,
    }),
  };
};

/** Purpose: Converts a raw runtime-session-event row into the stored event view. */
export const parseRuntimeSessionEventRow = (row: RuntimeSessionEventRow): StoredRuntimeSessionEvent => ({
  event_id: row.id,
  workspace_id: row.workspace_id,
  session_id: row.session_id,
  event_type: row.event_type,
  sequence: row.sequence,
  payload_json: row.payload_json,
  created_at: toIsoDateTime(row.created_at),
});

/** Purpose: Converts a raw runtime-artifact row into the stored artifact view. */
export const parseRuntimeArtifactRow = (row: RuntimeArtifactRow): StoredRuntimeArtifact => ({
  workspace_id: row.workspace_id,
  artifact: runtimeArtifactDescriptorSchema.parse({
    artifact_id: row.id,
    session_id: row.session_id,
    path: row.path,
    kind: row.kind,
    content_type: row.content_type,
    size_bytes: row.size_bytes,
    source: row.source_json === null ? undefined : parseWithSchema(jsonObjectSchema, row.source_json),
  }),
  created_at: toIsoDateTime(row.created_at),
});

/** Purpose: Converts a raw lease row into the stored lease view. */
export const parseLeaseRow = (row: LeaseRow): StoredLease => ({
  workspace_id: row.workspace_id,
  job_id: row.job_id,
  lease: leaseSchema.parse({
    lease_id: row.id,
    node_id: row.node_id,
    profile: parseWithSchema(leaseSchema.shape.profile, row.profile_json),
    ttl: row.ttl_seconds,
    reset_required: row.reset_required === 1,
    state: row.state,
  }),
  created_at: toIsoDateTime(row.created_at),
  expires_at: toIsoDateTime(row.expires_at),
  released_at: row.released_at === null ? null : toIsoDateTime(row.released_at),
});

/** Purpose: Converts a raw agent row into the stored agent view. */
export const parseAgentRow = (row: AgentRow): StoredAgent => ({
  agent_id: row.id,
  workspace_id: row.workspace_id,
  name: row.name,
  instructions: row.instructions,
  tool_policy: parseWithSchema(toolPolicySchema, row.tool_policy_json),
  node_requirements: parseWithSchema(nodeRequirementsSchema, row.node_requirements_json),
  created_at: toIsoDateTime(row.created_at),
  updated_at: toIsoDateTime(row.updated_at),
});

/** Purpose: Converts a raw preview row into the stored preview view. */
export const parsePreviewRow = (row: PreviewRow): StoredPreview => ({
  preview: previewDescriptorSchema.parse(JSON.parse(row.descriptor_json) as unknown),
  revoked_at: row.revoked_at === null ? null : toIsoDateTime(row.revoked_at),
  created_at: toIsoDateTime(row.created_at),
  updated_at: toIsoDateTime(row.updated_at),
});

/** Purpose: Converts a raw node-credential row into the stored credential view. */
export const parseNodeCredentialRow = (row: NodeCredentialRow): StoredNodeCredential => ({
  credential_id: row.id,
  node_id: row.node_id,
  workspace_id: row.workspace_id,
  token_hash: row.token_hash,
  token_ciphertext: row.token_ciphertext,
  issued_at: toIsoDateTime(row.issued_at),
  expires_at: toIsoDateTime(row.expires_at),
  rotated_at: row.rotated_at === null ? null : toIsoDateTime(row.rotated_at),
});

/** Purpose: Converts a raw node-bootstrap-token row into the stored token view. */
export const parseNodeBootstrapTokenRow = (row: NodeBootstrapTokenRow): StoredNodeBootstrapToken => ({
  bootstrap_token_id: row.id,
  workspace_id: row.workspace_id,
  token_hash: row.token_hash,
  token_ciphertext: row.token_ciphertext,
  node_id: row.node_id,
  created_at: toIsoDateTime(row.created_at),
  expires_at: toIsoDateTime(row.expires_at),
  revoked_at: row.revoked_at === null ? null : toIsoDateTime(row.revoked_at),
});

/** Purpose: Converts a raw idempotency-record row into the stored replay view. */
export const parseIdempotencyRecordRow = (row: IdempotencyRecordRow): StoredIdempotencyRecord => ({
  scope: row.scope,
  owner_key: row.owner_key,
  idempotency_key: row.idempotency_key,
  request_body: row.request_body,
  response_json: row.response_json,
  status_code: row.status_code,
  resource_id: row.resource_id,
  created_at: toIsoDateTime(row.created_at),
  expires_at: toIsoDateTime(row.expires_at),
});
