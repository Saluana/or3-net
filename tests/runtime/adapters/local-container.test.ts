import { describe, expect, test } from "bun:test";

import { LocalContainerRuntimeAdapter, RuntimeError } from "../../../src/index.ts";
import type { LocalContainerCommandResult, LocalContainerCommandRunner } from "../../../src/runtime/adapters/local-container.ts";

class FakeRunner implements LocalContainerCommandRunner {
  public readonly calls: { args: string[]; stdin?: string; timeoutMs?: number }[] = [];
  public results = new Map<string, LocalContainerCommandResult>();
  public errors = new Map<string, Error>();

  public run(args: string[], options: { stdin?: string; timeoutMs?: number } = {}): Promise<LocalContainerCommandResult> {
    this.calls.push({
      args,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    const key = args.join(" ");
    const error = this.errors.get(key);
    if (error !== undefined) {
      return Promise.reject(error);
    }
    return Promise.resolve(this.results.get(key) ?? { stdout: "", stderr: "", exitCode: 0 });
  }
}

describe("local container runtime adapter", () => {
  test("health succeeds when Docker daemon mock is available", async () => {
    const runner = new FakeRunner();
    runner.results.set("info", { stdout: "ok", stderr: "", exitCode: 0 });
    const adapter = new LocalContainerRuntimeAdapter({ runner });

    const health = await adapter.health();
    expect(health.status).toBe("healthy");
  });

  test("health returns unavailable when Docker daemon mock fails", async () => {
    const runner = new FakeRunner();
    runner.errors.set("info", new Error("Cannot connect to the Docker daemon"));
    const adapter = new LocalContainerRuntimeAdapter({ runner });

    const health = await adapter.health();
    expect(health.status).toBe("unavailable");
  });

  test("session create exec destroy lifecycle", async () => {
    const runner = new FakeRunner();
    runner.results.set("create alpine:3.19 sh -lc while true; do sleep 3600; done", { stdout: "ctr_1\n", stderr: "", exitCode: 0 });
    runner.results.set("start ctr_1", { stdout: "ctr_1", stderr: "", exitCode: 0 });
    runner.results.set("exec ctr_1 echo hello", { stdout: "hello", stderr: "", exitCode: 0 });
    runner.results.set("rm -f ctr_1", { stdout: "", stderr: "", exitCode: 0 });
    const adapter = new LocalContainerRuntimeAdapter({ runner });

    const session = await adapter.createSession({ workspace_id: "ws_test", session_id: "sess_1", config: minimalConfig() });
    const handle = await adapter.exec({
      workspace_id: "ws_test",
      session_ref: session.ref,
      request: { command: "echo", args: ["hello"], env: {}, background: false },
    });
    const result = await handle.result;
    const destroyed = await adapter.destroySession({ workspace_id: "ws_test", session_ref: session.ref });

    expect(session.ref).toBe("ctr_1");
    expect(result.stdout).toBe("hello");
    expect(destroyed.destroyed).toBeTrue();
  });

  test("exec timeout enforcement", async () => {
    const runner = new FakeRunner();
    runner.results.set("create alpine:3.19 sh -lc while true; do sleep 3600; done", { stdout: "ctr_1\n", stderr: "", exitCode: 0 });
    runner.results.set("start ctr_1", { stdout: "ctr_1", stderr: "", exitCode: 0 });
    runner.errors.set("exec ctr_1 sleep 10", new RuntimeError("exec_timeout", "timed out", { retriable: true }));
    const adapter = new LocalContainerRuntimeAdapter({ runner });
    const session = await adapter.createSession({ workspace_id: "ws_test", session_id: "sess_1", config: minimalConfig() });

    await expectRuntimeError(
      adapter.exec({
        workspace_id: "ws_test",
        session_ref: session.ref,
        request: { command: "sleep", args: ["10"], env: {}, background: false, timeout_ms: 10 },
      }).then((handle) => handle.result),
      "exec_timeout",
    );
  });

  test("copy-in and copy-out", async () => {
    const runner = new FakeRunner();
    runner.results.set("exec ctr_1 cat /tmp/test.txt", { stdout: "hello", stderr: "", exitCode: 0 });
    const adapter = new LocalContainerRuntimeAdapter({ runner });
    const copiedIn = await adapter.copyIn({
      workspace_id: "ws_test",
      session_ref: "ctr_1",
      destination_path: "/tmp/test.txt",
      content_text: "hello",
      overwrite: true,
    });
    const copiedOut = await adapter.copyOut({
      workspace_id: "ws_test",
      session_ref: "ctr_1",
      source_path: "/tmp/test.txt",
      encoding: "text",
    });

    const copyCall = runner.calls.find((call) => call.args[0] === "cp");
    expect(copyCall?.args[2]).toBe("ctr_1:/tmp/test.txt");
    expect(copiedIn.bytes_transferred).toBe(5);
    expect(copiedOut.content_text).toBe("hello");
  });

  test("adapter_unavailable error when daemon unreachable during session create", async () => {
    const runner = new FakeRunner();
    runner.errors.set("create alpine:3.19 sh -lc while true; do sleep 3600; done", new Error("Cannot connect to the Docker daemon"));
    const adapter = new LocalContainerRuntimeAdapter({ runner });

    await expectRuntimeError(adapter.createSession({ workspace_id: "ws_test", session_id: "sess_1", config: minimalConfig() }), "adapter_unavailable");
  });
  });
 
const minimalConfig = (): {
  workspace_mode: "none";
  network_policy: { internet_access: false; ingress: "none" };
  resource_hints: { metadata: Record<string, never> };
  persistence_mode: "ephemeral";
  env_refs: [];
  secret_refs: [];
  timeout_rules: Record<string, never>;
  artifact_rules: { capture_paths: []; push_on_completion: false; metadata: Record<string, never> };
} => ({
  workspace_mode: "none" as const,
  network_policy: { internet_access: false, ingress: "none" as const },
  resource_hints: { metadata: {} },
  persistence_mode: "ephemeral" as const,
  env_refs: [],
  secret_refs: [],
  timeout_rules: {},
  artifact_rules: { capture_paths: [], push_on_completion: false, metadata: {} },
});

const expectRuntimeError = async (promise: Promise<unknown>, code: RuntimeError["code"]): Promise<void> => {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof RuntimeError) {
      expect(error.code).toBe(code);
      return;
    }
    throw error;
  }

  throw new Error("expected RuntimeError");
};