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

export const runtimeSessionStateSchema = z.enum(runtimeSessionStateValues);
export const runtimeWorkspaceModeSchema = z.enum(runtimeWorkspaceModeValues);

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

export const runtimeSessionCreateInputSchema = z.object({
  preset_id: nonEmptyStringSchema.optional(),
  required_capabilities: runtimeCapabilitySetSchema.optional(),
  workspace_ref: runtimeWorkspaceRefSchema.optional(),
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
