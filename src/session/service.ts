import { createId } from "../lib/ids.ts";
import type { ControlPlaneDatabase, StoredNetworkSession } from "../db/index.ts";

export interface ResolveSessionBindingInput {
  readonly workspace_id: string;
  readonly network_session_id?: string;
  readonly client_kind?: string;
  readonly client_session_id?: string;
  readonly session_key?: string;
  readonly initiator_subject?: string;
}

export class SessionBindingService {
  public constructor(private readonly database: ControlPlaneDatabase) {}

  public resolveBinding(input: ResolveSessionBindingInput): StoredNetworkSession {
    const store = this.database.workspace(input.workspace_id);

    if (input.network_session_id !== undefined) {
      const existing = store.getNetworkSession(input.network_session_id);
      return store.touchNetworkSession(existing.network_session_id, {
        last_activity_at: new Date().toISOString(),
      });
    }

    if (input.client_kind !== undefined && input.client_session_id !== undefined) {
      const existing = store.findNetworkSessionByClient(input.client_kind, input.client_session_id);
      if (existing !== null) {
        return store.touchNetworkSession(existing.network_session_id, {
          last_activity_at: new Date().toISOString(),
        });
      }

      const networkSessionId = createId("sess");
      return store.saveNetworkSession({
        network_session_id: networkSessionId,
        client_kind: input.client_kind,
        client_session_id: input.client_session_id,
        intern_session_key: input.session_key ?? `svc:${networkSessionId}`,
        status: "active",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_activity_at: new Date().toISOString(),
        ...(input.initiator_subject === undefined ? {} : { initiator_subject: input.initiator_subject }),
      });
    }

    if (input.session_key !== undefined) {
      const existing = store.findNetworkSessionByInternSessionKey(input.session_key);
      if (existing !== null) {
        return store.touchNetworkSession(existing.network_session_id, {
          last_activity_at: new Date().toISOString(),
        });
      }

      const networkSessionId = createId("sess");
      return store.saveNetworkSession({
        network_session_id: networkSessionId,
        client_kind: input.client_kind ?? "legacy",
        intern_session_key: input.session_key,
        status: "active",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_activity_at: new Date().toISOString(),
        ...(input.client_session_id === undefined ? {} : { client_session_id: input.client_session_id }),
        ...(input.initiator_subject === undefined ? {} : { initiator_subject: input.initiator_subject }),
      });
    }

    throw new Error("job submission requires network_session_id, client session identity, or session_key");
  }

  public touchBinding(workspaceId: string, networkSessionId: string, input: { last_job_id?: string; status?: string; closed_at?: string } = {}): StoredNetworkSession {
    return this.database.workspace(workspaceId).touchNetworkSession(networkSessionId, {
      ...input,
      last_activity_at: new Date().toISOString(),
    });
  }

  public listBindings(workspaceId: string): StoredNetworkSession[] {
    return this.database.workspace(workspaceId).listNetworkSessions();
  }

  public getBinding(workspaceId: string, networkSessionId: string): StoredNetworkSession {
    return this.database.workspace(workspaceId).getNetworkSession(networkSessionId);
  }
}
