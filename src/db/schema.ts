import type {
  Agent,
  Job,
  JobError,
  JobResult,
  Lease,
  NodeManifest,
  PreviewDescriptor,
  TaskPackage,
  Workspace,
} from "../contracts/index.ts";
import type { JsonValue } from "../contracts/shared.ts";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
}

export interface WorkspaceRow {
  readonly id: string;
  readonly name: string;
  readonly config_json: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface ApiKeyRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly key_hash: string;
  readonly name: string;
  readonly scopes_json: string;
  readonly created_at: number;
  readonly expires_at: number | null;
  readonly revoked_at: number | null;
}

export interface NodeRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly manifest_json: string;
  readonly pubkey_fingerprint: string;
  readonly status: string;
  readonly health_status: string;
  readonly adapter_kind: string;
  readonly approved_at: number | null;
  readonly revoked_at: number | null;
  readonly last_seen_at: number | null;
  readonly last_error: string | null;
  readonly created_at: number;
}

export interface NodeCredentialRow {
  readonly id: string;
  readonly node_id: string;
  readonly workspace_id: string;
  readonly token_hash: string;
  readonly token_ciphertext: string | null;
  readonly issued_at: number;
  readonly expires_at: number;
  readonly rotated_at: number | null;
}

export interface JobRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly network_session_id: string | null;
  readonly agent_id: string | null;
  readonly node_id: string | null;
  readonly lease_id: string | null;
  readonly status: string;
  readonly task_package_json: string;
  readonly result_json: string | null;
  readonly error_json: string | null;
  readonly created_at: number;
  readonly started_at: number | null;
  readonly completed_at: number | null;
}

export interface LeaseRow {
  readonly id: string;
  readonly node_id: string;
  readonly job_id: string;
  readonly workspace_id: string;
  readonly profile_json: string;
  readonly ttl_seconds: number;
  readonly state: string;
  readonly reset_required: number;
  readonly created_at: number;
  readonly expires_at: number;
  readonly released_at: number | null;
}

export interface AgentRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly name: string;
  readonly instructions: string;
  readonly tool_policy_json: string;
  readonly node_requirements_json: string;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface NetworkSessionRow {
  readonly workspace_id: string;
  readonly id: string;
  readonly client_kind: string;
  readonly client_session_id: string | null;
  readonly intern_session_key: string;
  readonly initiator_subject: string | null;
  readonly status: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly last_job_id: string | null;
  readonly last_activity_at: number;
  readonly closed_at: number | null;
}

export interface JobEventRow {
  readonly workspace_id: string;
  readonly id: string;
  readonly job_id: string;
  readonly network_session_id: string | null;
  readonly event_type: string;
  readonly sequence: number;
  readonly payload_json: string;
  readonly created_at: number;
}

export interface PreviewRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly node_id: string | null;
  readonly kind: string;
  readonly delivery_mode: string;
  readonly source_type: string;
  readonly path: string | null;
  readonly port: number | null;
  readonly entry_path: string | null;
  readonly service_id: string | null;
  readonly descriptor_json: string;
  readonly status: string;
  readonly expires_at: number | null;
  readonly revoked_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface IdempotencyRecordRow {
  readonly scope: string;
  readonly owner_key: string;
  readonly idempotency_key: string;
  readonly request_body: string;
  readonly response_json: string;
  readonly status_code: number;
  readonly resource_id: string | null;
  readonly created_at: number;
  readonly expires_at: number;
}

export interface StoredNode {
  readonly workspace_id: string;
  readonly manifest: NodeManifest;
  readonly pubkey_fingerprint: string;
  readonly status: string;
  readonly health_status: string;
  readonly approved_at: string | null;
  readonly revoked_at: string | null;
  readonly last_seen_at: string | null;
  readonly last_error: string | null;
  readonly created_at: string;
}

export interface StoredJob {
  readonly job: Job;
  readonly task_package: TaskPackage;
}

export interface StoredJobWithDiagnostics extends StoredJob {
  readonly network_session_id: string | null;
  readonly error: JobError | null;
  readonly result: JobResult | null;
}

export interface StoredLease {
  readonly workspace_id: string;
  readonly job_id: string;
  readonly lease: Lease;
  readonly expires_at: string;
  readonly created_at: string;
  readonly released_at: string | null;
}

export interface StoredAgent extends Agent {
  readonly created_at: string;
  readonly updated_at: string;
}

export interface StoredWorkspace extends Workspace {
  readonly config: Record<string, JsonValue> | undefined;
  readonly updated_at: string;
}

export interface StoredApiKey {
  readonly api_key_id: string;
  readonly workspace_id: string;
  readonly name: string;
  readonly key_hash: string;
  readonly scopes: string[];
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly revoked_at: string | null;
}

export interface StoredPreview {
  readonly preview: PreviewDescriptor;
  readonly revoked_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface StoredNodeCredential {
  readonly credential_id: string;
  readonly node_id: string;
  readonly workspace_id: string;
  readonly token_hash: string;
  readonly token_ciphertext: string | null;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly rotated_at: string | null;
}

export interface StoredNetworkSession {
  readonly network_session_id: string;
  readonly workspace_id: string;
  readonly client_kind: string;
  readonly client_session_id: string | null;
  readonly intern_session_key: string;
  readonly initiator_subject: string | null;
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly last_job_id: string | null;
  readonly last_activity_at: string;
  readonly closed_at: string | null;
}

export interface StoredJobEvent {
  readonly event_id: string;
  readonly workspace_id: string;
  readonly job_id: string;
  readonly network_session_id: string | null;
  readonly event_type: string;
  readonly sequence: number;
  readonly payload_json: string;
  readonly created_at: string;
}

export interface StoredIdempotencyRecord {
  readonly scope: string;
  readonly owner_key: string;
  readonly idempotency_key: string;
  readonly request_body: string;
  readonly response_json: string;
  readonly status_code: number;
  readonly resource_id: string | null;
  readonly created_at: string;
  readonly expires_at: string;
}

export const schemaMigrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial-control-plane",
    statements: [
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, config_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, key_hash TEXT NOT NULL, name TEXT NOT NULL, scopes_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER)",
      "CREATE INDEX IF NOT EXISTS idx_api_keys_workspace_id ON api_keys(workspace_id)",
      "CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, manifest_json TEXT NOT NULL, pubkey_fingerprint TEXT NOT NULL, status TEXT NOT NULL, health_status TEXT NOT NULL DEFAULT 'unknown', adapter_kind TEXT NOT NULL, approved_at INTEGER, revoked_at INTEGER, last_seen_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL)",
      "CREATE INDEX IF NOT EXISTS idx_nodes_workspace_id ON nodes(workspace_id)",
      "CREATE TABLE IF NOT EXISTS node_credentials (id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, token_hash TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, rotated_at INTEGER)",
      "CREATE INDEX IF NOT EXISTS idx_node_credentials_workspace_id ON node_credentials(workspace_id)",
      "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, agent_id TEXT, node_id TEXT REFERENCES nodes(id), lease_id TEXT, status TEXT NOT NULL, task_package_json TEXT NOT NULL, result_json TEXT, error_json TEXT, created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER)",
      "CREATE INDEX IF NOT EXISTS idx_jobs_workspace_status ON jobs(workspace_id, status)",
      "CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, profile_json TEXT NOT NULL, ttl_seconds INTEGER NOT NULL, state TEXT NOT NULL, reset_required INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, released_at INTEGER)",
      "CREATE INDEX IF NOT EXISTS idx_leases_workspace_state ON leases(workspace_id, state)",
      "CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, name TEXT NOT NULL, instructions TEXT NOT NULL, tool_policy_json TEXT NOT NULL, node_requirements_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      "CREATE INDEX IF NOT EXISTS idx_agents_workspace_id ON agents(workspace_id)",
      "CREATE TABLE IF NOT EXISTS previews (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, node_id TEXT REFERENCES nodes(id), kind TEXT NOT NULL, delivery_mode TEXT NOT NULL, source_type TEXT NOT NULL, path TEXT, port INTEGER, entry_path TEXT, service_id TEXT, descriptor_json TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER, revoked_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      "CREATE INDEX IF NOT EXISTS idx_previews_workspace_status ON previews(workspace_id, status)",
    ],
  },
  {
    version: 2,
    name: "workspace-scoped-keys-and-safe-fks",
    statements: [
      "PRAGMA foreign_keys = OFF",
      "ALTER TABLE api_keys RENAME TO api_keys_v1",
      "ALTER TABLE nodes RENAME TO nodes_v1",
      "ALTER TABLE node_credentials RENAME TO node_credentials_v1",
      "ALTER TABLE jobs RENAME TO jobs_v1",
      "ALTER TABLE leases RENAME TO leases_v1",
      "ALTER TABLE agents RENAME TO agents_v1",
      "ALTER TABLE previews RENAME TO previews_v1",
      "DROP INDEX IF EXISTS idx_api_keys_workspace_id",
      "DROP INDEX IF EXISTS idx_nodes_workspace_id",
      "DROP INDEX IF EXISTS idx_node_credentials_workspace_id",
      "DROP INDEX IF EXISTS idx_jobs_workspace_status",
      "DROP INDEX IF EXISTS idx_leases_workspace_state",
      "DROP INDEX IF EXISTS idx_agents_workspace_id",
      "DROP INDEX IF EXISTS idx_previews_workspace_status",
      "CREATE TABLE api_keys (workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, id TEXT NOT NULL, key_hash TEXT NOT NULL, name TEXT NOT NULL, scopes_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER, PRIMARY KEY (workspace_id, id))",
      "CREATE INDEX idx_api_keys_workspace_id ON api_keys(workspace_id)",
      "CREATE TABLE nodes (workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, id TEXT NOT NULL, manifest_json TEXT NOT NULL, pubkey_fingerprint TEXT NOT NULL, status TEXT NOT NULL, health_status TEXT NOT NULL DEFAULT 'unknown', adapter_kind TEXT NOT NULL, approved_at INTEGER, revoked_at INTEGER, last_seen_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, id))",
      "CREATE INDEX idx_nodes_workspace_id ON nodes(workspace_id)",
      "CREATE TABLE node_credentials (workspace_id TEXT NOT NULL, id TEXT NOT NULL, node_id TEXT NOT NULL, token_hash TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, rotated_at INTEGER, PRIMARY KEY (workspace_id, id), FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE, FOREIGN KEY (workspace_id, node_id) REFERENCES nodes(workspace_id, id) ON DELETE CASCADE)",
      "CREATE INDEX idx_node_credentials_workspace_id ON node_credentials(workspace_id)",
      "CREATE TABLE agents (workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, id TEXT NOT NULL, name TEXT NOT NULL, instructions TEXT NOT NULL, tool_policy_json TEXT NOT NULL, node_requirements_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, id))",
      "CREATE INDEX idx_agents_workspace_id ON agents(workspace_id)",
      "CREATE TABLE jobs (workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, id TEXT NOT NULL, agent_id TEXT, node_id TEXT, lease_id TEXT, status TEXT NOT NULL, task_package_json TEXT NOT NULL, result_json TEXT, error_json TEXT, created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER, PRIMARY KEY (workspace_id, id), FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, id) ON DELETE SET NULL, FOREIGN KEY (workspace_id, node_id) REFERENCES nodes(workspace_id, id) ON DELETE SET NULL)",
      "CREATE INDEX idx_jobs_workspace_status ON jobs(workspace_id, status)",
      "CREATE TABLE leases (workspace_id TEXT NOT NULL, id TEXT NOT NULL, node_id TEXT NOT NULL, job_id TEXT NOT NULL, profile_json TEXT NOT NULL, ttl_seconds INTEGER NOT NULL, state TEXT NOT NULL, reset_required INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, released_at INTEGER, PRIMARY KEY (workspace_id, id), FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE, FOREIGN KEY (workspace_id, node_id) REFERENCES nodes(workspace_id, id) ON DELETE CASCADE, FOREIGN KEY (workspace_id, job_id) REFERENCES jobs(workspace_id, id) ON DELETE CASCADE)",
      "CREATE INDEX idx_leases_workspace_state ON leases(workspace_id, state)",
      "CREATE TABLE previews (workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, id TEXT NOT NULL, node_id TEXT, kind TEXT NOT NULL, delivery_mode TEXT NOT NULL, source_type TEXT NOT NULL, path TEXT, port INTEGER, entry_path TEXT, service_id TEXT, descriptor_json TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER, revoked_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, id), FOREIGN KEY (workspace_id, node_id) REFERENCES nodes(workspace_id, id) ON DELETE SET NULL)",
      "CREATE INDEX idx_previews_workspace_status ON previews(workspace_id, status)",
      "INSERT INTO api_keys (workspace_id, id, key_hash, name, scopes_json, created_at, expires_at, revoked_at) SELECT workspace_id, id, key_hash, name, scopes_json, created_at, expires_at, revoked_at FROM api_keys_v1",
      "INSERT INTO nodes (workspace_id, id, manifest_json, pubkey_fingerprint, status, health_status, adapter_kind, approved_at, revoked_at, last_seen_at, last_error, created_at) SELECT workspace_id, id, manifest_json, pubkey_fingerprint, status, health_status, adapter_kind, approved_at, revoked_at, last_seen_at, last_error, created_at FROM nodes_v1",
      "INSERT INTO node_credentials (workspace_id, id, node_id, token_hash, issued_at, expires_at, rotated_at) SELECT workspace_id, id, node_id, token_hash, issued_at, expires_at, rotated_at FROM node_credentials_v1",
      "INSERT INTO agents (workspace_id, id, name, instructions, tool_policy_json, node_requirements_json, created_at, updated_at) SELECT workspace_id, id, name, instructions, tool_policy_json, node_requirements_json, created_at, updated_at FROM agents_v1",
      "INSERT INTO jobs (workspace_id, id, agent_id, node_id, lease_id, status, task_package_json, result_json, error_json, created_at, started_at, completed_at) SELECT workspace_id, id, agent_id, node_id, lease_id, status, task_package_json, result_json, error_json, created_at, started_at, completed_at FROM jobs_v1",
      "INSERT INTO leases (workspace_id, id, node_id, job_id, profile_json, ttl_seconds, state, reset_required, created_at, expires_at, released_at) SELECT workspace_id, id, node_id, job_id, profile_json, ttl_seconds, state, reset_required, created_at, expires_at, released_at FROM leases_v1",
      "INSERT INTO previews (workspace_id, id, node_id, kind, delivery_mode, source_type, path, port, entry_path, service_id, descriptor_json, status, expires_at, revoked_at, created_at, updated_at) SELECT workspace_id, id, node_id, kind, delivery_mode, source_type, path, port, entry_path, service_id, descriptor_json, status, expires_at, revoked_at, created_at, updated_at FROM previews_v1",
      "DROP TABLE previews_v1",
      "DROP TABLE leases_v1",
      "DROP TABLE jobs_v1",
      "DROP TABLE agents_v1",
      "DROP TABLE node_credentials_v1",
      "DROP TABLE nodes_v1",
      "DROP TABLE api_keys_v1",
      "PRAGMA foreign_keys = ON",
    ],
  },
  {
    version: 3,
    name: "node-credential-runtime-token",
    statements: [
      "ALTER TABLE node_credentials ADD COLUMN token_ciphertext TEXT",
    ],
  },
  {
    version: 4,
    name: "network-sessions-and-job-events",
    statements: [
      "CREATE TABLE IF NOT EXISTS network_sessions (workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, id TEXT NOT NULL, client_kind TEXT NOT NULL, client_session_id TEXT, intern_session_key TEXT NOT NULL, initiator_subject TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_job_id TEXT, last_activity_at INTEGER NOT NULL, closed_at INTEGER, PRIMARY KEY (workspace_id, id), FOREIGN KEY (workspace_id, last_job_id) REFERENCES jobs(workspace_id, id) ON DELETE SET NULL)",
      "CREATE INDEX IF NOT EXISTS idx_network_sessions_workspace_updated ON network_sessions(workspace_id, updated_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_network_sessions_workspace_client ON network_sessions(workspace_id, client_kind, client_session_id)",
      "CREATE INDEX IF NOT EXISTS idx_network_sessions_workspace_intern_key ON network_sessions(workspace_id, intern_session_key)",
      "ALTER TABLE jobs ADD COLUMN network_session_id TEXT",
      "CREATE TABLE IF NOT EXISTS job_events (workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, id TEXT NOT NULL, job_id TEXT NOT NULL, network_session_id TEXT, event_type TEXT NOT NULL, sequence INTEGER NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, id), FOREIGN KEY (workspace_id, job_id) REFERENCES jobs(workspace_id, id) ON DELETE CASCADE, FOREIGN KEY (workspace_id, network_session_id) REFERENCES network_sessions(workspace_id, id) ON DELETE SET NULL)",
      "CREATE INDEX IF NOT EXISTS idx_job_events_workspace_job_sequence ON job_events(workspace_id, job_id, sequence)",
      "CREATE INDEX IF NOT EXISTS idx_job_events_workspace_session_created ON job_events(workspace_id, network_session_id, created_at)",
    ],
  },
  {
    version: 5,
    name: "idempotency-records",
    statements: [
      "CREATE TABLE IF NOT EXISTS idempotency_records (scope TEXT NOT NULL, owner_key TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_body TEXT NOT NULL, response_json TEXT NOT NULL, status_code INTEGER NOT NULL, resource_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (scope, owner_key, idempotency_key))",
      "CREATE INDEX IF NOT EXISTS idx_idempotency_records_expires_at ON idempotency_records(expires_at)",
    ],
  },
];