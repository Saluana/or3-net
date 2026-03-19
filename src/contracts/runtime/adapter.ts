/**
 * @module src/contracts/runtime/adapter
 *
 * Purpose:
 * Defines the runtime adapter interface and the operational payloads used to
 * manage sessions, files, logs, services, and artifacts.
 *
 * Responsibilities:
 * - Standardize the minimum adapter contract OR3 Net can target
 * - Describe optional capabilities through explicit optional methods
 * - Keep runtime payloads transport-neutral and snake_case aligned
 */
import { z } from "zod";

import { isoDateTimeSchema, jsonObjectSchema, nonEmptyStringSchema, nonNegativeIntegerSchema } from "../shared.ts";
import type { RuntimeArtifactDescriptor } from "./artifacts.ts";
import { runtimeArtifactDescriptorSchema } from "./artifacts.ts";
import { RuntimeCapabilitySet, runtimeCapabilitySetSchema } from "./capabilities.ts";
import type { RuntimeNodeDescriptor, RuntimeAdapterHealth } from "./descriptors.ts";
import type { RuntimeExecutionHandle, RuntimeExecutionRequest } from "./execution.ts";
import type { RuntimeAdapterManifest } from "./manifest.ts";
import type { RuntimeSessionCreateInput, RuntimeSessionState } from "./sessions.ts";
import { runtimeSessionStateSchema } from "./sessions.ts";

/** Purpose: Port-number schema used by service-exposure contracts. */
const runtimePortNumberSchema = z.number().int().min(1).max(65535);

/** Purpose: Adapter-owned reference to a runtime session. */
export const runtimeAdapterSessionHandleSchema = z.object({
  ref: nonEmptyStringSchema,
  adapter_id: nonEmptyStringSchema,
  status: runtimeSessionStateSchema,
  node_id: nonEmptyStringSchema.optional(),
  capabilities: runtimeCapabilitySetSchema.default(RuntimeCapabilitySet.fromValues([])),
});

/** Purpose: Request payload for copying host-provided content into a session. */
export const runtimeCopyInInputSchema = z.object({
  session_ref: nonEmptyStringSchema,
  destination_path: nonEmptyStringSchema,
  content_text: z.string().optional(),
  content_base64: z.string().optional(),
  source_path: nonEmptyStringSchema.optional(),
  overwrite: z.boolean().default(true),
});

/** Purpose: Request payload for copying content out of a runtime session. */
export const runtimeCopyOutInputSchema = z.object({
  session_ref: nonEmptyStringSchema,
  source_path: nonEmptyStringSchema,
  destination_path: nonEmptyStringSchema.optional(),
  encoding: z.enum(["text", "base64"]).default("text"),
});

/** Purpose: Result envelope for file transfer operations. */
export const runtimeFileTransferResultSchema = z.object({
  path: nonEmptyStringSchema,
  bytes_transferred: nonNegativeIntegerSchema,
  encoding: z.enum(["text", "base64"]).optional(),
  content_text: z.string().optional(),
  content_base64: z.string().optional(),
});

/** Purpose: Input payload for batched or cursor-based log retrieval. */
export const runtimeGetLogsInputSchema = z.object({
  session_ref: nonEmptyStringSchema,
  cursor: z.string().optional(),
  limit: nonNegativeIntegerSchema.optional(),
});

/** Purpose: Request payload for opening a PTY in a runtime session. */
export const runtimePtyOpenInputSchema = z.object({
  session_ref: nonEmptyStringSchema,
  cols: nonNegativeIntegerSchema.optional(),
  rows: nonNegativeIntegerSchema.optional(),
  command: nonEmptyStringSchema.optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: nonEmptyStringSchema.optional(),
});

/** Purpose: Result returned after a runtime adapter opens a PTY. */
export const runtimePtyOpenResultSchema = z.object({
  pty_id: nonEmptyStringSchema,
  session_ref: nonEmptyStringSchema,
});

/** Purpose: Request payload for sending input into a runtime PTY. */
export const runtimePtyWriteInputSchema = z.object({
  session_ref: nonEmptyStringSchema,
  pty_id: nonEmptyStringSchema,
  data: z.string(),
});

/** Purpose: Result returned after writing to a runtime PTY. */
export const runtimePtyWriteResultSchema = z.object({
  accepted: z.literal(true),
});

/** Purpose: Request payload for resizing a runtime PTY. */
export const runtimePtyResizeInputSchema = z.object({
  session_ref: nonEmptyStringSchema,
  pty_id: nonEmptyStringSchema,
  cols: nonNegativeIntegerSchema,
  rows: nonNegativeIntegerSchema,
});

/** Purpose: Result returned after resizing a runtime PTY. */
export const runtimePtyResizeResultSchema = z.object({
  resized: z.literal(true),
});

/** Purpose: Request payload for closing a runtime PTY. */
export const runtimePtyCloseInputSchema = z.object({
  session_ref: nonEmptyStringSchema,
  pty_id: nonEmptyStringSchema,
});

/** Purpose: Result returned after closing a runtime PTY. */
export const runtimePtyCloseResultSchema = z.object({
  closed: z.literal(true),
});

/** Purpose: Request payload for streaming runtime PTY events. */
export const runtimePtyStreamInputSchema = z.object({
  session_ref: nonEmptyStringSchema,
  pty_id: nonEmptyStringSchema,
  cursor: z.string().optional(),
});

/** Purpose: A PTY event emitted by runtime adapters. */
export const runtimePtyEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("pty.output"),
    data: z.object({
      pty_id: nonEmptyStringSchema,
      text: z.string(),
      created_at: isoDateTimeSchema.optional(),
    }),
  }),
  z.object({
    event: z.literal("pty.exit"),
    data: z.object({
      pty_id: nonEmptyStringSchema,
      exit_code: z.number().int(),
      signal: z.string().nullable().default(null),
      created_at: isoDateTimeSchema.optional(),
    }),
  }),
]);

/** Purpose: Single runtime log chunk returned from log APIs or streams. */
export const runtimeLogChunkSchema = z.object({
  stream: z.enum(["stdout", "stderr", "system"]).default("stdout"),
  message: z.string(),
  cursor: z.string().optional(),
  created_at: isoDateTimeSchema.optional(),
});

/** Purpose: Paginated runtime log retrieval result. */
export const runtimeLogsResultSchema = z.object({
  chunks: z.array(runtimeLogChunkSchema).default([]),
  next_cursor: z.string().optional(),
});

/** Purpose: Directory browsing request against an adapter-managed filesystem. */
export const runtimeFileBrowseInputSchema = z.object({
  session_ref: nonEmptyStringSchema,
  path: nonEmptyStringSchema.optional(),
  recursive: z.boolean().default(false),
});

/** Purpose: Directory entry metadata returned by runtime file browsing. */
export const runtimeFileEntrySchema = z.object({
  path: nonEmptyStringSchema,
  kind: z.enum(["file", "directory"]),
  size_bytes: nonNegativeIntegerSchema.optional(),
  modified_at: isoDateTimeSchema.optional(),
});

/** Purpose: Runtime file read request payload. */
export const runtimeFileReadInputSchema = z.object({
  session_ref: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
  encoding: z.enum(["text", "base64"]).default("text"),
});

/** Purpose: Result payload for runtime file reads. */
export const runtimeFileReadResultSchema = z.object({
  path: nonEmptyStringSchema,
  encoding: z.enum(["text", "base64"]),
  content_text: z.string().optional(),
  content_base64: z.string().optional(),
  size_bytes: nonNegativeIntegerSchema.optional(),
});

/** Purpose: Runtime file write request payload. */
export const runtimeFileWriteInputSchema = z.object({
  session_ref: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
  content_text: z.string().optional(),
  content_base64: z.string().optional(),
  overwrite: z.boolean().default(true),
});

/** Purpose: Runtime file deletion request payload. */
export const runtimeFileDeleteInputSchema = z.object({
  session_ref: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
  recursive: z.boolean().default(false),
});

/**
 * Purpose:
 * Request payload for staging workspace content into a runtime session.
 */
export const runtimeWorkspaceMaterializeInputSchema = z.object({
  session_ref: nonEmptyStringSchema,
  source: z.object({
    kind: nonEmptyStringSchema,
    reference: nonEmptyStringSchema.optional(),
    paths: z.array(nonEmptyStringSchema).default([]),
  }),
  mode: z.enum(["read_only", "read_write"]),
  transport: z.enum(["auto", "archive", "file_api"]).default("auto"),
});

/** Purpose: Result payload returned after workspace materialization. */
export const runtimeWorkspaceMaterializeResultSchema = z.object({
  staged_paths: z.array(nonEmptyStringSchema).default([]),
  mode: z.enum(["read_only", "read_write"]),
  transport: z.enum(["archive", "file_api"]),
  metadata: jsonObjectSchema.default({}),
});

/** Purpose: Request payload for exposing a service from a runtime session. */
export const runtimeExposeServiceInputSchema = z.object({
  session_ref: nonEmptyStringSchema,
  service_name: nonEmptyStringSchema,
  port: runtimePortNumberSchema,
  visibility: z.enum(["private", "public"]).default("private"),
});

/** Purpose: Result returned after a runtime adapter exposes a service. */
export const runtimeExposeServiceResultSchema = z.object({
  service_id: nonEmptyStringSchema,
  launch_url: z.url().optional(),
  visibility: z.enum(["private", "public"]),
});

/** Purpose: Snapshot creation request for adapters that support checkpoints. */
export const runtimeSnapshotInputSchema = z.object({
  session_ref: nonEmptyStringSchema,
  label: nonEmptyStringSchema.optional(),
});

/** Purpose: Snapshot metadata returned by adapters that support checkpoints. */
export const runtimeSnapshotResultSchema = z.object({
  snapshot_id: nonEmptyStringSchema,
  created_at: isoDateTimeSchema,
  metadata: jsonObjectSchema.default({}),
});

/** Purpose: Artifact upload request payload for runtime adapters. */
export const runtimePushArtifactInputSchema = z.object({
  session_ref: nonEmptyStringSchema,
  artifact: runtimeArtifactDescriptorSchema,
});

export type RuntimeAdapterSessionHandle = z.infer<typeof runtimeAdapterSessionHandleSchema>;
export type RuntimeCopyInInput = z.infer<typeof runtimeCopyInInputSchema>;
export type RuntimeCopyOutInput = z.infer<typeof runtimeCopyOutInputSchema>;
export type RuntimeFileTransferResult = z.infer<typeof runtimeFileTransferResultSchema>;
export type RuntimeGetLogsInput = z.infer<typeof runtimeGetLogsInputSchema>;
export type RuntimeLogsResult = z.infer<typeof runtimeLogsResultSchema>;
export type RuntimePtyOpenInput = z.infer<typeof runtimePtyOpenInputSchema>;
export type RuntimePtyOpenResult = z.infer<typeof runtimePtyOpenResultSchema>;
export type RuntimePtyWriteInput = z.infer<typeof runtimePtyWriteInputSchema>;
export type RuntimePtyWriteResult = z.infer<typeof runtimePtyWriteResultSchema>;
export type RuntimePtyResizeInput = z.infer<typeof runtimePtyResizeInputSchema>;
export type RuntimePtyResizeResult = z.infer<typeof runtimePtyResizeResultSchema>;
export type RuntimePtyCloseInput = z.infer<typeof runtimePtyCloseInputSchema>;
export type RuntimePtyCloseResult = z.infer<typeof runtimePtyCloseResultSchema>;
export type RuntimePtyStreamInput = z.infer<typeof runtimePtyStreamInputSchema>;
export type RuntimePtyEvent = z.infer<typeof runtimePtyEventSchema>;
export type RuntimeFileBrowseInput = z.infer<typeof runtimeFileBrowseInputSchema>;
export type RuntimeFileEntry = z.infer<typeof runtimeFileEntrySchema>;
export type RuntimeFileReadInput = z.infer<typeof runtimeFileReadInputSchema>;
export type RuntimeFileReadResult = z.infer<typeof runtimeFileReadResultSchema>;
export type RuntimeFileWriteInput = z.infer<typeof runtimeFileWriteInputSchema>;
export type RuntimeFileDeleteInput = z.infer<typeof runtimeFileDeleteInputSchema>;
export type RuntimeWorkspaceMaterializeInput = z.infer<typeof runtimeWorkspaceMaterializeInputSchema>;
export type RuntimeWorkspaceMaterializeResult = z.infer<typeof runtimeWorkspaceMaterializeResultSchema>;
export type RuntimeExposeServiceInput = z.infer<typeof runtimeExposeServiceInputSchema>;
export type RuntimeExposeServiceResult = z.infer<typeof runtimeExposeServiceResultSchema>;
export type RuntimeSnapshotInput = z.infer<typeof runtimeSnapshotInputSchema>;
export type RuntimeSnapshotResult = z.infer<typeof runtimeSnapshotResultSchema>;
export type RuntimePushArtifactInput = z.infer<typeof runtimePushArtifactInputSchema>;

/**
 * Purpose:
 * Runtime adapter interface implemented by each execution backend.
 *
 * Behavior:
 * Required methods cover the minimum lifecycle OR3 Net needs to create sessions,
 * execute work, move files, and read logs. Optional methods advertise richer
 * capabilities such as browsing, staging, snapshots, or service exposure.
 *
 * Non-Goals:
 * - Does not prescribe how an adapter stores its own internal state
 * - Does not require every adapter to support every runtime capability
 */
export interface RuntimeAdapter {
  readonly manifest: RuntimeAdapterManifest;

  health(input?: { workspace_id?: string }): Promise<RuntimeAdapterHealth>;
  listNodes(input: { workspace_id: string }): Promise<RuntimeNodeDescriptor[]>;
  createSession(input: {
    workspace_id: string;
    session_id: string;
    config: RuntimeSessionCreateInput;
  }): Promise<RuntimeAdapterSessionHandle>;
  listSessions?(input: {
    workspace_id: string;
    status?: RuntimeSessionState;
  }): Promise<RuntimeAdapterSessionHandle[]>;
  getSession?(input: {
    workspace_id: string;
    session_ref: string;
  }): Promise<RuntimeAdapterSessionHandle | null>;
  destroySession(input: {
    workspace_id: string;
    session_ref: string;
  }): Promise<{ destroyed: boolean; message?: string }>;
  exec(input: {
    workspace_id: string;
    session_ref: string;
    request: RuntimeExecutionRequest;
  }): Promise<RuntimeExecutionHandle>;
  openPty?(input: { workspace_id: string } & RuntimePtyOpenInput): Promise<RuntimePtyOpenResult>;
  writePty?(input: { workspace_id: string } & RuntimePtyWriteInput): Promise<RuntimePtyWriteResult>;
  resizePty?(input: { workspace_id: string } & RuntimePtyResizeInput): Promise<RuntimePtyResizeResult>;
  closePty?(input: { workspace_id: string } & RuntimePtyCloseInput): Promise<RuntimePtyCloseResult>;
  streamPty?(input: { workspace_id: string } & RuntimePtyStreamInput): Promise<AsyncIterable<RuntimePtyEvent>>;
  copyIn(input: { workspace_id: string } & RuntimeCopyInInput): Promise<RuntimeFileTransferResult>;
  copyOut(input: { workspace_id: string } & RuntimeCopyOutInput): Promise<RuntimeFileTransferResult>;
  getLogs(input: { workspace_id: string } & RuntimeGetLogsInput): Promise<RuntimeLogsResult>;
  stop?(input: { workspace_id: string; session_ref: string }): Promise<{ stopped: boolean; status: RuntimeSessionState }>;
  resume?(input: { workspace_id: string; session_ref: string }): Promise<{ resumed: boolean; status: RuntimeSessionState }>;
  streamLogs?(input: { workspace_id: string } & RuntimeGetLogsInput): Promise<AsyncIterable<z.infer<typeof runtimeLogChunkSchema>>>;
  fileBrowse?(input: { workspace_id: string } & RuntimeFileBrowseInput): Promise<RuntimeFileEntry[]>;
  fileRead?(input: { workspace_id: string } & RuntimeFileReadInput): Promise<RuntimeFileReadResult>;
  fileWrite?(input: { workspace_id: string } & RuntimeFileWriteInput): Promise<RuntimeFileTransferResult>;
  fileDelete?(input: { workspace_id: string } & RuntimeFileDeleteInput): Promise<{ deleted: boolean; path: string }>;
  materializeWorkspace?(input: { workspace_id: string } & RuntimeWorkspaceMaterializeInput): Promise<RuntimeWorkspaceMaterializeResult>;
  exposeService?(input: { workspace_id: string } & RuntimeExposeServiceInput): Promise<RuntimeExposeServiceResult>;
  snapshot?(input: { workspace_id: string } & RuntimeSnapshotInput): Promise<RuntimeSnapshotResult>;
  pushArtifact?(input: { workspace_id: string } & RuntimePushArtifactInput): Promise<RuntimeArtifactDescriptor>;
}
