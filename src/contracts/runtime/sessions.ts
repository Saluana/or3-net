import { z } from "zod";

import { jsonObjectSchema, nonEmptyStringSchema, positiveIntegerSchema } from "../shared.ts";
import { runtimeCapabilitySetSchema } from "./capabilities.ts";
import { runtimeSessionModeSchema, runtimeSessionModeValues } from "./manifest.ts";

export const runtimeSessionStateValues = [
  "creating",
  "ready",
  "stopping",
  "stopped",
  "destroying",
  "destroyed",
  "failed",
] as const;

export const runtimeWorkspaceModeValues = ["none", "read_only", "read_write"] as const;
export const runtimeWorkspaceStageTransportValues = ["auto", "archive", "file_api"] as const;
export const runtimeWorkspaceStageSourceKindValues = ["host"] as const;
export const runtimeWorkspaceStagingStatusValues = [
  "none",
  "preparing",
  "ready",
  "committing",
  "conflict",
  "committed",
  "discarded",
  "failed",
] as const;

export const runtimeSessionStateSchema = z.enum(runtimeSessionStateValues);
export const runtimeWorkspaceModeSchema = z.enum(runtimeWorkspaceModeValues);
export const runtimeWorkspaceStageTransportSchema = z.enum(runtimeWorkspaceStageTransportValues);
export const runtimeWorkspaceStagingStatusSchema = z.enum(runtimeWorkspaceStagingStatusValues);

export const runtimeEnvRefSchema = z.object({
  name: nonEmptyStringSchema,
  ref: nonEmptyStringSchema,
});

export const runtimeSecretRefSchema = z.object({
  name: nonEmptyStringSchema,
  secret_ref: nonEmptyStringSchema,
});

export const runtimeWorkspaceRefSchema = z.object({
  kind: nonEmptyStringSchema,
  reference: nonEmptyStringSchema.optional(),
  paths: z.array(nonEmptyStringSchema).default([]),
});

export const runtimeNetworkPolicySchema = z.object({
  internet_access: z.boolean().default(false),
  ingress: z.enum(["none", "private", "public"]).default("none"),
});

export const runtimeResourceHintsSchema = z.object({
  cpu_cores: positiveIntegerSchema.optional(),
  memory_mb: positiveIntegerSchema.optional(),
  disk_mb: positiveIntegerSchema.optional(),
  metadata: jsonObjectSchema.default({}),
});

export const runtimeTimeoutRulesSchema = z.object({
  soft_ms: positiveIntegerSchema.optional(),
  hard_ms: positiveIntegerSchema.optional(),
});

export const runtimeArtifactRulesSchema = z.object({
  capture_paths: z.array(nonEmptyStringSchema).default([]),
  push_on_completion: z.boolean().default(false),
  metadata: jsonObjectSchema.default({}),
});

export const runtimeWorkspaceStageSpecSchema = z.object({
  source_kind: z.literal(runtimeWorkspaceStageSourceKindValues[0]),
  paths: z.array(nonEmptyStringSchema).min(1),
  mode: z.enum(["read_only", "read_write"]),
  transport: runtimeWorkspaceStageTransportSchema.default("auto"),
});

export const workspaceCommitResultSchema = z.object({
  session_id: nonEmptyStringSchema,
  status: z.enum(["committed", "conflict", "rejected"]),
  written_paths: z.array(nonEmptyStringSchema).default([]),
  deleted_paths: z.array(nonEmptyStringSchema).default([]),
  conflict_paths: z.array(nonEmptyStringSchema).default([]),
});

export const runtimeSessionCreateInputSchema = z.object({
  preset_id: nonEmptyStringSchema.optional(),
  required_capabilities: runtimeCapabilitySetSchema.optional(),
  workspace_ref: runtimeWorkspaceRefSchema.optional(),
  workspace_stage: runtimeWorkspaceStageSpecSchema.optional(),
  workspace_mode: runtimeWorkspaceModeSchema.default("none"),
  network_policy: runtimeNetworkPolicySchema.default({
    internet_access: false,
    ingress: "none",
  }),
  resource_hints: runtimeResourceHintsSchema.default({ metadata: {} }),
  persistence_mode: runtimeSessionModeSchema.default(runtimeSessionModeValues[0]),
  env_refs: z.array(runtimeEnvRefSchema).default([]),
  secret_refs: z.array(runtimeSecretRefSchema).default([]),
  timeout_rules: runtimeTimeoutRulesSchema.default({}),
  artifact_rules: runtimeArtifactRulesSchema.default({
    capture_paths: [],
    push_on_completion: false,
    metadata: {},
  }),
});

export type RuntimeSessionCreateInput = z.infer<typeof runtimeSessionCreateInputSchema>;
export type RuntimeSessionState = z.infer<typeof runtimeSessionStateSchema>;
export type RuntimeWorkspaceMode = z.infer<typeof runtimeWorkspaceModeSchema>;
export type RuntimeWorkspaceRef = z.infer<typeof runtimeWorkspaceRefSchema>;
export type RuntimeWorkspaceStageSpec = z.infer<typeof runtimeWorkspaceStageSpecSchema>;
export type RuntimeWorkspaceStageTransport = z.infer<typeof runtimeWorkspaceStageTransportSchema>;
export type RuntimeWorkspaceStagingStatus = z.infer<typeof runtimeWorkspaceStagingStatusSchema>;
export type WorkspaceCommitResult = z.infer<typeof workspaceCommitResultSchema>;
