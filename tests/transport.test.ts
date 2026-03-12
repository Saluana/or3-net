import { describe, expect, test } from "bun:test";

import { HttpsNodeTransport, NodeTransportRegistry, OutboundWssNodeTransport, RemoteNodeExecutor } from "../src/index.ts";
import { taskPackageSchema, type NodeRequest, type NodeEvent } from "../src/contracts/index.ts";

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
  test("executes the same lifecycle contract over https and outbound-wss", async () => {
    const seenMethods: string[] = [];
    const seenAuth: string[] = [];
    const fetchTransport = new HttpsNodeTransport({
      endpoint: "https://node.example/rpc",
      fetch: ((_input, init) => {
        const payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as NodeRequest;
        seenMethods.push(`https:${payload.method}`);
        seenAuth.push(init?.headers instanceof Headers ? (init.headers.get("Authorization") ?? "") : String((init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? ""));
        return Promise.resolve(new Response(
          JSON.stringify({
            id: payload.id,
            result: { output_text: "remote ok", artifacts: [], meta: { via: "https" } },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ));
      }) as typeof fetch,
    });
    const wssTransport = new OutboundWssNodeTransport();
    wssTransport.attachConnection("node_wss", async (payload, context) => {
      seenMethods.push(`outbound-wss:${payload.method}`);
      seenAuth.push(context.credential.token);
      return {
        id: payload.id,
        result: { output_text: "remote ok", artifacts: [], meta: { via: "outbound-wss" } },
      };
    });

    const registry = new NodeTransportRegistry();
    registry.registerKindTransport("https", fetchTransport);
    registry.registerNodeTransport("ws_transport", "node_wss", wssTransport);
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

    const httpsRun = await executor.startExecution(
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
      { token: "cred_https", expires_at: "2099-01-01T00:00:00.000Z" },
    );
    const httpsResult = await httpsRun.result;

    const wssRun = await executor.startExecution(
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
      { token: "cred_wss", expires_at: "2099-01-01T00:00:00.000Z" },
    );
    const wssResult = await wssRun.result;

    expect(httpsResult.output_text).toBe("remote ok");
    expect(wssResult.output_text).toBe("remote ok");
    expect(seenMethods).toEqual(["https:execute", "outbound-wss:execute"]);
    expect(seenAuth).toEqual(["Bearer cred_https", "cred_wss"]);
  });

  test("supports abort and surfaced progress over both transports", async () => {
    const events: NodeEvent[] = [
      { event: "progress", data: { percent: 50, message: "halfway" } },
      { event: "complete", data: { output_text: "done", artifacts: [], meta: {} } },
    ];

    const httpsTransport = new HttpsNodeTransport({
      endpoint: "https://node.example/rpc",
      fetch: ((_input) => {
        const url = typeof _input === "string" ? _input : String(_input);
        if (url.includes("/abort")) {
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        return Promise.resolve(new Response(JSON.stringify({ events }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }) as typeof fetch,
    });

    const httpsRun = await httpsTransport.startExecution(
      {
        workspace_id: "ws_transport",
        job_id: "job_stream",
        kind: "turn",
        instructions: "echo hello",
        artifacts: [],
        tool_policy: { mode: "allow_all", allowed_tools: [], blocked_tools: [] },
        timeout: { soft_ms: 1000 },
        lease_profile: { profile_id: "default", ttl_seconds: 60, required_capabilities: ["exec"] },
        subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
        metadata: {},
      },
      {
        workspaceId: "ws_transport",
        nodeId: "node_https",
        credential: { token: "cred_https", expiresAt: "2099-01-01T00:00:00.000Z" },
      },
    );
    expect(await collect(httpsRun.stream ?? emptyAsync())).toEqual([
      { event: "text.delta", data: { text: "halfway" } },
    ]);
    expect((await httpsRun.result).output_text).toBe("done");
    await expect(httpsRun.abort()).resolves.toBeUndefined();

    const wssTransport = new OutboundWssNodeTransport();
    let aborted = false;
    wssTransport.attachConnection("node_wss", async (request) => {
      if (request.method === "abort") {
        aborted = true;
        return { id: request.id, result: { output_text: "aborted", artifacts: [], meta: {} } };
      }
      return { id: request.id, result: { output_text: "done", artifacts: [], meta: {} } };
    }, async function* () {
      yield { event: "progress", data: { percent: 25, message: "quarter" } };
      yield { event: "complete", data: { output_text: "done", artifacts: [], meta: {} } };
    });
    const run = await wssTransport.startExecution(
      {
        workspace_id: "ws_transport",
        job_id: "job_wss_stream",
        kind: "turn",
        instructions: "echo hi",
        artifacts: [],
        tool_policy: { mode: "allow_all", allowed_tools: [], blocked_tools: [] },
        timeout: { soft_ms: 1000 },
        lease_profile: { profile_id: "default", ttl_seconds: 60, required_capabilities: ["exec"] },
        subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
        metadata: {},
      },
      {
        workspaceId: "ws_transport",
        nodeId: "node_wss",
        credential: { token: "cred_wss", expiresAt: "2099-01-01T00:00:00.000Z" },
      },
    );
    expect(await collect(run.stream ?? emptyAsync())).toEqual([{ event: "text.delta", data: { text: "quarter" } }]);
    await run.abort();
    expect(aborted).toBeTrue();
  });

  test("consumes outbound-wss progress streams only once per execution", async () => {
    const wssTransport = new OutboundWssNodeTransport();
    let streamStarts = 0;
    wssTransport.attachConnection(
      "node_wss_single_consumer",
      async (request) => ({
        id: request.id,
        result: { output_text: "done", artifacts: [], meta: {} },
      }),
      async function* () {
        streamStarts += 1;
        if (streamStarts > 1) {
          throw new Error("stream opened twice");
        }
        yield { event: "progress", data: { percent: 10, message: "warming" } };
        yield { event: "complete", data: { output_text: "done", artifacts: [], meta: {} } };
      },
    );

    const run = await wssTransport.startExecution(
      {
        workspace_id: "ws_transport",
        job_id: "job_wss_single",
        kind: "turn",
        instructions: "echo hi",
        artifacts: [],
        tool_policy: { mode: "allow_all", allowed_tools: [], blocked_tools: [] },
        timeout: { soft_ms: 1000 },
        lease_profile: { profile_id: "default", ttl_seconds: 60, required_capabilities: ["exec"] },
        subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
        metadata: {},
      },
      {
        workspaceId: "ws_transport",
        nodeId: "node_wss_single_consumer",
        credential: { token: "cred_wss", expiresAt: "2099-01-01T00:00:00.000Z" },
      },
    );

    expect(await collect(run.stream ?? emptyAsync())).toEqual([{ event: "text.delta", data: { text: "warming" } }]);
    expect((await run.result).output_text).toBe("done");
    expect(streamStarts).toBe(1);
  });

  test("uses workspace-scoped node transport registrations for the same node_id", async () => {
    const registry = new NodeTransportRegistry();
    registry.registerNodeTransport("ws_alpha", "node_shared", {
      kind: "outbound-wss",
      startExecution: async () => ({
        nodeId: "node_shared",
        result: Promise.resolve({ output_text: "alpha", artifacts: [], meta: {} }),
        abort: async () => {},
      }),
    });
    registry.registerNodeTransport("ws_beta", "node_shared", {
      kind: "outbound-wss",
      startExecution: async () => ({
        nodeId: "node_shared",
        result: Promise.resolve({ output_text: "beta", artifacts: [], meta: {} }),
        abort: async () => {},
      }),
    });
    const executor = new RemoteNodeExecutor(registry);
    const taskPackage = taskPackageSchema.parse({
      workspace_id: "ws_alpha",
      job_id: "job_scoped",
      kind: "turn",
      instructions: "echo scoped",
      artifacts: [],
      tool_policy: { mode: "allow_all", allowed_tools: [], blocked_tools: [] },
      timeout: { soft_ms: 1000 },
      lease_profile: { profile_id: "default", ttl_seconds: 60, required_capabilities: ["exec"] },
      subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
      metadata: {},
    });

    const alphaRun = await executor.startExecution(
      {
        ...baseNode,
        workspace_id: "ws_alpha",
        manifest: {
          node_id: "node_shared",
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
      { token: "cred_alpha", expires_at: "2099-01-01T00:00:00.000Z" },
    );

    const betaRun = await executor.startExecution(
      {
        ...baseNode,
        workspace_id: "ws_beta",
        manifest: {
          node_id: "node_shared",
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
      { ...taskPackage, workspace_id: "ws_beta", job_id: "job_scoped_beta" },
      { token: "cred_beta", expires_at: "2099-01-01T00:00:00.000Z" },
    );

    expect((await alphaRun.result).output_text).toBe("alpha");
    expect((await betaRun.result).output_text).toBe("beta");
  });
});

const collect = async <T>(iterable: AsyncIterable<T>): Promise<T[]> => {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
};

async function* emptyAsync<T>(): AsyncIterable<T> {}
