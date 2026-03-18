/**
 * @module src/contracts/protocol
 *
 * Purpose:
 * Wire protocol contracts for communication between the control plane and remote
 * execution nodes.
 *
 * Responsibilities:
 * - Define request and response envelopes for node RPC-style exchanges
 * - Define incremental node and job stream event payloads
 *
 * Non-responsibilities:
 * - Does not define public client-facing stream envelopes
 * - Does not describe transport details such as SSE or WebSocket framing
 */
import { z } from "zod";

import { jobErrorSchema, jobResultSchema, nodeManifestSchema, taskPackageSchema } from "./core.ts";
import { nonEmptyStringSchema, nonNegativeIntegerSchema } from "./shared.ts";

/** Purpose: Progress payload emitted by nodes during long-running execution. */
export const executionProgressSchema = z.object({
  percent: nonNegativeIntegerSchema.max(100),
  message: nonEmptyStringSchema,
});

/**
 * Purpose:
 * Request union accepted by OR3-compatible node transports.
 */
export const nodeRequestSchema = z.discriminatedUnion("method", [
  z.object({
    id: nonEmptyStringSchema,
    method: z.literal("handshake"),
    params: nodeManifestSchema,
  }),
  z.object({
    id: nonEmptyStringSchema,
    method: z.literal("execute"),
    params: taskPackageSchema,
  }),
  z.object({
    id: nonEmptyStringSchema,
    method: z.literal("heartbeat"),
  }),
  z.object({
    id: nonEmptyStringSchema,
    method: z.literal("abort"),
    params: z.object({
      job_id: nonEmptyStringSchema,
    }),
  }),
  z.object({
    id: nonEmptyStringSchema,
    method: z.literal("create_session"),
    params: z.object({
      session_id: nonEmptyStringSchema,
      workspace_id: nonEmptyStringSchema,
    }),
  }),
  z.object({
    id: nonEmptyStringSchema,
    method: z.literal("get_session"),
    params: z.object({
      session_id: nonEmptyStringSchema,
    }),
  }),
  z.object({
    id: nonEmptyStringSchema,
    method: z.literal("destroy_session"),
    params: z.object({
      session_id: nonEmptyStringSchema,
    }),
  }),
  z.object({
    id: nonEmptyStringSchema,
    method: z.literal("session_exec"),
    params: z.object({
      session_id: nonEmptyStringSchema,
      command: nonEmptyStringSchema,
      args: z.array(z.string()).default([]),
      cwd: z.string().optional(),
      env: z.record(z.string(), z.string()).default({}),
      timeout_ms: nonNegativeIntegerSchema.optional(),
      stdin: z.string().optional(),
    }),
  }),
  z.object({
    id: nonEmptyStringSchema,
    method: z.literal("get_logs"),
    params: z.object({
      session_id: nonEmptyStringSchema,
      cursor: z.string().optional(),
      limit: nonNegativeIntegerSchema.optional(),
    }),
  }),
  z.object({
    id: nonEmptyStringSchema,
    method: z.literal("file_read"),
    params: z.object({
      path: nonEmptyStringSchema,
      encoding: z.enum(["text", "base64"]).default("text"),
    }),
  }),
  z.object({
    id: nonEmptyStringSchema,
    method: z.literal("file_write"),
    params: z.object({
      path: nonEmptyStringSchema,
      content_text: z.string().optional(),
      content_base64: z.string().optional(),
      overwrite: z.boolean().default(true),
    }),
  }),
  z.object({
    id: nonEmptyStringSchema,
    method: z.literal("file_delete"),
    params: z.object({
      path: nonEmptyStringSchema,
      recursive: z.boolean().default(false),
    }),
  }),
  z.object({
    id: nonEmptyStringSchema,
    method: z.literal("file_browse"),
    params: z.object({
      path: z.string().optional(),
      recursive: z.boolean().default(false),
    }),
  }),
  z.object({
    id: nonEmptyStringSchema,
    method: z.literal("pty_open"),
    params: z.object({
      session_id: nonEmptyStringSchema,
      cols: nonNegativeIntegerSchema.default(80),
      rows: nonNegativeIntegerSchema.default(24),
      command: z.string().optional(),
      args: z.array(z.string()).default([]),
      env: z.record(z.string(), z.string()).default({}),
      cwd: z.string().optional(),
    }),
  }),
  z.object({
    id: nonEmptyStringSchema,
    method: z.literal("pty_input"),
    params: z.object({
      pty_id: nonEmptyStringSchema,
      data: nonEmptyStringSchema,
    }),
  }),
  z.object({
    id: nonEmptyStringSchema,
    method: z.literal("pty_resize"),
    params: z.object({
      pty_id: nonEmptyStringSchema,
      cols: nonNegativeIntegerSchema,
      rows: nonNegativeIntegerSchema,
    }),
  }),
  z.object({
    id: nonEmptyStringSchema,
    method: z.literal("pty_close"),
    params: z.object({
      pty_id: nonEmptyStringSchema,
    }),
  }),
  z.object({
    id: nonEmptyStringSchema,
    method: z.literal("service_launch"),
    params: z.object({
      service_name: nonEmptyStringSchema,
      command: nonEmptyStringSchema,
      args: z.array(z.string()).default([]),
      port: nonNegativeIntegerSchema,
      env: z.record(z.string(), z.string()).default({}),
      cwd: z.string().optional(),
    }),
  }),
  z.object({
    id: nonEmptyStringSchema,
    method: z.literal("service_stop"),
    params: z.object({
      service_id: nonEmptyStringSchema,
    }),
  }),
]);

/** Purpose: Response envelope for node RPC requests. */
export const nodeResponseSchema = z.union([
  z.object({
    id: nonEmptyStringSchema,
    result: jobResultSchema,
  }),
  z.object({
    id: nonEmptyStringSchema,
    error: jobErrorSchema,
  }),
]);

/** Purpose: Incremental event stream emitted directly by execution nodes. */
export const nodeEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("output"),
    data: z.object({
      text: z.string(),
    }),
  }),
  z.object({
    event: z.literal("tool_call"),
    data: z.object({
      name: nonEmptyStringSchema,
      params: z.record(z.string(), z.unknown()),
    }),
  }),
  z.object({
    event: z.literal("tool_result"),
    data: z.object({
      name: nonEmptyStringSchema,
      result: z.string(),
    }),
  }),
  z.object({
    event: z.literal("progress"),
    data: executionProgressSchema,
  }),
  z.object({
    event: z.literal("complete"),
    data: jobResultSchema,
  }),
  z.object({
    event: z.literal("error"),
    data: jobErrorSchema,
  }),
]);

/** Purpose: Transport frame used to send a node RPC request over a live socket. */
export const nodeTransportRequestFrameSchema = z.object({
  type: z.literal("request"),
  payload: nodeRequestSchema,
});

/** Purpose: Transport frame used to send a node RPC response over a live socket. */
export const nodeTransportResponseFrameSchema = z.object({
  type: z.literal("response"),
  payload: nodeResponseSchema,
});

/** Purpose: Transport frame used to stream node events for an in-flight request over a live socket. */
export const nodeTransportEventFrameSchema = z.object({
  type: z.literal("event"),
  request_id: nonEmptyStringSchema,
  payload: nodeEventSchema,
});

/** Purpose: Lightweight idle heartbeat frame emitted by connected nodes to refresh last-seen state. */
export const nodeTransportHeartbeatFrameSchema = z.object({
  type: z.literal("heartbeat"),
  sent_at: nonEmptyStringSchema,
});

/** Purpose: Framed websocket message exchanged between the control plane and a connected node. */
export const nodeTransportFrameSchema = z.discriminatedUnion("type", [
  nodeTransportRequestFrameSchema,
  nodeTransportResponseFrameSchema,
  nodeTransportEventFrameSchema,
  nodeTransportHeartbeatFrameSchema,
]);

/**
 * Purpose:
 * Normalized job-level event stream used internally by the control plane.
 */
export const jobStreamEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("job.accepted"), data: z.object({ job_id: nonEmptyStringSchema }) }),
  z.object({ event: z.literal("job.started"), data: z.object({ job_id: nonEmptyStringSchema }) }),
  z.object({ event: z.literal("text.delta"), data: z.object({ text: z.string() }) }),
  z.object({ event: z.literal("tool.call"), data: z.object({ name: nonEmptyStringSchema }) }),
  z.object({ event: z.literal("tool.result"), data: z.object({ name: nonEmptyStringSchema, result: z.string() }) }),
  z.object({ event: z.literal("job.completed"), data: jobResultSchema }),
  z.object({ event: z.literal("job.aborted"), data: z.object({ job_id: nonEmptyStringSchema }) }),
  z.object({ event: z.literal("job.failed"), data: jobErrorSchema }),
]);

export type JobStreamEvent = z.infer<typeof jobStreamEventSchema>;
export type NodeEvent = z.infer<typeof nodeEventSchema>;
export type NodeRequest = z.infer<typeof nodeRequestSchema>;
export type NodeResponse = z.infer<typeof nodeResponseSchema>;
export type NodeTransportFrame = z.infer<typeof nodeTransportFrameSchema>;