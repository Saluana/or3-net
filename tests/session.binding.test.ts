import { describe, expect, test } from "bun:test";

import { createControlPlaneDatabase, SessionBindingService } from "../src/index.ts";

describe("session binding service", () => {
  test("produces a canonical PlatformSessionRef when creating a routed binding", () => {
    const database = createControlPlaneDatabase();
    database.saveWorkspace({
      workspace_id: "ws_bindings",
      name: "Bindings Workspace",
      created_at: "2024-01-01T00:00:00.000Z",
    });

    const service = new SessionBindingService(database);
    const resolved = service.resolvePlatformSessionBinding({
      workspace_id: "ws_bindings",
      client_kind: "chat",
      client_session_id: "thread_42",
      initiator_subject: "user_42",
    });

    expect(resolved.binding.workspace_id).toBe("ws_bindings");
    expect(resolved.binding.client_session_id).toBe("thread_42");
    expect(resolved.binding.intern_session_key).toBe(`svc:${resolved.binding.network_session_id}`);
    expect(resolved.platform_session_ref).toEqual({
      workspace_id: "ws_bindings",
      client_kind: "chat",
      client_session_id: "thread_42",
      network_session_id: resolved.binding.network_session_id,
      session_key: resolved.binding.intern_session_key,
    });

    database.close();
  });

  test("uses a single timestamp snapshot when creating a new binding", () => {
    const database = createControlPlaneDatabase();
    database.saveWorkspace({
      workspace_id: "ws_timestamps",
      name: "Timestamp Workspace",
      created_at: "2024-01-01T00:00:00.000Z",
    });

    const service = new SessionBindingService(database);
    const binding = service.resolveBinding({
      workspace_id: "ws_timestamps",
      client_kind: "chat",
      client_session_id: "thread_same_time",
    });

    expect(binding.created_at).toBe(binding.updated_at);
    expect(binding.created_at).toBe(binding.last_activity_at);

    database.close();
  });
});