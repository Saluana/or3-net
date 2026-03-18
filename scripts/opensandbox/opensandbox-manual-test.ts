import { OpenSandboxNodeAdapter, OpenSandboxRuntimeAdapter } from "../../src/index.ts";
import { taskPackageSchema } from "../../src/contracts/core.ts";
import { runtimeSessionCreateInputSchema } from "../../src/contracts/runtime/index.ts";
import { SdkOpenSandboxClient, resolveOpenSandboxClientConfig } from "../../sdk/opensandbox/client.ts";

const config = resolveOpenSandboxClientConfig(Bun.env);
if (config === null) {
  throw new Error("OpenSandbox config is missing. Run: source ./.local/opensandbox/env.sh");
}

const client = new SdkOpenSandboxClient(config);

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const logStep = (message: string): void => {
  process.stdout.write(`\n==> ${message}\n`);
};

const protocol = config.protocol ?? "http";
const baseUrl = `${protocol}://${config.domain}`;

const waitForServer = async (): Promise<void> => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      void 0;
    }
    await Bun.sleep(1000);
  }
  throw new Error(`OpenSandbox server is not reachable at ${baseUrl}/health`);
};

const buildSessionConfig = (): ReturnType<typeof runtimeSessionCreateInputSchema.parse> =>
  runtimeSessionCreateInputSchema.parse({
    requested_capabilities: ["exec", "copy-in", "copy-out", "stop"],
    timeout_rules: { soft_ms: 60_000, hard_ms: 120_000 },
    metadata: {},
  });

const buildTaskPackage = (): ReturnType<typeof taskPackageSchema.parse> =>
  taskPackageSchema.parse({
    workspace_id: "ws_manual",
    job_id: `job_${String(Date.now())}`,
    kind: "chat.turn",
    instructions: "python -c \"import sys; print('node adapter smoke ok'); print('node adapter smoke err', file=sys.stderr)\"",
    artifacts: [
      {
        artifact_id: "artifact_readme",
        path: "README.md",
        kind: "text",
        content_type: "text/markdown",
        size_bytes: 12,
        text: "# manual test",
      },
    ],
    tool_policy: { mode: "allow_all", allowed_tools: [], blocked_tools: [] },
    timeout: { soft_ms: 30_000, hard_ms: 60_000 },
    lease_profile: { profile_id: "default", ttl_seconds: 300, required_capabilities: [] },
    subagent_policy: { enabled: false, max_depth: 0, max_jobs: 0 },
    metadata: {},
  });

const resolveEndpointUrl = (endpoint: { endpoint: string; url?: string }): string => endpoint.url ?? `http://${endpoint.endpoint}`;

const main = async (): Promise<void> => {
  await waitForServer();

  logStep("checking SDK lifecycle and file operations");
  const raw = await client.create({
    workspace_id: "ws_manual",
    image: config.defaultImage ?? "python:3.11-slim",
    timeout_seconds: 600,
    skip_health_check: false,
    ...(config.defaultReadyTimeoutSeconds === undefined ? {} : { ready_timeout_seconds: config.defaultReadyTimeoutSeconds }),
    metadata: { or3_test: "manual-sdk" },
    entrypoint: ["tail", "-f", "/dev/null"],
  });

  try {
    const execResult = await raw.runCommand("python -c \"print('sdk smoke ok')\"");
    assertCondition(execResult.exit_code === 0, `unexpected SDK exit code: ${String(execResult.exit_code)}`);
    assertCondition(execResult.stdout.includes("sdk smoke ok"), "SDK command output did not contain expected text");

    await raw.createDirectories([{ path: "/workspace/demo" }]);
    await raw.writeFiles([{ path: "/workspace/demo/hello.txt", data: "hello from sdk" }]);
    const fileContent = await raw.readFile("/workspace/demo/hello.txt");
    assertCondition(fileContent === "hello from sdk", `unexpected SDK file content: ${fileContent}`);

    await raw.runCommand("sh -lc 'nohup python -m http.server 8000 --directory /workspace/demo >/tmp/or3-http.log 2>&1 &' ");
    await Bun.sleep(2000);
    const endpoint = await raw.getEndpoint(8000);
    const endpointUrl = resolveEndpointUrl(endpoint);
    const endpointResponse = await fetch(`${endpointUrl}/hello.txt`);
    assertCondition(endpointResponse.ok, `endpoint fetch failed with status ${String(endpointResponse.status)}`);
    assertCondition((await endpointResponse.text()).includes("hello from sdk"), "endpoint response did not contain expected file content");

    const info = await client.get(raw.instance_id);
    assertCondition(info.id === raw.instance_id, "SDK get() did not return the created sandbox");
    await client.pause(raw.instance_id);
    await client.resume(raw.instance_id);
  } finally {
    await raw.kill().catch(() => undefined);
    await raw.close().catch(() => undefined);
  }

  logStep("checking OR3 runtime adapter lifecycle");
  const runtimeAdapter = new OpenSandboxRuntimeAdapter({ client });
  const session = await runtimeAdapter.createSession({
    workspace_id: "ws_manual",
    session_id: `sess_${String(Date.now())}`,
    config: buildSessionConfig(),
  });

  try {
    await runtimeAdapter.copyIn({
      workspace_id: "ws_manual",
      session_ref: session.ref,
      destination_path: "/workspace/app.py",
      content_text: "print('runtime adapter ok')",
      overwrite: true,
    });
    const execHandle = await runtimeAdapter.exec({
      workspace_id: "ws_manual",
      session_ref: session.ref,
      request: { command: "python", args: ["/workspace/app.py"], env: {}, background: false },
    });
    const execResult = await execHandle.result;
    assertCondition(execResult.exit_code === 0, `runtime adapter exit code was ${String(execResult.exit_code)}`);
    assertCondition(execResult.stdout.includes("runtime adapter ok"), "runtime adapter command output mismatch");

    const copiedOut = await runtimeAdapter.copyOut({
      workspace_id: "ws_manual",
      session_ref: session.ref,
      source_path: "/workspace/app.py",
      encoding: "text",
    });
    assertCondition(copiedOut.content_text?.includes("runtime adapter ok"), "runtime adapter copyOut mismatch");

    const stopped = await runtimeAdapter.stop({ workspace_id: "ws_manual", session_ref: session.ref });
    assertCondition(stopped.stopped, "runtime adapter stop did not report success");
  } finally {
    await runtimeAdapter.destroySession({ workspace_id: "ws_manual", session_ref: session.ref }).catch(() => undefined);
  }

  logStep("checking OR3 node adapter execution");
  const nodeAdapter = new OpenSandboxNodeAdapter(client);
  const events: string[] = [];
  const nodeResult = await nodeAdapter.executeTaskWithProgress("ws_manual", buildTaskPackage(), (event: { event: string }) => {
    events.push(event.event);
  });
  assertCondition(nodeResult.exit_code === 0, `node adapter exit code was ${String(nodeResult.exit_code)}`);
  assertCondition(events.includes("stdout") || events.includes("stderr"), "node adapter did not emit streamed progress events");

  logStep("manual OpenSandbox integration smoke test passed");
};

await main();
