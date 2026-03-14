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

const runtimePortNumberSchema = z.number().int().min(1).max(65535);

export const runtimeAdapterSessionHandleSchema = z.object({
  ref: nonEmptyStringSchema,
  adapter_id: nonEmptyStringSchema,
  status: runtimeSessionStateSchema,
  node_id: nonEmptyStringSchema.optional(),
  capabilities: runtimeCapabilitySetSchema.default(RuntimeCapabilitySet.fromValues([])),
});

export const runtimeCopyInInputSchema = z.object({
  session_ref: nonEmptyStringSchema,
  destination_path: nonEmptyStringSchema,
  content_text: z.string().optional(),
  content_base64: z.string().optional(),
  source_path: nonEmptyStringSchema.optional(),
  overwrite: z.boolean().default(true),
});

export const runtimeCopyOutInputSchema = z.object({
  session_ref: nonEmptyStringSchema,
  source_path: nonEmptyStringSchema,
  destination_path: nonEmptyStringSchema.optional(),
  encoding: z.enum(["text", "base64"]).default("text"),
});

export const runtimeFileTransferResultSchema = z.object({
  path: nonEmptyStringSchema,
  bytes_transferred: nonNegativeIntegerSchema,
  encoding: z.enum(["text", "base64"]).optional(),
  content_text: z.string().optional(),
  content_base64: z.string().optional(),
});

export const runtimeGetLogsInputSchema = z.object({
  session_ref: nonEmptyStringSchema,
  cursor: z.string().optional(),
  limit: nonNegativeIntegerSchema.optional(),
});

export const runtimeLogChunkSchema = z.object({
  stream: z.enum(["stdout", "stderr", "system"]).default("stdout"),
  message: z.string(),
  cursor: z.string().optional(),
  created_at: isoDateTimeSchema.optional(),
});

export const runtimeLogsResultSchema = z.object({
  chunks: z.array(runtimeLogChunkSchema).default([]),
  next_cursor: z.string().optional(),
});

export const runtimeFileBrowseInputSchema = z.object({
  session_ref: nonEmptyStringSchema,
  path: nonEmptyStringSchema.optional(),
  recursive: z.boolean().default(false),
});

export const runtimeFileEntrySchema = z.object({
  path: nonEmptyStringSchema,
  kind: z.enum(["file", "directory"]),
  size_bytes: nonNegativeIntegerSchema.optional(),
  modified_at: isoDateTimeSchema.optional(),
});

export const runtimeFileReadInputSchema = z.object({
  session_ref: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
  encoding: z.enum(["text", "base64"]).default("text"),
});

export const runtimeFileReadResultSchema = z.object({
  path: nonEmptyStringSchema,
  encoding: z.enum(["text", "base64"]),
  content_text: z.string().optional(),
  content_base64: z.string().optional(),
  size_bytes: nonNegativeIntegerSchema.optional(),
});

export const runtimeFileWriteInputSchema = z.object({
  session_ref: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
  content_text: z.string().optional(),
  content_base64: z.string().optional(),
  overwrite: z.boolean().default(true),
});

export const runtimeFileDeleteInputSchema = z.object({
  session_ref: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
  recursive: z.boolean().default(false),
});

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

export const runtimeWorkspaceMaterializeResultSchema = z.object({
  staged_paths: z.array(nonEmptyStringSchema).default([]),
  mode: z.enum(["read_only", "read_write"]),
  transport: z.enum(["archive", "file_api"]),
  metadata: jsonObjectSchema.default({}),
});

export const runtimeExposeServiceInputSchema = z.object({
  session_ref: nonEmptyStringSchema,
  service_name: nonEmptyStringSchema,
  port: runtimePortNumberSchema,
  visibility: z.enum(["private", "public"]).default("private"),
});

export const runtimeExposeServiceResultSchema = z.object({
  service_id: nonEmptyStringSchema,
  launch_url: z.url().optional(),
  visibility: z.enum(["private", "public"]),
});

export const runtimeSnapshotInputSchema = z.object({
  session_ref: nonEmptyStringSchema,
  label: nonEmptyStringSchema.optional(),
});

export const runtimeSnapshotResultSchema = z.object({
  snapshot_id: nonEmptyStringSchema,
  created_at: isoDateTimeSchema,
  metadata: jsonObjectSchema.default({}),
});

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
