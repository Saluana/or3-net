import { describe, expect, test } from "bun:test";

import {
  jobStreamEventSchema,
  nodeManifestSchema,
  previewDescriptorSchema,
  serializeWithSchema,
  taskPackageSchema,
  toolPolicySchema,
} from "../src/index.ts";
import { parseWithSchema } from "../src/contracts/shared.ts";

describe("contract validation", () => {
  test("rejects unsafe allow_list tool policies without tools", () => {
    expect(() =>
      toolPolicySchema.parse({
        mode: "allow_list",
        allowed_tools: [],
        blocked_tools: [],
      }),
    ).toThrow("allow_list policies");
  });

  test("accepts a complete node manifest", () => {
    const manifest = nodeManifestSchema.parse({
      node_id: "node-local-1",
      pubkey: "base64-pubkey",
      signature: "base64-signature",
      adapter_kind: "sandbox",
      capabilities: ["exec", "file_io"],
      isolation_class: "docker-trusted",
      supports_transports: ["https"],
      resource_limits: {
        max_concurrent_jobs: 2,
        cpu_cores: 4,
        memory_mb: 4096,
        disk_mb: 8192,
      },
      lease_policy: {
        max_ttl_seconds: 600,
        supports_warm_pool: true,
        reset_methods: ["process_kill", "fs_scrub"],
      },
      version: "1.0.0",
    });

    expect(manifest.adapter_kind).toBe("sandbox");
  });

  test("round-trips task packages via typed serialization", () => {
    const payload = taskPackageSchema.parse({
      workspace_id: "ws_1",
      job_id: "job_1",
      kind: "turn",
      instructions: "Write a status report",
      artifacts: [
        {
          artifact_id: "artifact_1",
          path: "/workspace/report.md",
          kind: "text",
          content_type: "text/markdown",
          size_bytes: 24,
          text: "hello world",
        },
      ],
      tool_policy: {
        mode: "allow_list",
        allowed_tools: ["read_file"],
        blocked_tools: [],
      },
      timeout: {
        soft_ms: 30_000,
      },
      lease_profile: {
        profile_id: "default",
        ttl_seconds: 120,
        required_capabilities: ["exec"],
      },
      subagent_policy: {
        enabled: true,
        max_depth: 1,
        max_jobs: 2,
      },
      metadata: {
        source: "test",
      },
    });

    const serialized = serializeWithSchema(taskPackageSchema, payload);
    const roundTripped = parseWithSchema(taskPackageSchema, serialized);

    expect(roundTripped.instructions).toBe(payload.instructions);
    expect(roundTripped.lease_profile.required_capabilities).toEqual(["exec"]);
  });

  test("requires launch metadata for iframe-capable previews", () => {
    const preview = previewDescriptorSchema.parse({
      preview_id: "preview_1",
      workspace_id: "ws_1",
      kind: "static-site",
      delivery_mode: "embedded-preferred",
      source_type: "files",
      path: "/workspace/site/dist",
      entry_path: "/index.html",
      status: "ready",
      embed_url: "https://preview.example/embed/1",
      launch_url: "https://preview.example/launch/1",
      supports_iframe: true,
      supports_new_tab: true,
    });

    expect(preview.supports_iframe).toBeTrue();
  });

  test("supports the planned host job stream event set", () => {
    const event = jobStreamEventSchema.parse({
      event: "job.completed",
      data: {
        output_text: "done",
        artifacts: [],
        meta: {},
      },
    });

    expect(event.event).toBe("job.completed");
  });
});