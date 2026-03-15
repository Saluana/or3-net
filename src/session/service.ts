/**
 * @module src/session/service
 *
 * Purpose:
 * Resolves client-facing session identity into persisted network-session rows.
 * This gives OR3 Net a stable session reference even when callers reconnect
 * using different identifiers.
 *
 * Responsibilities:
 * - Reuse existing bindings when a known session is presented
 * - Create new network sessions when only client or service identity exists
 * - Produce platform-facing session references for downstream APIs
 *
 * Non-responsibilities:
 * - Does not authorize the caller
 * - Does not schedule or execute jobs
 */
import { createId } from "../lib/ids.ts";
import type { ControlPlaneDatabase, StoredNetworkSession } from "../db/index.ts";
import { toPlatformSessionRef } from "../contracts/platform/compat.ts";
import type { PlatformSessionRef } from "../contracts/platform/types.ts";

/**
 * Purpose:
 * Input used to resolve or create a persisted network-session binding.
 *
 * Behavior:
 * Callers may identify a session through a persisted OR3 session id, a client
 * session tuple, or an internal session key.
 */
export interface ResolveSessionBindingInput {
  readonly workspace_id: string;
  readonly network_session_id?: string;
  readonly client_kind?: string;
  readonly client_session_id?: string;
  readonly session_key?: string;
  readonly initiator_subject?: string;
}

/**
 * Purpose:
 * Result returned when a resolved binding also needs the normalized platform
 * session reference exposed over API contracts.
 */
export interface ResolvedPlatformSessionBinding {
  readonly binding: StoredNetworkSession;
  readonly platform_session_ref: PlatformSessionRef;
}

/**
 * Purpose:
 * Creates and reuses durable network-session bindings for incoming callers.
 *
 * Constraints:
 * - Every resolved binding belongs to exactly one workspace
 * - Missing identifiers are rejected rather than guessed
 */
export class SessionBindingService {
  public constructor(private readonly database: ControlPlaneDatabase) {}

  /**
   * Purpose:
   * Resolves the best available session identifier to a stored binding.
   *
   * Behavior:
   * Prefers explicit network-session ids, then client identity, then internal
   * session keys. Existing bindings are touched to refresh activity timestamps.
   *
   * @throws Error when the caller provides no usable session identity.
   */
  public resolveBinding(input: ResolveSessionBindingInput): StoredNetworkSession {
    const store = this.database.workspace(input.workspace_id);
    const now = new Date().toISOString();

    if (input.network_session_id !== undefined) {
      const existing = store.getNetworkSession(input.network_session_id);
      return store.touchNetworkSession(existing.network_session_id, {
        last_activity_at: now,
      });
    }

    if (input.client_kind !== undefined && input.client_session_id !== undefined) {
      const existing = store.findNetworkSessionByClient(input.client_kind, input.client_session_id);
      if (existing !== null) {
        return store.touchNetworkSession(existing.network_session_id, {
          last_activity_at: now,
        });
      }

      const networkSessionId = createId("sess");
      return store.saveNetworkSession({
        network_session_id: networkSessionId,
        client_kind: input.client_kind,
        client_session_id: input.client_session_id,
        intern_session_key: input.session_key ?? `svc:${networkSessionId}`,
        status: "active",
        created_at: now,
        updated_at: now,
        last_activity_at: now,
        ...(input.initiator_subject === undefined ? {} : { initiator_subject: input.initiator_subject }),
      });
    }

    if (input.session_key !== undefined) {
      const existing = store.findNetworkSessionByInternSessionKey(input.session_key);
      if (existing !== null) {
        return store.touchNetworkSession(existing.network_session_id, {
          last_activity_at: now,
        });
      }

      const networkSessionId = createId("sess");
      return store.saveNetworkSession({
        network_session_id: networkSessionId,
        client_kind: input.client_kind ?? "legacy",
        intern_session_key: input.session_key,
        status: "active",
        created_at: now,
        updated_at: now,
        last_activity_at: now,
        ...(input.client_session_id === undefined ? {} : { client_session_id: input.client_session_id }),
        ...(input.initiator_subject === undefined ? {} : { initiator_subject: input.initiator_subject }),
      });
    }

    throw new Error("job submission requires network_session_id, client session identity, or session_key");
  }

  /**
   * Purpose:
   * Returns both the stored binding and the normalized platform session ref
   * derived from it.
   */
  public resolvePlatformSessionBinding(input: ResolveSessionBindingInput): ResolvedPlatformSessionBinding {
    const binding = this.resolveBinding(input);
    return {
      binding,
      platform_session_ref: toPlatformSessionRef(binding),
    };
  }

  /**
   * Purpose:
   * Updates binding activity and optional status metadata after a job or client
   * lifecycle change.
   */
  public touchBinding(workspaceId: string, networkSessionId: string, input: { last_job_id?: string; status?: string; closed_at?: string } = {}): StoredNetworkSession {
    const now = new Date().toISOString();
    return this.database.workspace(workspaceId).touchNetworkSession(networkSessionId, {
      ...input,
      last_activity_at: now,
    });
  }

  /**
   * Purpose:
   * Lists persisted network-session bindings for a workspace.
   */
  public listBindings(workspaceId: string, input: { limit?: number } = {}): StoredNetworkSession[] {
    return this.database.workspace(workspaceId).listNetworkSessions(input);
  }

  /**
   * Purpose:
   * Fetches a single persisted network-session binding.
   */
  public getBinding(workspaceId: string, networkSessionId: string): StoredNetworkSession {
    return this.database.workspace(workspaceId).getNetworkSession(networkSessionId);
  }
}
