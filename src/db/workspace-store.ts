/**
 * @module src/db/workspace-store
 *
 * Purpose:
 * Workspace-scoped persistence facade for the OR3 Net control-plane database.
 *
 * Responsibilities:
 * - Enforce workspace isolation for stored entities and retained events
 * - Validate payloads against contracts before they reach SQLite
 * - Expose cohesive CRUD surfaces for jobs, nodes, leases, previews, and runtime sessions
 *
 * Non-responsibilities:
 * - Does not own connection lifecycle or migrations
 * - Does not expose cross-workspace queries; those stay on `ControlPlaneDatabase`
 *
 * Architecture:
 * - Constructed by `ControlPlaneDatabase.workspace(workspaceId)`
 * - Uses shared row codecs and retained-event helpers for consistency
 * - Relies on contract schemas to keep stored JSON aligned with API surfaces
 */
import type { Database } from "bun:sqlite";

import {
  agentSchema,
  jobErrorSchema,
  jobResultSchema,
  jobSchema,
  leaseSchema,
  nodeManifestSchema,
  previewDescriptorSchema,
  runtimeArtifactDescriptorSchema,
  runtimeCapabilitySetSchema,
  runtimeErrorEnvelopeSchema,
  runtimeSessionCreateInputSchema,
  runtimeWorkspaceStagingStatusSchema,
  taskPackageSchema,
  workspaceCommitResultSchema,
} from "../contracts/index.ts";
import { jsonObjectSchema, serializeWithSchema } from "../contracts/shared.ts";
import { fromIsoDateTime } from "../lib/time.ts";
import type {
  AgentRow,
  JobEventRow,
  JobRow,
  LeaseRow,
  NetworkSessionRow,
  NodeCredentialRow,
  NodeRow,
  PreviewRow,
  RuntimeArtifactRow,
  RuntimeSessionEventRow,
  RuntimeSessionRow,
  StoredAgent,
  StoredJobEvent,
  StoredJobWithDiagnostics,
  StoredLease,
  StoredNetworkSession,
  StoredNode,
  StoredNodeCredential,
  StoredPreview,
  StoredRuntimeArtifact,
  StoredRuntimeSession,
  StoredRuntimeSessionEvent,
} from "./schema.ts";
import {
  parseAgentRow,
  parseJobEventRow,
  parseJobRow,
  parseLeaseRow,
  parseNetworkSessionRow,
  parseNodeCredentialRow,
  parseNodeRow,
  parsePreviewRow,
  parseRuntimeArtifactRow,
  parseRuntimeSessionEventRow,
  parseRuntimeSessionRow,
  terminalJobStatuses,
} from "./codecs.ts";
import { appendRetainedEvent } from "./event-retention.ts";
import {
  assertWorkspaceMatch,
  type AppendJobEventInput,
  type AppendRuntimeSessionEventInput,
  type ListJobEventsInput,
  type ListRuntimeSessionsInput,
  type SaveJobInput,
  type SaveLeaseInput,
  type SaveNetworkSessionInput,
  type SaveNodeInput,
  type SavePreviewInput,
  type SaveRuntimeArtifactInput,
  type SaveRuntimeSessionInput,
  type TouchNetworkSessionInput,
  type TouchRuntimeSessionInput,
} from "./types.ts";

/**
 * Purpose:
 * Workspace-scoped database facade for the majority of control-plane entities.
 *
 * Behavior:
 * Validates incoming payloads, enforces workspace scoping, and applies bounded
 * retention for append-only event tables.
 *
 * Constraints:
 * - All returned records are scoped to `workspaceId`
 * - JSON columns are validated on write and parsed on read through contract schemas
 * - Event retention is count-based and enforced after each append
 *
 * Non-Goals:
 * - Does not perform authorization checks
 * - Does not coordinate cross-workspace reconciliation or global records
 */
export class WorkspaceStore {
  /**
   * Purpose:
   * Creates a workspace-bound persistence facade over a shared SQLite handle.
   *
   * Behavior:
   * The handle is shared with the parent control-plane database, but every
   * method in this class scopes reads and writes to `workspaceId`.
   */
  public constructor(
    private readonly db: Database,
    public readonly workspaceId: string,
    private readonly jobEventRetentionPerJob: number,
    private readonly runtimeSessionEventRetentionPerSession: number,
  ) {}

  /** Purpose: Persists or updates an agent within the workspace. */
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

  /** Purpose: Fetches a single stored agent. */
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

  /** Purpose: Lists stored agents for the workspace. */
  public listAgents(): StoredAgent[] {
    return this.db
      .query<AgentRow, [string]>("SELECT * FROM agents WHERE workspace_id = ? ORDER BY updated_at DESC")
      .all(this.workspaceId)
      .map(parseAgentRow);
  }

  /** Purpose: Deletes an agent from the workspace. */
  public deleteAgent(agentId: string): void {
    const result = this.db
      .prepare("DELETE FROM agents WHERE workspace_id = ? AND id = ?")
      .run(this.workspaceId, agentId);

    if (result.changes === 0) {
      throw new Error(`Agent ${agentId} was not found in workspace ${this.workspaceId}`);
    }
  }

  /** Purpose: Persists or updates an enrolled node. */
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

  /** Purpose: Fetches a single stored node. */
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

  /** Purpose: Lists enrolled nodes for the workspace. */
  public listNodes(): StoredNode[] {
    return this.db
      .query<NodeRow, [string]>("SELECT * FROM nodes WHERE workspace_id = ? ORDER BY created_at ASC")
      .all(this.workspaceId)
      .map(parseNodeRow);
  }

  /** Purpose: Persists or updates a node credential. */
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

  /** Purpose: Fetches a single node credential. */
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

  /** Purpose: Lists node credentials, optionally filtered to a single node. */
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

  /** Purpose: Lists unrotated, unexpired node credentials. */
  public listActiveNodeCredentials(nowMs = Date.now()): StoredNodeCredential[] {
    return this.db
      .query<NodeCredentialRow, [string, number]>(
        "SELECT * FROM node_credentials WHERE workspace_id = ? AND rotated_at IS NULL AND expires_at > ? ORDER BY issued_at DESC",
      )
      .all(this.workspaceId, nowMs)
      .map(parseNodeCredentialRow);
  }

  /** Purpose: Returns the latest active credential for a node, if any. */
  public getActiveNodeCredential(nodeId: string, nowMs = Date.now()): StoredNodeCredential | null {
    const row = this.db
      .query<NodeCredentialRow, [string, string, number]>(
        "SELECT * FROM node_credentials WHERE workspace_id = ? AND node_id = ? AND rotated_at IS NULL AND expires_at > ? ORDER BY issued_at DESC LIMIT 1",
      )
      .get(this.workspaceId, nodeId, nowMs);

    return row === null ? null : parseNodeCredentialRow(row);
  }

  /** Purpose: Persists or updates a job record and its task package. */
  public saveJob(jobInput: SaveJobInput): StoredJobWithDiagnostics {
    const job = jobSchema.parse(jobInput.job);
    const taskPackage = taskPackageSchema.parse(jobInput.task_package);
    assertWorkspaceMatch("job", this.workspaceId, job.workspace_id);
    assertWorkspaceMatch("task package", this.workspaceId, taskPackage.workspace_id);
    if (taskPackage.job_id !== job.job_id) {
      throw new Error("task package job mismatch");
    }

    this.db.transaction(() => {
      if (jobInput.network_session_id !== undefined) {
        this.getNetworkSession(jobInput.network_session_id);
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
    })();

    return this.getJob(job.job_id);
  }

  /** Purpose: Attaches a lease and optional node assignment to an existing job. */
  public attachLease(jobId: string, leaseId: string, nodeId?: string): void {
    this.db
      .prepare("UPDATE jobs SET lease_id = ?, status = 'scheduled', node_id = COALESCE(?, node_id) WHERE workspace_id = ? AND id = ?")
      .run(leaseId, nodeId ?? null, this.workspaceId, jobId);
  }

  /** Purpose: Fetches a single stored job. */
  public getJob(jobId: string): StoredJobWithDiagnostics {
    const row = this.db
      .query<JobRow, [string, string]>("SELECT * FROM jobs WHERE workspace_id = ? AND id = ? LIMIT 1")
      .get(this.workspaceId, jobId);

    if (row === null) {
      throw new Error(`Job ${jobId} was not found in workspace ${this.workspaceId}`);
    }

    return parseJobRow(row);
  }

  /** Purpose: Lists all jobs for the workspace. */
  public listJobs(): StoredJobWithDiagnostics[] {
    return this.db
      .query<JobRow, [string]>("SELECT * FROM jobs WHERE workspace_id = ? ORDER BY created_at DESC")
      .all(this.workspaceId)
      .map(parseJobRow);
  }

  /** Purpose: Lists jobs by status bucket and optional network-session binding. */
  public listJobsByFilter(status?: "running" | "terminal" | "all", networkSessionId?: string, limit = 100): StoredJobWithDiagnostics[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [this.workspaceId];

    if (status === "running") {
      clauses.push("status IN ('pending', 'scheduled', 'running')");
    } else if (status === "terminal") {
      clauses.push("status IN ('completed', 'failed', 'aborted')");
    }

    if (networkSessionId !== undefined) {
      clauses.push("network_session_id = ?");
      params.push(networkSessionId);
    }

    params.push(limit);

    return this.db
      .query<JobRow, (string | number)[]>(`SELECT * FROM jobs WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
      .all(...params)
      .map(parseJobRow);
  }

  /** Purpose: Persists or updates a network session binding. */
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

  /** Purpose: Fetches a single network session binding. */
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

  /** Purpose: Lists network session bindings for the workspace. */
  public listNetworkSessions(input: { limit?: number } = {}): StoredNetworkSession[] {
    return this.db
      .query<NetworkSessionRow, [string, number]>(
        "SELECT * FROM network_sessions WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT ?",
      )
      .all(this.workspaceId, input.limit ?? 100)
      .map(parseNetworkSessionRow);
  }

  /** Purpose: Finds the latest binding for a client-kind and client-session pair. */
  public findNetworkSessionByClient(clientKind: string, clientSessionId: string): StoredNetworkSession | null {
    const row = this.db
      .query<NetworkSessionRow, [string, string, string]>(
        "SELECT * FROM network_sessions WHERE workspace_id = ? AND client_kind = ? AND client_session_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(this.workspaceId, clientKind, clientSessionId);

    return row === null ? null : parseNetworkSessionRow(row);
  }

  /** Purpose: Finds the latest binding for an intern session key. */
  public findNetworkSessionByInternSessionKey(internSessionKey: string): StoredNetworkSession | null {
    const row = this.db
      .query<NetworkSessionRow, [string, string]>(
        "SELECT * FROM network_sessions WHERE workspace_id = ? AND intern_session_key = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(this.workspaceId, internSessionKey);

    return row === null ? null : parseNetworkSessionRow(row);
  }

  /** Purpose: Updates an existing network session binding. */
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

  /** Purpose: Appends a retained job event and trims old events for that job. */
  public appendJobEvent(input: AppendJobEventInput): StoredJobEvent {
    const row = appendRetainedEvent({
      db: this.db,
      workspaceId: this.workspaceId,
      keyValue: input.job_id,
      retention: this.jobEventRetentionPerJob,
      createdAt: input.created_at,
      payload: input.payload,
      selectLatestSequenceSql: "SELECT sequence FROM job_events WHERE workspace_id = ? AND job_id = ? ORDER BY sequence DESC LIMIT 1",
      insertSql:
        "INSERT INTO job_events (workspace_id, id, job_id, network_session_id, event_type, sequence, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      insertParams: (eventId, nextSequence, payloadJson, createdAtMs) => [
        this.workspaceId,
        eventId,
        input.job_id,
        input.network_session_id ?? null,
        input.event_type,
        nextSequence,
        payloadJson,
        createdAtMs,
      ],
      trimSql: "DELETE FROM job_events WHERE workspace_id = ? AND job_id = ? AND sequence <= ?",
      trimParams: (cutoffSequence) => [this.workspaceId, input.job_id, cutoffSequence],
      selectByIdSql: "SELECT * FROM job_events WHERE workspace_id = ? AND id = ? LIMIT 1",
      parseErrorLabel: "Job event",
    });

    return parseJobEventRow(row as JobEventRow);
  }

  /** Purpose: Lists retained job events with optional job or session filters. */
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

  /** Purpose: Persists or updates a runtime session record. */
  public saveRuntimeSession(input: SaveRuntimeSessionInput): StoredRuntimeSession {
    const capabilities = runtimeCapabilitySetSchema.parse([...input.capabilities]);
    const config = input.config === undefined ? null : runtimeSessionCreateInputSchema.parse(input.config);
    const error = input.error === undefined ? null : runtimeErrorEnvelopeSchema.parse(input.error);
    const stagingStatus = runtimeWorkspaceStagingStatusSchema.parse(input.staging_status ?? (config?.workspace_stage === undefined ? "none" : "preparing"));
    const lastCommit = input.last_commit === undefined ? null : workspaceCommitResultSchema.parse(input.last_commit);
    const createdAt = input.created_at ?? new Date().toISOString();
    const updatedAt = input.updated_at ?? createdAt;

    this.db
      .prepare(
        "INSERT INTO runtime_sessions (workspace_id, id, adapter_id, adapter_session_ref, node_id, preset_id, status, capabilities_json, config_json, host_workspace_root, workspace_stage_mode, workspace_stage_transport, staging_status, last_commit_json, isolation_class, trust_tier, error_json, created_at, updated_at, destroyed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, id) DO UPDATE SET adapter_id = excluded.adapter_id, adapter_session_ref = excluded.adapter_session_ref, node_id = excluded.node_id, preset_id = excluded.preset_id, status = excluded.status, capabilities_json = excluded.capabilities_json, config_json = excluded.config_json, host_workspace_root = excluded.host_workspace_root, workspace_stage_mode = excluded.workspace_stage_mode, workspace_stage_transport = excluded.workspace_stage_transport, staging_status = excluded.staging_status, last_commit_json = excluded.last_commit_json, isolation_class = excluded.isolation_class, trust_tier = excluded.trust_tier, error_json = excluded.error_json, updated_at = excluded.updated_at, destroyed_at = excluded.destroyed_at",
      )
      .run(
        this.workspaceId,
        input.session_id,
        input.adapter_id,
        input.adapter_session_ref ?? null,
        input.node_id ?? null,
        input.preset_id ?? null,
        input.status,
        serializeWithSchema(runtimeCapabilitySetSchema, capabilities),
        config === null ? null : serializeWithSchema(runtimeSessionCreateInputSchema, config),
        input.host_workspace_root ?? null,
        input.workspace_stage_mode ?? null,
        config?.workspace_stage?.transport ?? null,
        stagingStatus,
        lastCommit === null ? null : serializeWithSchema(workspaceCommitResultSchema, lastCommit),
        input.isolation_class,
        input.trust_tier,
        error === null ? null : serializeWithSchema(runtimeErrorEnvelopeSchema, error),
        fromIsoDateTime(createdAt),
        fromIsoDateTime(updatedAt),
        input.destroyed_at === undefined ? null : fromIsoDateTime(input.destroyed_at),
      );

    return this.getRuntimeSession(input.session_id);
  }

  /** Purpose: Fetches a single runtime session record. */
  public getRuntimeSession(sessionId: string): StoredRuntimeSession {
    const row = this.db
      .query<RuntimeSessionRow, [string, string]>(
        "SELECT * FROM runtime_sessions WHERE workspace_id = ? AND id = ? LIMIT 1",
      )
      .get(this.workspaceId, sessionId);

    if (row === null) {
      throw new Error(`Runtime session ${sessionId} was not found in workspace ${this.workspaceId}`);
    }

    return parseRuntimeSessionRow(row);
  }

  /** Purpose: Lists runtime sessions for the workspace. */
  public listRuntimeSessions(input: ListRuntimeSessionsInput = {}): StoredRuntimeSession[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [this.workspaceId];

    if (input.status !== undefined) {
      clauses.push("status = ?");
      params.push(input.status);
    }

    if (input.adapter_id !== undefined) {
      clauses.push("adapter_id = ?");
      params.push(input.adapter_id);
    }

    params.push(input.limit ?? 100);

    return this.db
      .query<RuntimeSessionRow, (string | number)[]>(
        `SELECT * FROM runtime_sessions WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...params)
      .map(parseRuntimeSessionRow);
  }

  /** Purpose: Finds another active read-write stage writer for a host workspace root. */
  public findActiveRuntimeStageWriter(hostWorkspaceRoot: string, excludeSessionId?: string): StoredRuntimeSession | null {
    const clauses = [
      "workspace_id = ?",
      "host_workspace_root = ?",
      "workspace_stage_mode = 'read_write'",
      "staging_status IN ('preparing', 'ready', 'committing')",
      "status IN ('creating', 'ready', 'stopping', 'stopped')",
    ];
    const params: string[] = [this.workspaceId, hostWorkspaceRoot];

    if (excludeSessionId !== undefined) {
      clauses.push("id != ?");
      params.push(excludeSessionId);
    }

    const row = this.db
      .query<RuntimeSessionRow, string[]>(
        `SELECT * FROM runtime_sessions WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(...params);

    return row === null ? null : parseRuntimeSessionRow(row);
  }

  /** Purpose: Applies a partial update to an existing runtime session. */
  public touchRuntimeSession(sessionId: string, input: TouchRuntimeSessionInput): StoredRuntimeSession {
    const existing = this.getRuntimeSession(sessionId);
    const updatedAt = input.updated_at ?? new Date().toISOString();
    const capabilities =
      input.capabilities === undefined
        ? existing.session.capabilities
        : runtimeCapabilitySetSchema.parse([...input.capabilities]);
    const config =
      input.config === undefined
        ? existing.config
        : input.config === null
          ? null
          : runtimeSessionCreateInputSchema.parse(input.config);
    const error =
      input.error === undefined
        ? existing.session.error ?? null
        : input.error === null
          ? null
          : runtimeErrorEnvelopeSchema.parse(input.error);
    const stagingStatus =
      input.staging_status === undefined
        ? existing.session.staging_status
        : runtimeWorkspaceStagingStatusSchema.parse(input.staging_status);
    const lastCommit =
      input.last_commit === undefined
        ? existing.session.last_commit ?? null
        : input.last_commit === null
          ? null
          : workspaceCommitResultSchema.parse(input.last_commit);

    this.db
      .prepare(
        "UPDATE runtime_sessions SET adapter_id = ?, adapter_session_ref = ?, node_id = ?, preset_id = ?, status = ?, capabilities_json = ?, config_json = ?, host_workspace_root = ?, workspace_stage_mode = ?, workspace_stage_transport = ?, staging_status = ?, last_commit_json = ?, isolation_class = ?, trust_tier = ?, error_json = ?, updated_at = ?, destroyed_at = ? WHERE workspace_id = ? AND id = ?",
      )
      .run(
        input.adapter_id ?? existing.session.adapter_id,
        input.adapter_session_ref === undefined ? existing.adapter_session_ref : input.adapter_session_ref,
        input.node_id === undefined ? (existing.session.node_id ?? null) : input.node_id,
        input.preset_id === undefined ? (existing.session.preset_id ?? null) : input.preset_id,
        input.status ?? existing.session.status,
        serializeWithSchema(runtimeCapabilitySetSchema, capabilities),
        config === null ? null : serializeWithSchema(runtimeSessionCreateInputSchema, config),
        input.host_workspace_root === undefined ? (existing.session.host_workspace_root ?? null) : input.host_workspace_root,
        input.workspace_stage_mode === undefined ? (existing.session.workspace_stage_mode ?? null) : input.workspace_stage_mode,
        input.workspace_stage_transport === undefined ? (existing.session.workspace_stage_transport ?? null) : input.workspace_stage_transport,
        stagingStatus,
        lastCommit === null ? null : serializeWithSchema(workspaceCommitResultSchema, lastCommit),
        input.isolation_class ?? existing.session.isolation_class,
        input.trust_tier ?? existing.session.trust_tier,
        error === null ? null : serializeWithSchema(runtimeErrorEnvelopeSchema, error),
        fromIsoDateTime(updatedAt),
        input.destroyed_at === undefined
          ? existing.session.destroyed_at === undefined
            ? null
            : fromIsoDateTime(existing.session.destroyed_at)
          : input.destroyed_at === null
            ? null
            : fromIsoDateTime(input.destroyed_at),
        this.workspaceId,
        sessionId,
      );

    return this.getRuntimeSession(sessionId);
  }

  /** Purpose: Appends a retained runtime session event and trims old events. */
  public appendRuntimeSessionEvent(input: AppendRuntimeSessionEventInput): StoredRuntimeSessionEvent {
    const row = appendRetainedEvent({
      db: this.db,
      workspaceId: this.workspaceId,
      keyValue: input.session_id,
      retention: this.runtimeSessionEventRetentionPerSession,
      createdAt: input.created_at,
      payload: input.payload,
      selectLatestSequenceSql:
        "SELECT sequence FROM runtime_session_events WHERE workspace_id = ? AND session_id = ? ORDER BY sequence DESC LIMIT 1",
      insertSql:
        "INSERT INTO runtime_session_events (workspace_id, id, session_id, event_type, sequence, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      insertParams: (eventId, nextSequence, payloadJson, createdAtMs) => [
        this.workspaceId,
        eventId,
        input.session_id,
        input.event_type,
        nextSequence,
        payloadJson,
        createdAtMs,
      ],
      trimSql: "DELETE FROM runtime_session_events WHERE workspace_id = ? AND session_id = ? AND sequence <= ?",
      trimParams: (cutoffSequence) => [this.workspaceId, input.session_id, cutoffSequence],
      selectByIdSql: "SELECT * FROM runtime_session_events WHERE workspace_id = ? AND id = ? LIMIT 1",
      parseErrorLabel: "Runtime session event",
    });
    return parseRuntimeSessionEventRow(row as RuntimeSessionEventRow);
  }

  /** Purpose: Lists retained runtime session events for a session. */
  public listRuntimeSessionEvents(sessionId: string, limit = 100): StoredRuntimeSessionEvent[] {
    return this.db
      .query<RuntimeSessionEventRow, [string, string, number]>(
        `SELECT * FROM (
          SELECT * FROM runtime_session_events WHERE workspace_id = ? AND session_id = ? ORDER BY created_at DESC, sequence DESC LIMIT ?
        ) ORDER BY created_at ASC, sequence ASC`,
      )
      .all(this.workspaceId, sessionId, limit)
      .map(parseRuntimeSessionEventRow);
  }

  /** Purpose: Persists a runtime artifact record. */
  public saveRuntimeArtifact(input: SaveRuntimeArtifactInput): StoredRuntimeArtifact {
    const artifact = runtimeArtifactDescriptorSchema.parse(input.artifact);
    const createdAt = input.created_at ?? new Date().toISOString();

    this.db
      .prepare(
        "INSERT INTO runtime_artifacts (workspace_id, id, session_id, path, kind, content_type, size_bytes, source_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, id) DO UPDATE SET session_id = excluded.session_id, path = excluded.path, kind = excluded.kind, content_type = excluded.content_type, size_bytes = excluded.size_bytes, source_json = excluded.source_json",
      )
      .run(
        this.workspaceId,
        artifact.artifact_id,
        artifact.session_id,
        artifact.path,
        artifact.kind,
        artifact.content_type,
        artifact.size_bytes,
        serializeWithSchema(jsonObjectSchema, artifact.source),
        fromIsoDateTime(createdAt),
      );

    const row = this.db
      .query<RuntimeArtifactRow, [string, string]>(
        "SELECT * FROM runtime_artifacts WHERE workspace_id = ? AND id = ? LIMIT 1",
      )
      .get(this.workspaceId, artifact.artifact_id);

    if (row === null) {
      throw new Error(`Runtime artifact ${artifact.artifact_id} was not found in workspace ${this.workspaceId}`);
    }

    return parseRuntimeArtifactRow(row);
  }

  /** Purpose: Lists runtime artifacts produced by a session. */
  public listRuntimeArtifacts(sessionId: string): StoredRuntimeArtifact[] {
    return this.db
      .query<RuntimeArtifactRow, [string, string]>(
        "SELECT * FROM runtime_artifacts WHERE workspace_id = ? AND session_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(this.workspaceId, sessionId)
      .map(parseRuntimeArtifactRow);
  }

  /** Purpose: Persists a lease and attaches it to the target job transactionally. */
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

  /** Purpose: Fetches a single lease record. */
  public getLease(leaseId: string): StoredLease {
    const row = this.db
      .query<LeaseRow, [string, string]>("SELECT * FROM leases WHERE workspace_id = ? AND id = ? LIMIT 1")
      .get(this.workspaceId, leaseId);

    if (row === null) {
      throw new Error(`Lease ${leaseId} was not found in workspace ${this.workspaceId}`);
    }

    return parseLeaseRow(row);
  }

  /** Purpose: Lists lease records for the workspace. */
  public listLeases(): StoredLease[] {
    return this.db
      .query<LeaseRow, [string]>("SELECT * FROM leases WHERE workspace_id = ? ORDER BY created_at DESC")
      .all(this.workspaceId)
      .map(parseLeaseRow);
  }

  /** Purpose: Marks expired active leases as expired. */
  public expireActiveLeases(nowMs = Date.now(), releasedAt = new Date(nowMs).toISOString()): number {
    return this.db
      .prepare("UPDATE leases SET state = 'expired', released_at = ? WHERE workspace_id = ? AND state = 'active' AND expires_at <= ?")
      .run(fromIsoDateTime(releasedAt), this.workspaceId, nowMs).changes;
  }

  /** Purpose: Releases a lease with a terminal non-active state. */
  public releaseLease(leaseId: string, state: "released" | "expired" | "failed", releasedAt = new Date().toISOString()): StoredLease {
    const result = this.db
      .prepare("UPDATE leases SET state = ?, released_at = ? WHERE workspace_id = ? AND id = ?")
      .run(state, fromIsoDateTime(releasedAt), this.workspaceId, leaseId);

    if (result.changes === 0) {
      throw new Error(`Lease ${leaseId} was not found in workspace ${this.workspaceId}`);
    }

    return this.getLease(leaseId);
  }

  /** Purpose: Persists or updates a preview descriptor. */
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

  /** Purpose: Fetches a single preview record. */
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

  /** Purpose: Lists preview records for the workspace. */
  public listPreviews(): StoredPreview[] {
    return this.db
      .query<PreviewRow, [string]>("SELECT * FROM previews WHERE workspace_id = ? ORDER BY updated_at DESC")
      .all(this.workspaceId)
      .map(parsePreviewRow);
  }
}
