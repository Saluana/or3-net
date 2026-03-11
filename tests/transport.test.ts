import { describe, expect, test } from "bun:test";

import { HttpsNodeTransport, NodeTransportRegistry, OutboundWssNodeTransport, RemoteNodeExecutor } from "../src/index.ts";
import { taskPackageSchema, type NodeRequest } from "../src/contracts/index.ts";

const baseNode = {
  workspace_id: "ws_transport",
  pubkey_fingerprint: "fp",
  status: "approved",
  health_status: "healthy",
  approved_at: null,
  revoked_at: null,
  last_seen_at: null,
  last_error: null,
  created_at: "2024-01-01T00:00:00.000Z",
};

describe("node transport abstraction", () => {
  test("executes the same RPC contract over https and outbound-wss", async () => {
    const seenMethods: string[] = [];
    const fetchTransport = new HttpsNodeTransport({
      endpoint: "https://node.example/rpc",
      fetch: ((_input, init) => {
        const payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as NodeRequest;
        seenMethods.push(`https:${payload.method}`);
        return Promise.resolve(new Response(
          JSON.stringify({
            id: payload.id,
            result: { output_text: "remote ok", artifacts: [], meta: { via: "https" } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ));
      }) as typeof fetch,
    });
    const wssTransport = new OutboundWssNodeTransport((payload) => {
      seenMethods.push(`outbound-wss:${payload.method}`);
      return Promise.resolve({
        id: payload.id,
        result: { output_text: "remote ok", artifacts: [], meta: { via: "outbound-wss" } },
      });
    });

    const registry = new NodeTransportRegistry();
    registry.registerKindTransport("https", fetchTransport);
    registry.registerNodeTransport("node_wss", wssTransport);
    const executor = new RemoteNodeExecutor(registry);

    const taskPackage = taskPackageSchema.parse({
      workspace_id: "ws_transport",
      job_id: "job_transport",
      kind: "turn",
      instructions: "echo hello",
      artifacts: [],
      tool_policy: { mode: "allow_all", allowed_tools: [], blocked_tools: [] },
      timeout: { soft_ms: 1000 },
      lease_profile: { profile_id: "default", ttl_seconds: 60, required_capabilities: ["exec"] },
      subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
      metadata: {},
    });

    const httpsResult = await executor.executeTask(
      {
        ...baseNode,
        manifest: {
          node_id: "node_https",
          pubkey: "pub",
          signature: "sig",
          adapter_kind: "remote",
          capabilities: ["exec"],
          isolation_class: "docker-trusted",
          supports_transports: ["https"],
          resource_limits: { max_concurrent_jobs: 1, cpu_cores: 1, memory_mb: 512, disk_mb: 512 },
          lease_policy: { max_ttl_seconds: 60, supports_warm_pool: false, reset_methods: ["process_kill"] },
          version: "1.0.0",
        },
      },
      taskPackage,
    );

    const wssResult = await executor.executeTask(
      {
        ...baseNode,
        manifest: {
          node_id: "node_wss",
          pubkey: "pub",
          signature: "sig",
          adapter_kind: "remote",
          capabilities: ["exec"],
          isolation_class: "docker-trusted",
          supports_transports: ["outbound-wss"],
          resource_limits: { max_concurrent_jobs: 1, cpu_cores: 1, memory_mb: 512, disk_mb: 512 },
          lease_policy: { max_ttl_seconds: 60, supports_warm_pool: false, reset_methods: ["process_kill"] },
          version: "1.0.0",
        },
      },
      taskPackage,
    );

    expect(httpsResult.output_text).toBe("remote ok");
    expect(wssResult.output_text).toBe("remote ok");
    expect(seenMethods).toEqual(["https:execute", "outbound-wss:execute"]);
  });
});