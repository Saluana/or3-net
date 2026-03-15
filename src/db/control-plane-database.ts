/**
 * @module src/db/control-plane-database
 *
 * Purpose:
 * Top-level OR3 Net control-plane database entry point for connection setup,
 * migrations, cross-workspace records, and startup reconciliation.
 *
 * Responsibilities:
 * - Own the Bun SQLite connection and initialization sequence
 * - Apply ordered schema migrations
 * - Expose global records such as workspaces, API keys, and idempotency entries
 * - Manufacture workspace-scoped stores on demand
 *
 * Non-responsibilities:
 * - Does not expose raw SQL to callers
 * - Does not parse row payloads directly; that is delegated to `codecs.ts`
 */
import { Database } from "bun:sqlite";

import { jobErrorSchema, workspaceSchema } from "../contracts/index.ts";
import { serializeWithSchema } from "../contracts/shared.ts";
import { fromIsoDateTime } from "../lib/time.ts";
import type {
  ApiKeyRow,
  IdempotencyRecordRow,
  StoredApiKey,
  StoredIdempotencyRecord,
  StoredWorkspace,
  WorkspaceRow,
} from "./schema.ts";
import { schemaMigrations } from "./schema.ts";
import { parseApiKeyRow, parseIdempotencyRecordRow, parseWorkspaceRow } from "./codecs.ts";
import { WorkspaceStore } from "./workspace-store.ts";
import {
  activeLeaseState,
  type DatabaseOptions,
  recoverableStartupJobStatuses,
  type SaveIdempotencyRecordInput,
  type StartupReconciliationSummary,
} from "./types.ts";

/**
 * Purpose:
 * Top-level control-plane database entry point responsible for connection
 * lifecycle, schema initialization, and cross-workspace queries.
 *
 * Constraints:
 * - Uses a single SQLite connection per instance
 * - Enables WAL mode and foreign-key enforcement immediately
 * - Startup reconciliation is explicit; construction does not mutate persisted state
 */
export class ControlPlaneDatabase {
  public readonly sqlite: Database;
  private readonly staleNodeThresholdMs: number;
  private readonly jobEventRetentionPerJob: number;
  private readonly runtimeSessionEventRetentionPerSession: number;

  /**
   * Purpose:
   * Creates a control-plane database handle with the configured retention and
   * stale-state thresholds.
   */
  public constructor(options: DatabaseOptions = {}) {
    this.sqlite = new Database(options.path ?? ":memory:");
    this.staleNodeThresholdMs = options.staleNodeThresholdMs ?? 60_000;
    this.jobEventRetentionPerJob = options.jobEventRetentionPerJob ?? 200;
    this.runtimeSessionEventRetentionPerSession = options.runtimeSessionEventRetentionPerSession ?? 200;
    this.sqlite.run("PRAGMA journal_mode = WAL;");
    this.sqlite.run("PRAGMA foreign_keys = ON;");
  }

  /** Purpose: Applies any pending schema migrations. */
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

  /** Purpose: Closes the underlying SQLite connection. */
  public close(): void {
    this.sqlite.close();
  }

  /** Purpose: Persists or updates a workspace record. */
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

  /** Purpose: Fetches a single workspace record. */
  public getWorkspace(workspaceId: string): StoredWorkspace {
    const row = this.sqlite
      .query<WorkspaceRow, [string]>("SELECT * FROM workspaces WHERE id = ? LIMIT 1")
      .get(workspaceId);

    if (row === null) {
      throw new Error(`Workspace ${workspaceId} was not found`);
    }

    return parseWorkspaceRow(row);
  }

  /** Purpose: Lists all known workspaces. */
  public listWorkspaces(): StoredWorkspace[] {
    return this.sqlite.query<WorkspaceRow, []>("SELECT * FROM workspaces ORDER BY created_at ASC").all().map(parseWorkspaceRow);
  }

  /** Purpose: Creates a workspace-scoped store facade. */
  public workspace(workspaceId: string): WorkspaceStore {
    return new WorkspaceStore(
      this.sqlite,
      workspaceId,
      this.jobEventRetentionPerJob,
      this.runtimeSessionEventRetentionPerSession,
    );
  }

  /** Purpose: Persists or updates an API key record. */
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

  /** Purpose: Fetches a single API key record. */
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

  /** Purpose: Looks up an active API key by its stored hash. */
  public findActiveApiKeyByHash(keyHash: string, nowMs = Date.now()): StoredApiKey | null {
    const row = this.sqlite
      .query<ApiKeyRow, [string, number]>(
        "SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) LIMIT 1",
      )
      .get(keyHash, nowMs);

    return row === null ? null : parseApiKeyRow(row);
  }

  /** Purpose: Lists API keys for a workspace. */
  public listApiKeys(workspaceId: string): StoredApiKey[] {
    return this.sqlite
      .query<ApiKeyRow, [string]>("SELECT * FROM api_keys WHERE workspace_id = ? ORDER BY created_at DESC")
      .all(workspaceId)
      .map(parseApiKeyRow);
  }

  /** Purpose: Marks an API key as revoked. */
  public revokeApiKey(workspaceId: string, apiKeyId: string, revokedAt = new Date().toISOString()): StoredApiKey {
    const result = this.sqlite
      .prepare("UPDATE api_keys SET revoked_at = ? WHERE workspace_id = ? AND id = ?")
      .run(fromIsoDateTime(revokedAt), workspaceId, apiKeyId);

    if (result.changes === 0) {
      throw new Error(`API key ${apiKeyId} was not found in workspace ${workspaceId}`);
    }

    return this.getApiKey(workspaceId, apiKeyId);
  }

  /** Purpose: Fetches a non-expired idempotency record if present. */
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

  /** Purpose: Persists or updates an idempotency record. */
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

  /** Purpose: Deletes expired idempotency records. */
  public pruneExpiredIdempotencyRecords(nowMs = Date.now()): number {
    return this.sqlite.prepare("DELETE FROM idempotency_records WHERE expires_at <= ?").run(nowMs).changes;
  }

  /**
   * Purpose:
   * Repairs stale running jobs, expired leases, and stale node health after host
   * restart.
   */
  public reconcileStartupState(nowMs = Date.now()): StartupReconciliationSummary {
    const failableStates = recoverableStartupJobStatuses.map(() => "?").join(", ");
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
        ...recoverableStartupJobStatuses,
      ).changes;

    const expiredLeases = this.sqlite
      .prepare("UPDATE leases SET state = 'expired', released_at = ? WHERE state = ? AND expires_at <= ?")
      .run(nowMs, activeLeaseState, nowMs).changes;

    const releasedLeases = this.sqlite
      .prepare(
        `UPDATE leases SET state = 'released', released_at = ? WHERE state = ? AND job_id IN (
          SELECT id FROM jobs WHERE workspace_id = leases.workspace_id AND status IN ('failed', 'aborted', 'completed')
        )`,
      )
      .run(nowMs, activeLeaseState).changes;

    const staleNodes = this.sqlite
      .prepare(
        "UPDATE nodes SET health_status = 'stale' WHERE status = 'approved' AND last_seen_at IS NOT NULL AND last_seen_at <= ?",
      )
      .run(nowMs - this.staleNodeThresholdMs).changes;

    return {
      failed_jobs: failedJobs,
      expired_leases: expiredLeases,
      released_leases: releasedLeases,
      stale_nodes: staleNodes,
    };
  }
}

/**
 * Purpose:
 * Convenience factory that creates, initializes, and returns a control-plane
 * database instance.
 *
 * Behavior:
 * Applies pending migrations before returning so callers receive a ready-to-use
 * database handle.
 */
export const createControlPlaneDatabase = (options?: DatabaseOptions): ControlPlaneDatabase => {
  const database = new ControlPlaneDatabase(options);
  database.initialize();
  return database;
};
