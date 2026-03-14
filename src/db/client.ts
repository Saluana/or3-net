import { Database } from "bun:sqlite";

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
  workspaceSchema,
} from "../contracts/index.ts";
import { jsonObjectSchema, parseOptionalWithSchema, parseWithSchema, serializeWithSchema } from "../contracts/shared.ts";
import { fromIsoDateTime, toIsoDateTime } from "../lib/time.ts";
import type { NodeApprovalStatus, NodeHealthStatus } from "../contracts/index.ts";
import type {
  AgentRow,
  ApiKeyRow,
  JobRow,
  JobEventRow,
  IdempotencyRecordRow,
  LeaseRow,
  NodeRow,
  NodeCredentialRow,
  NetworkSessionRow,
  PreviewRow,
  StoredAgent,
  StoredApiKey,
  StoredJobEvent,
  StoredIdempotencyRecord,
  StoredJobWithDiagnostics,
  StoredLease,
  StoredNetworkSession,
  StoredNodeCredential,
  StoredNode,
  StoredPreview,
  StoredWorkspace,
  WorkspaceRow,
} from "./schema.ts";
import { schemaMigrations } from "./schema.ts";

const stringArraySchema = agentSchema.shape.node_requirements.shape.capabilities;
const terminalJobStatuses = new Set<JobRow["status"]>(["completed", "failed", "aborted"]);

export interface StartupReconciliationSummary {
  readonly failed_jobs: number;
  readonly expired_leases: number;
  readonly stale_nodes: number;
}

export interface DatabaseOptions {
  readonly path?: string;
  readonly staleNodeThresholdMs?: number;
  readonly jobEventRetentionPerJob?: number;
}

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

export interface SaveJobInput {
  readonly job: Parameters<typeof jobSchema.parse>[0];
  readonly task_package: Parameters<typeof taskPackageSchema.parse>[0];
  readonly network_session_id?: string;
}

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

export interface TouchNetworkSessionInput {
  readonly status?: string;
  readonly last_job_id?: string;
  readonly last_activity_at?: string;
  readonly closed_at?: string;
}

export interface AppendJobEventInput {
  readonly job_id: string;
  readonly network_session_id?: string;
  readonly event_type: string;
  readonly payload: Record<string, unknown>;
  readonly created_at?: string;
}

export interface ListJobEventsInput {
  readonly job_id?: string;
  readonly network_session_id?: string;
  readonly limit?: number;
}

export interface SaveLeaseInput {
  readonly lease: Parameters<typeof leaseSchema.parse>[0];
  readonly workspace_id: string;
  readonly job_id: string;
  readonly created_at?: string;
  readonly expires_at: string;
  readonly released_at?: string;
}

export interface SavePreviewInput {
  readonly preview: Parameters<typeof previewDescriptorSchema.parse>[0];
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly revoked_at?: string;
}

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

const runningJobStatuses = ["scheduled", "running"] as const;
const activeLeaseState = "active";

const parseWorkspaceRow = (row: WorkspaceRow): StoredWorkspace => {
  const config = row.config_json === null ? undefined : parseWithSchema(jsonObjectSchema, row.config_json);
  return {
    workspace_id: row.id,
    name: row.name,
    created_at: toIsoDateTime(row.created_at),
    updated_at: toIsoDateTime(row.updated_at),
    config,
  };
};

const parseApiKeyRow = (row: ApiKeyRow): StoredApiKey => ({
  api_key_id: row.id,
  workspace_id: row.workspace_id,
  name: row.name,
  key_hash: row.key_hash,
  scopes: parseWithSchema(stringArraySchema, row.scopes_json),
  created_at: toIsoDateTime(row.created_at),
  expires_at: row.expires_at === null ? null : toIsoDateTime(row.expires_at),
  revoked_at: row.revoked_at === null ? null : toIsoDateTime(row.revoked_at),
});

const parseNodeRow = (row: NodeRow): StoredNode => ({
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

const parseJobRow = (row: JobRow): StoredJobWithDiagnostics => {
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

const parseNetworkSessionRow = (row: NetworkSessionRow): StoredNetworkSession => ({
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

const parseJobEventRow = (row: JobEventRow): StoredJobEvent => ({
  event_id: row.id,
  workspace_id: row.workspace_id,
  job_id: row.job_id,
  network_session_id: row.network_session_id,
  event_type: row.event_type,
  sequence: row.sequence,
  payload_json: row.payload_json,
  created_at: toIsoDateTime(row.created_at),
});

const parseLeaseRow = (row: LeaseRow): StoredLease => ({
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

const parseAgentRow = (row: AgentRow): StoredAgent => ({
  agent_id: row.id,
  workspace_id: row.workspace_id,
  name: row.name,
  instructions: row.instructions,
  tool_policy: parseWithSchema(toolPolicySchema, row.tool_policy_json),
  node_requirements: parseWithSchema(nodeRequirementsSchema, row.node_requirements_json),
  created_at: toIsoDateTime(row.created_at),
  updated_at: toIsoDateTime(row.updated_at),
});

const parsePreviewRow = (row: PreviewRow): StoredPreview => ({
  preview: previewDescriptorSchema.parse(JSON.parse(row.descriptor_json) as unknown),
  revoked_at: row.revoked_at === null ? null : toIsoDateTime(row.revoked_at),
  created_at: toIsoDateTime(row.created_at),
  updated_at: toIsoDateTime(row.updated_at),
});

const parseNodeCredentialRow = (row: NodeCredentialRow): StoredNodeCredential => ({
  credential_id: row.id,
  node_id: row.node_id,
  workspace_id: row.workspace_id,
  token_hash: row.token_hash,
  token_ciphertext: row.token_ciphertext,
  issued_at: toIsoDateTime(row.issued_at),
  expires_at: toIsoDateTime(row.expires_at),
  rotated_at: row.rotated_at === null ? null : toIsoDateTime(row.rotated_at),
});

const parseIdempotencyRecordRow = (row: IdempotencyRecordRow): StoredIdempotencyRecord => ({
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

export class WorkspaceStore {
  public constructor(
    private readonly db: Database,
    public readonly workspaceId: string,
    private readonly jobEventRetentionPerJob: number,
  ) {}

  public saveAgent(agentInput: Parameters<typeof agentSchema.parse>[0], nowIso = new Date().toISOString()): StoredAgent {
    const agent = agentSchema.parse(agentInput);
    assertWorkspaceMatch("agent", this.workspaceId, agent.workspace_id);
    const nowMs = fromIsoDateTime(nowIso);

    this.db
      .prepare(
        "INSERT INTO agents (workspace_id, id, name, instructions, tool_policy_json, node_requirements_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, id) DO UPDATE SET name = excluded.name, instructions = excluded.instructions, tool_policy_json = excluded.tool_policy_json, node_requirements_json = excluded.node_requirements_json, updated_at = excluded.updated_at",
      )
      .run(
        this.workspaceId,
        agent.agent_id,
        agent.name,
        agent.instructions,
        serializeWithSchema(agentSchema.shape.tool_policy, agent.tool_policy),
        serializeWithSchema(agentSchema.shape.node_requirements, agent.node_requirements),
        nowMs,
        nowMs,
      );

    return this.getAgent(agent.agent_id);
  }

  public getAgent(agentId: string): StoredAgent {
    const row = this.db
      .query<AgentRow, [string, string]>(
        "SELECT * FROM agents WHERE workspace_id = ? AND id = ? LIMIT 1",
      )
      .get(this.workspaceId, agentId);

    if (row === null) {
      throw new Error(`Agent ${agentId} was not found in workspace ${this.workspaceId}`);
    }

    return parseAgentRow(row);
  }

  public listAgents(): StoredAgent[] {
    return this.db
      .query<AgentRow, [string]>("SELECT * FROM agents WHERE workspace_id = ? ORDER BY updated_at DESC")
      .all(this.workspaceId)
      .map(parseAgentRow);
  }

  public deleteAgent(agentId: string): void {
    const result = this.db
      .prepare("DELETE FROM agents WHERE workspace_id = ? AND id = ?")
      .run(this.workspaceId, agentId);

    if (result.changes === 0) {
      throw new Error(`Agent ${agentId} was not found in workspace ${this.workspaceId}`);
    }
  }

  public saveNode(nodeInput: SaveNodeInput): StoredNode {
    const manifest = nodeManifestSchema.parse(nodeInput.manifest);
    const createdAt = nodeInput.created_at ?? new Date().toISOString();

    this.db
      .prepare(
        "INSERT INTO nodes (workspace_id, id, manifest_json, pubkey_fingerprint, status, health_status, adapter_kind, approved_at, revoked_at, last_seen_at, last_error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, id) DO UPDATE SET manifest_json = excluded.manifest_json, pubkey_fingerprint = excluded.pubkey_fingerprint, status = excluded.status, health_status = excluded.health_status, adapter_kind = excluded.adapter_kind, approved_at = excluded.approved_at, revoked_at = excluded.revoked_at, last_seen_at = excluded.last_seen_at, last_error = excluded.last_error",
      )
      .run(
        this.workspaceId,
        manifest.node_id,
        JSON.stringify(manifest),
        nodeInput.pubkey_fingerprint,
        nodeInput.status ?? "pending",
        nodeInput.health_status ?? "unknown",
        manifest.adapter_kind,
        nodeInput.approved_at === undefined ? null : fromIsoDateTime(nodeInput.approved_at),
        nodeInput.revoked_at === undefined ? null : fromIsoDateTime(nodeInput.revoked_at),
        nodeInput.last_seen_at === undefined ? null : fromIsoDateTime(nodeInput.last_seen_at),
        nodeInput.last_error ?? null,
        fromIsoDateTime(createdAt),
      );

    return this.getNode(manifest.node_id);
  }

  public getNode(nodeId: string): StoredNode {
    const row = this.db
      .query<NodeRow, [string, string]>(
        "SELECT * FROM nodes WHERE workspace_id = ? AND id = ? LIMIT 1",
      )
      .get(this.workspaceId, nodeId);

    if (row === null) {
      throw new Error(`Node ${nodeId} was not found in workspace ${this.workspaceId}`);
    }

    return parseNodeRow(row);
  }

  public listNodes(): StoredNode[] {
    return this.db
      .query<NodeRow, [string]>("SELECT * FROM nodes WHERE workspace_id = ? ORDER BY created_at ASC")
      .all(this.workspaceId)
      .map(parseNodeRow);
  }

  public saveNodeCredential(input: {
    readonly credential_id: string;
    readonly node_id: string;
    readonly token_hash: string;
    readonly token_ciphertext?: string;
    readonly issued_at?: string;
    readonly expires_at: string;
    readonly rotated_at?: string;
  }): StoredNodeCredential {
    const issuedAt = input.issued_at ?? new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO node_credentials (workspace_id, id, node_id, token_hash, token_ciphertext, issued_at, expires_at, rotated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, id) DO UPDATE SET node_id = excluded.node_id, token_hash = excluded.token_hash, token_ciphertext = excluded.token_ciphertext, issued_at = excluded.issued_at, expires_at = excluded.expires_at, rotated_at = excluded.rotated_at",
      )
      .run(
        this.workspaceId,
        input.credential_id,
        input.node_id,
        input.token_hash,
        input.token_ciphertext ?? null,
        fromIsoDateTime(issuedAt),
        fromIsoDateTime(input.expires_at),
        input.rotated_at === undefined ? null : fromIsoDateTime(input.rotated_at),
      );

    return this.getNodeCredential(input.credential_id);
  }

  public getNodeCredential(credentialId: string): StoredNodeCredential {
    const row = this.db
      .query<NodeCredentialRow, [string, string]>(
        "SELECT * FROM node_credentials WHERE workspace_id = ? AND id = ? LIMIT 1",
      )
      .get(this.workspaceId, credentialId);

    if (row === null) {
      throw new Error(`Node credential ${credentialId} was not found in workspace ${this.workspaceId}`);
    }

    return parseNodeCredentialRow(row);
  }

  public listNodeCredentials(nodeId?: string): StoredNodeCredential[] {
    if (nodeId === undefined) {
      return this.db
        .query<NodeCredentialRow, [string]>(
          "SELECT * FROM node_credentials WHERE workspace_id = ? ORDER BY issued_at DESC",
        )
        .all(this.workspaceId)
        .map(parseNodeCredentialRow);
    }

    return this.db
      .query<NodeCredentialRow, [string, string]>(
        "SELECT * FROM node_credentials WHERE workspace_id = ? AND node_id = ? ORDER BY issued_at DESC",
      )
      .all(this.workspaceId, nodeId)
      .map(parseNodeCredentialRow);
  }

  public getActiveNodeCredential(nodeId: string, nowMs = Date.now()): StoredNodeCredential | null {
    const row = this.db
      .query<NodeCredentialRow, [string, string, number]>(
        "SELECT * FROM node_credentials WHERE workspace_id = ? AND node_id = ? AND rotated_at IS NULL AND expires_at > ? ORDER BY issued_at DESC LIMIT 1",
      )
      .get(this.workspaceId, nodeId, nowMs);

    return row === null ? null : parseNodeCredentialRow(row);
  }

  public saveJob(jobInput: SaveJobInput): StoredJobWithDiagnostics {
    const job = jobSchema.parse(jobInput.job);
    const taskPackage = taskPackageSchema.parse(jobInput.task_package);
    assertWorkspaceMatch("job", this.workspaceId, job.workspace_id);
    assertWorkspaceMatch("task package", this.workspaceId, taskPackage.workspace_id);
    if (taskPackage.job_id !== job.job_id) {
      throw new Error("task package job mismatch");
    }

    this.db
      .prepare(
        "INSERT INTO jobs (workspace_id, id, agent_id, node_id, lease_id, status, task_package_json, result_json, error_json, created_at, started_at, completed_at) VALUES (?, ?, ?, ?, (SELECT lease_id FROM jobs WHERE workspace_id = ? AND id = ?), ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, id) DO UPDATE SET agent_id = excluded.agent_id, node_id = excluded.node_id, lease_id = COALESCE(excluded.lease_id, jobs.lease_id), status = excluded.status, task_package_json = excluded.task_package_json, result_json = excluded.result_json, error_json = excluded.error_json, started_at = excluded.started_at, completed_at = excluded.completed_at",
      )
      .run(
        this.workspaceId,
        job.job_id,
        null,
        job.node_id ?? null,
        this.workspaceId,
        job.job_id,
        job.status,
        serializeWithSchema(taskPackageSchema, taskPackage),
        job.result === undefined ? null : serializeWithSchema(jobResultSchema, job.result),
        job.error === undefined ? null : serializeWithSchema(jobErrorSchema, job.error),
        fromIsoDateTime(job.created_at),
        job.started_at === undefined ? null : fromIsoDateTime(job.started_at),
        job.completed_at === undefined ? null : fromIsoDateTime(job.completed_at),
      );

    if (jobInput.network_session_id !== undefined) {
      this.db
        .prepare("UPDATE jobs SET network_session_id = ? WHERE workspace_id = ? AND id = ?")
        .run(jobInput.network_session_id, this.workspaceId, job.job_id);
    }

    return this.getJob(job.job_id);
  }

  public attachLease(jobId: string, leaseId: string, nodeId?: string): void {
    this.db
      .prepare("UPDATE jobs SET lease_id = ?, status = 'scheduled', node_id = COALESCE(?, node_id) WHERE workspace_id = ? AND id = ?")
      .run(leaseId, nodeId ?? null, this.workspaceId, jobId);
  }

  public getJob(jobId: string): StoredJobWithDiagnostics {
    const row = this.db
      .query<JobRow, [string, string]>("SELECT * FROM jobs WHERE workspace_id = ? AND id = ? LIMIT 1")
      .get(this.workspaceId, jobId);

    if (row === null) {
      throw new Error(`Job ${jobId} was not found in workspace ${this.workspaceId}`);
    }

    return parseJobRow(row);
  }

  public listJobs(): StoredJobWithDiagnostics[] {
    return this.db
      .query<JobRow, [string]>("SELECT * FROM jobs WHERE workspace_id = ? ORDER BY created_at DESC")
      .all(this.workspaceId)
      .map(parseJobRow);
  }

  public listJobsByFilter(status?: "running" | "terminal" | "all", networkSessionId?: string): StoredJobWithDiagnostics[] {
    const clauses = ["workspace_id = ?"];
    const params: string[] = [this.workspaceId];

    if (status === "running") {
      clauses.push("status IN ('pending', 'scheduled', 'running')");
    } else if (status === "terminal") {
      clauses.push("status IN ('completed', 'failed', 'aborted')");
    }

    if (networkSessionId !== undefined) {
      clauses.push("network_session_id = ?");
      params.push(networkSessionId);
    }

    return this.db
      .query<JobRow, string[]>(`SELECT * FROM jobs WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`)
      .all(...params)
      .map(parseJobRow);
  }

  public saveNetworkSession(input: SaveNetworkSessionInput): StoredNetworkSession {
    const createdAt = input.created_at ?? new Date().toISOString();
    const updatedAt = input.updated_at ?? createdAt;
    const lastActivityAt = input.last_activity_at ?? updatedAt;

    this.db
      .prepare(
        "INSERT INTO network_sessions (workspace_id, id, client_kind, client_session_id, intern_session_key, initiator_subject, status, created_at, updated_at, last_job_id, last_activity_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, id) DO UPDATE SET client_kind = excluded.client_kind, client_session_id = excluded.client_session_id, intern_session_key = excluded.intern_session_key, initiator_subject = excluded.initiator_subject, status = excluded.status, updated_at = excluded.updated_at, last_job_id = excluded.last_job_id, last_activity_at = excluded.last_activity_at, closed_at = excluded.closed_at",
      )
      .run(
        this.workspaceId,
        input.network_session_id,
        input.client_kind,
        input.client_session_id ?? null,
        input.intern_session_key,
        input.initiator_subject ?? null,
        input.status,
        fromIsoDateTime(createdAt),
        fromIsoDateTime(updatedAt),
        input.last_job_id ?? null,
        fromIsoDateTime(lastActivityAt),
        input.closed_at === undefined ? null : fromIsoDateTime(input.closed_at),
      );

    return this.getNetworkSession(input.network_session_id);
  }

  public getNetworkSession(networkSessionId: string): StoredNetworkSession {
    const row = this.db
      .query<NetworkSessionRow, [string, string]>(
        "SELECT * FROM network_sessions WHERE workspace_id = ? AND id = ? LIMIT 1",
      )
      .get(this.workspaceId, networkSessionId);

    if (row === null) {
      throw new Error(`Network session ${networkSessionId} was not found in workspace ${this.workspaceId}`);
    }

    return parseNetworkSessionRow(row);
  }

  public listNetworkSessions(): StoredNetworkSession[] {
    return this.db
      .query<NetworkSessionRow, [string]>(
        "SELECT * FROM network_sessions WHERE workspace_id = ? ORDER BY updated_at DESC",
      )
      .all(this.workspaceId)
      .map(parseNetworkSessionRow);
  }

  public findNetworkSessionByClient(clientKind: string, clientSessionId: string): StoredNetworkSession | null {
    const row = this.db
      .query<NetworkSessionRow, [string, string, string]>(
        "SELECT * FROM network_sessions WHERE workspace_id = ? AND client_kind = ? AND client_session_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(this.workspaceId, clientKind, clientSessionId);

    return row === null ? null : parseNetworkSessionRow(row);
  }

  public findNetworkSessionByInternSessionKey(internSessionKey: string): StoredNetworkSession | null {
    const row = this.db
      .query<NetworkSessionRow, [string, string]>(
        "SELECT * FROM network_sessions WHERE workspace_id = ? AND intern_session_key = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(this.workspaceId, internSessionKey);

    return row === null ? null : parseNetworkSessionRow(row);
  }

  public touchNetworkSession(networkSessionId: string, input: TouchNetworkSessionInput): StoredNetworkSession {
    const existing = this.getNetworkSession(networkSessionId);
    const lastActivityAt = input.last_activity_at ?? new Date().toISOString();

    this.db
      .prepare(
        "UPDATE network_sessions SET status = ?, updated_at = ?, last_job_id = ?, last_activity_at = ?, closed_at = ? WHERE workspace_id = ? AND id = ?",
      )
      .run(
        input.status ?? existing.status,
        fromIsoDateTime(lastActivityAt),
        input.last_job_id ?? existing.last_job_id,
        fromIsoDateTime(lastActivityAt),
        input.closed_at === undefined
          ? existing.closed_at === null
            ? null
            : fromIsoDateTime(existing.closed_at)
          : fromIsoDateTime(input.closed_at),
        this.workspaceId,
        networkSessionId,
      );

    return this.getNetworkSession(networkSessionId);
  }

  public appendJobEvent(input: AppendJobEventInput): StoredJobEvent {
    const createdAt = input.created_at ?? new Date().toISOString();
    const eventId = createEventId();
    const nextSequence =
      (this.db
        .query<{ sequence: number }, [string, string]>(
          "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM job_events WHERE workspace_id = ? AND job_id = ?",
        )
        .get(this.workspaceId, input.job_id)?.sequence ?? 0) + 1;

    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO job_events (workspace_id, id, job_id, network_session_id, event_type, sequence, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          this.workspaceId,
          eventId,
          input.job_id,
          input.network_session_id ?? null,
          input.event_type,
          nextSequence,
          sanitizePayloadJson(input.payload),
          fromIsoDateTime(createdAt),
        );

      this.db
        .prepare(
          "DELETE FROM job_events WHERE workspace_id = ? AND job_id = ? AND id NOT IN (SELECT id FROM job_events WHERE workspace_id = ? AND job_id = ? ORDER BY sequence DESC LIMIT ?)",
        )
        .run(this.workspaceId, input.job_id, this.workspaceId, input.job_id, this.jobEventRetentionPerJob);
    })();

    const row = this.db
      .query<JobEventRow, [string, string]>("SELECT * FROM job_events WHERE workspace_id = ? AND id = ? LIMIT 1")
      .get(this.workspaceId, eventId);

    if (row === null) {
      throw new Error(`Job event ${eventId} was not found in workspace ${this.workspaceId}`);
    }

    return parseJobEventRow(row);
  }

  public listJobEvents(input: ListJobEventsInput = {}): StoredJobEvent[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [this.workspaceId];

    if (input.job_id !== undefined) {
      clauses.push("job_id = ?");
      params.push(input.job_id);
    }
    if (input.network_session_id !== undefined) {
      clauses.push("network_session_id = ?");
      params.push(input.network_session_id);
    }

    params.push(input.limit ?? 100);

    return this.db
      .query<JobEventRow, (string | number)[]>(
        `SELECT * FROM (
          SELECT * FROM job_events WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, sequence DESC LIMIT ?
        ) ORDER BY created_at ASC, sequence ASC`,
      )
      .all(...params)
      .map(parseJobEventRow);
  }

  public saveLease(leaseInput: SaveLeaseInput): StoredLease {
    const lease = leaseSchema.parse(leaseInput.lease);
    assertWorkspaceMatch("lease input", this.workspaceId, leaseInput.workspace_id);
    const job = this.getJob(leaseInput.job_id);
    if (terminalJobStatuses.has(job.job.status)) {
      throw new Error("cannot attach lease to terminal job");
    }

    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO leases (workspace_id, id, node_id, job_id, profile_json, ttl_seconds, state, reset_required, created_at, expires_at, released_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, id) DO UPDATE SET node_id = excluded.node_id, job_id = excluded.job_id, profile_json = excluded.profile_json, ttl_seconds = excluded.ttl_seconds, state = excluded.state, reset_required = excluded.reset_required, expires_at = excluded.expires_at, released_at = excluded.released_at",
        )
        .run(
          this.workspaceId,
          lease.lease_id,
          lease.node_id,
          leaseInput.job_id,
          serializeWithSchema(leaseSchema.shape.profile, lease.profile),
          lease.ttl,
          lease.state,
          lease.reset_required ? 1 : 0,
          fromIsoDateTime(leaseInput.created_at ?? new Date().toISOString()),
          fromIsoDateTime(leaseInput.expires_at),
          leaseInput.released_at === undefined ? null : fromIsoDateTime(leaseInput.released_at),
        );

      this.attachLease(leaseInput.job_id, lease.lease_id, lease.node_id);
    })();

    return this.getLease(lease.lease_id);
  }

  public getLease(leaseId: string): StoredLease {
    const row = this.db
      .query<LeaseRow, [string, string]>("SELECT * FROM leases WHERE workspace_id = ? AND id = ? LIMIT 1")
      .get(this.workspaceId, leaseId);

    if (row === null) {
      throw new Error(`Lease ${leaseId} was not found in workspace ${this.workspaceId}`);
    }

    return parseLeaseRow(row);
  }

  public listLeases(): StoredLease[] {
    return this.db
      .query<LeaseRow, [string]>("SELECT * FROM leases WHERE workspace_id = ? ORDER BY created_at DESC")
      .all(this.workspaceId)
      .map(parseLeaseRow);
  }

  public releaseLease(leaseId: string, state: "released" | "expired" | "failed", releasedAt = new Date().toISOString()): StoredLease {
    const result = this.db
      .prepare("UPDATE leases SET state = ?, released_at = ? WHERE workspace_id = ? AND id = ?")
      .run(state, fromIsoDateTime(releasedAt), this.workspaceId, leaseId);

    if (result.changes === 0) {
      throw new Error(`Lease ${leaseId} was not found in workspace ${this.workspaceId}`);
    }

    return this.getLease(leaseId);
  }

  public savePreview(previewInput: SavePreviewInput): StoredPreview {
    const preview = previewDescriptorSchema.parse(previewInput.preview);
    assertWorkspaceMatch("preview", this.workspaceId, preview.workspace_id);
    const createdAt = previewInput.created_at ?? new Date().toISOString();
    const updatedAt = previewInput.updated_at ?? createdAt;

    this.db
      .prepare(
        "INSERT INTO previews (workspace_id, id, node_id, kind, delivery_mode, source_type, path, port, entry_path, service_id, descriptor_json, status, expires_at, revoked_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, id) DO UPDATE SET node_id = excluded.node_id, kind = excluded.kind, delivery_mode = excluded.delivery_mode, source_type = excluded.source_type, path = excluded.path, port = excluded.port, entry_path = excluded.entry_path, service_id = excluded.service_id, descriptor_json = excluded.descriptor_json, status = excluded.status, expires_at = excluded.expires_at, revoked_at = excluded.revoked_at, updated_at = excluded.updated_at",
      )
      .run(
        this.workspaceId,
        preview.preview_id,
        preview.node_id ?? null,
        preview.kind,
        preview.delivery_mode,
        preview.source_type,
        preview.path ?? null,
        preview.port ?? null,
        preview.entry_path ?? null,
        preview.service_id ?? null,
        JSON.stringify(preview),
        preview.status,
        preview.expires_at === undefined ? null : fromIsoDateTime(preview.expires_at),
        previewInput.revoked_at === undefined ? null : fromIsoDateTime(previewInput.revoked_at),
        fromIsoDateTime(createdAt),
        fromIsoDateTime(updatedAt),
      );

    return this.getPreview(preview.preview_id);
  }

  public getPreview(previewId: string): StoredPreview {
    const row = this.db
      .query<PreviewRow, [string, string]>(
        "SELECT * FROM previews WHERE workspace_id = ? AND id = ? LIMIT 1",
      )
      .get(this.workspaceId, previewId);

    if (row === null) {
      throw new Error(`Preview ${previewId} was not found in workspace ${this.workspaceId}`);
    }

    return parsePreviewRow(row);
  }

  public listPreviews(): StoredPreview[] {
    return this.db
      .query<PreviewRow, [string]>("SELECT * FROM previews WHERE workspace_id = ? ORDER BY updated_at DESC")
      .all(this.workspaceId)
      .map(parsePreviewRow);
  }
}

export class ControlPlaneDatabase {
  public readonly sqlite: Database;
  private readonly staleNodeThresholdMs: number;
  private readonly jobEventRetentionPerJob: number;

  public constructor(options: DatabaseOptions = {}) {
    this.sqlite = new Database(options.path ?? ":memory:");
    this.staleNodeThresholdMs = options.staleNodeThresholdMs ?? 60_000;
    this.jobEventRetentionPerJob = options.jobEventRetentionPerJob ?? 200;
    this.sqlite.run("PRAGMA journal_mode = WAL;");
    this.sqlite.run("PRAGMA foreign_keys = ON;");
  }

  public initialize(): void {
    this.sqlite.transaction(() => {
      this.sqlite.run(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
      );

      for (const migration of schemaMigrations) {
        const applied = this.sqlite
          .query<{ version: number }, [number]>(
            "SELECT version FROM schema_migrations WHERE version = ? LIMIT 1",
          )
          .get(migration.version);

        if (applied !== null) {
          continue;
        }

        for (const statement of migration.statements) {
          this.sqlite.run(statement);
        }

        this.sqlite
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, Date.now());
      }
    })();
  }

  public close(): void {
    this.sqlite.close();
  }

  public saveWorkspace(workspaceInput: Parameters<typeof workspaceSchema.parse>[0]): StoredWorkspace {
    const workspace = workspaceSchema.parse(workspaceInput);
    const createdAt = fromIsoDateTime(workspace.created_at);
    const updatedAt = fromIsoDateTime(workspace.updated_at ?? workspace.created_at);

    this.sqlite
      .prepare(
        "INSERT INTO workspaces (id, name, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, config_json = excluded.config_json, updated_at = excluded.updated_at",
      )
      .run(
        workspace.workspace_id,
        workspace.name,
        workspace.config === undefined ? null : JSON.stringify(workspace.config),
        createdAt,
        updatedAt,
      );

    return this.getWorkspace(workspace.workspace_id);
  }

  public getWorkspace(workspaceId: string): StoredWorkspace {
    const row = this.sqlite
      .query<WorkspaceRow, [string]>("SELECT * FROM workspaces WHERE id = ? LIMIT 1")
      .get(workspaceId);

    if (row === null) {
      throw new Error(`Workspace ${workspaceId} was not found`);
    }

    return parseWorkspaceRow(row);
  }

  public listWorkspaces(): StoredWorkspace[] {
    return this.sqlite.query<WorkspaceRow, []>("SELECT * FROM workspaces ORDER BY created_at ASC").all().map(parseWorkspaceRow);
  }

  public workspace(workspaceId: string): WorkspaceStore {
    return new WorkspaceStore(this.sqlite, workspaceId, this.jobEventRetentionPerJob);
  }

  public saveApiKey(input: {
    readonly api_key_id: string;
    readonly workspace_id: string;
    readonly name: string;
    readonly key_hash: string;
    readonly scopes: string[];
    readonly created_at?: string;
    readonly expires_at?: string;
    readonly revoked_at?: string;
  }): StoredApiKey {
    const createdAt = input.created_at ?? new Date().toISOString();

    this.sqlite
      .prepare(
        "INSERT INTO api_keys (workspace_id, id, key_hash, name, scopes_json, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, id) DO UPDATE SET key_hash = excluded.key_hash, name = excluded.name, scopes_json = excluded.scopes_json, expires_at = excluded.expires_at, revoked_at = excluded.revoked_at",
      )
      .run(
        input.workspace_id,
        input.api_key_id,
        input.key_hash,
        input.name,
        JSON.stringify(input.scopes),
        fromIsoDateTime(createdAt),
        input.expires_at === undefined ? null : fromIsoDateTime(input.expires_at),
        input.revoked_at === undefined ? null : fromIsoDateTime(input.revoked_at),
      );

    return this.getApiKey(input.workspace_id, input.api_key_id);
  }

  public getApiKey(workspaceId: string, apiKeyId: string): StoredApiKey {
    const row = this.sqlite
      .query<ApiKeyRow, [string, string]>(
        "SELECT * FROM api_keys WHERE workspace_id = ? AND id = ? LIMIT 1",
      )
      .get(workspaceId, apiKeyId);

    if (row === null) {
      throw new Error(`API key ${apiKeyId} was not found in workspace ${workspaceId}`);
    }

    return parseApiKeyRow(row);
  }

  public findActiveApiKeyByHash(keyHash: string, nowMs = Date.now()): StoredApiKey | null {
    const row = this.sqlite
      .query<ApiKeyRow, [string, number]>(
        "SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) LIMIT 1",
      )
      .get(keyHash, nowMs);

    return row === null ? null : parseApiKeyRow(row);
  }

  public listApiKeys(workspaceId: string): StoredApiKey[] {
    return this.sqlite
      .query<ApiKeyRow, [string]>("SELECT * FROM api_keys WHERE workspace_id = ? ORDER BY created_at DESC")
      .all(workspaceId)
      .map(parseApiKeyRow);
  }

  public revokeApiKey(workspaceId: string, apiKeyId: string, revokedAt = new Date().toISOString()): StoredApiKey {
    const result = this.sqlite
      .prepare("UPDATE api_keys SET revoked_at = ? WHERE workspace_id = ? AND id = ?")
      .run(fromIsoDateTime(revokedAt), workspaceId, apiKeyId);

    if (result.changes === 0) {
      throw new Error(`API key ${apiKeyId} was not found in workspace ${workspaceId}`);
    }

    return this.getApiKey(workspaceId, apiKeyId);
  }

  public getIdempotencyRecord(
    scope: string,
    ownerKey: string,
    idempotencyKey: string,
    nowMs = Date.now(),
  ): StoredIdempotencyRecord | null {
    const row = this.sqlite
      .query<IdempotencyRecordRow, [string, string, string, number]>(
        "SELECT * FROM idempotency_records WHERE scope = ? AND owner_key = ? AND idempotency_key = ? AND expires_at > ? LIMIT 1",
      )
      .get(scope, ownerKey, idempotencyKey, nowMs);

    return row === null ? null : parseIdempotencyRecordRow(row);
  }

  public saveIdempotencyRecord(input: SaveIdempotencyRecordInput): StoredIdempotencyRecord {
    const createdAt = input.created_at ?? new Date().toISOString();

    this.sqlite
      .prepare(
        "INSERT INTO idempotency_records (scope, owner_key, idempotency_key, request_body, response_json, status_code, resource_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(scope, owner_key, idempotency_key) DO UPDATE SET request_body = excluded.request_body, response_json = excluded.response_json, status_code = excluded.status_code, resource_id = excluded.resource_id, created_at = excluded.created_at, expires_at = excluded.expires_at",
      )
      .run(
        input.scope,
        input.owner_key,
        input.idempotency_key,
        input.request_body,
        input.response_json,
        input.status_code,
        input.resource_id ?? null,
        fromIsoDateTime(createdAt),
        fromIsoDateTime(input.expires_at),
      );

    const record = this.getIdempotencyRecord(input.scope, input.owner_key, input.idempotency_key, 0);
    if (record === null) {
      throw new Error("idempotency record was not persisted");
    }

    return record;
  }

  public pruneExpiredIdempotencyRecords(nowMs = Date.now()): number {
    return this.sqlite.prepare("DELETE FROM idempotency_records WHERE expires_at <= ?").run(nowMs).changes;
  }

  public reconcileStartupState(nowMs = Date.now()): StartupReconciliationSummary {
    const failableStates = runningJobStatuses.map(() => "?").join(", ");
    const failedJobs = this.sqlite
      .prepare(
        `UPDATE jobs SET status = 'failed', error_json = ?, completed_at = ? WHERE status IN (${failableStates})`,
      )
      .run(
        serializeWithSchema(jobErrorSchema, {
          code: "host_restart",
          message: "Job did not reach a terminal state before host restart",
          retriable: true,
          details: {},
        }),
        nowMs,
        ...runningJobStatuses,
      ).changes;

    const expiredLeases = this.sqlite
      .prepare("UPDATE leases SET state = 'expired', released_at = ? WHERE state = ? AND expires_at <= ?")
      .run(nowMs, activeLeaseState, nowMs).changes;

    const staleNodes = this.sqlite
      .prepare(
        "UPDATE nodes SET health_status = 'stale' WHERE status = 'approved' AND last_seen_at IS NOT NULL AND last_seen_at <= ?",
      )
      .run(nowMs - this.staleNodeThresholdMs).changes;

    return {
      failed_jobs: failedJobs,
      expired_leases: expiredLeases,
      stale_nodes: staleNodes,
    };
  }
}

export const createControlPlaneDatabase = (options?: DatabaseOptions): ControlPlaneDatabase => {
  const database = new ControlPlaneDatabase(options);
  database.initialize();
  return database;
};

const assertWorkspaceMatch = (label: string, expectedWorkspaceId: string, actualWorkspaceId: string): void => {
  if (expectedWorkspaceId !== actualWorkspaceId) {
    throw new Error(`${label} workspace mismatch`);
  }
};

const createEventId = (): string => `evt_${crypto.randomUUID().replace(/-/g, "")}`;

const sanitizePayloadJson = (payload: Record<string, unknown>): string => JSON.stringify(sanitizeValue(payload));

const sanitizeValue = (value: unknown): unknown => {
  if (typeof value === "string") {
    return value.length > 2048 ? `${value.slice(0, 2048)}…` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 25).map((entry) => sanitizeValue(entry));
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 50);
    return Object.fromEntries(entries.map(([key, entry]) => [key, sanitizeValue(entry)]));
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (typeof value === "bigint" || typeof value === "symbol") {
    return value.toString();
  }
  if (typeof value === "undefined") {
    return "undefined";
  }
  if (typeof value === "function") {
    return `[function ${value.name || "anonymous"}]`;
  }
  return null;
};