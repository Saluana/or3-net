/**
 * @module src/contracts/runtime/descriptors
 *
 * Purpose:
 * Descriptor contracts used to report runtime health, available nodes, and live
 * session state back to the control plane and API consumers.
 */
import { z } from "zod";

import { isoDateTimeSchema, nonEmptyStringSchema, positiveIntegerSchema } from "../shared.ts";
import { runtimeCapabilitySetSchema } from "./capabilities.ts";
import { runtimeErrorEnvelopeSchema } from "./errors.ts";
import {
  runtimeAdapterManifestSchema,
  runtimeLocalitySchema,
  runtimeSessionModeSchema,
  runtimeTrustTierSchema,
} from "./manifest.ts";
import {
  runtimeSessionStateSchema,
  runtimeWorkspaceStageSpecSchema,
  runtimeWorkspaceStageTransportSchema,
  runtimeWorkspaceStagingStatusSchema,
  workspaceCommitResultSchema,
} from "./sessions.ts";

/** Purpose: Normalized health states reported by runtime adapters and nodes. */
export const runtimeHealthStatusValues = ["unknown", "healthy", "degraded", "unavailable"] as const;
export const runtimeHealthStatusSchema = z.enum(runtimeHealthStatusValues);

/** Purpose: Health snapshot for an adapter or node at a point in time. */
export const runtimeAdapterHealthSchema = z.object({
  status: runtimeHealthStatusSchema,
  message: z.string().optional(),
  checked_at: isoDateTimeSchema,
});

/** Purpose: Resource-limit metadata advertised by a node. */
export const runtimeResourceLimitsSchema = z.object({
  max_concurrent_execs: positiveIntegerSchema.optional(),
  cpu_cores: positiveIntegerSchema.optional(),
  memory_mb: positiveIntegerSchema.optional(),
  disk_mb: positiveIntegerSchema.optional(),
});

/** Purpose: High-level descriptor for a runtime adapter implementation. */
export const runtimeDescriptorSchema = z.object({
  adapter_id: runtimeAdapterManifestSchema.shape.adapter_id,
  display_name: runtimeAdapterManifestSchema.shape.display_name,
  isolation_class: runtimeAdapterManifestSchema.shape.isolation_class,
  trust_tier: runtimeTrustTierSchema,
  locality: runtimeLocalitySchema,
  health: runtimeAdapterHealthSchema,
  capabilities: runtimeCapabilitySetSchema,
  supported_presets: runtimeAdapterManifestSchema.shape.supported_presets,
  session_modes: z.array(runtimeSessionModeSchema).min(1),
});

/** Purpose: Per-node descriptor used for remote runtime inventory. */
export const runtimeNodeDescriptorSchema = z.object({
  node_id: nonEmptyStringSchema,
  runtime_id: nonEmptyStringSchema,
  health: runtimeAdapterHealthSchema,
  capabilities: runtimeCapabilitySetSchema,
  resource_limits: runtimeResourceLimitsSchema.default({}),
  locality: runtimeLocalitySchema,
});

/**
 * Purpose:
 * Control-plane view of a runtime session, including workspace staging and
 * commit metadata when applicable.
 */
export const runtimeSessionDescriptorSchema = z.object({
  session_id: nonEmptyStringSchema,
  workspace_id: nonEmptyStringSchema,
  adapter_id: nonEmptyStringSchema,
  node_id: nonEmptyStringSchema.optional(),
  status: runtimeSessionStateSchema,
  capabilities: runtimeCapabilitySetSchema,
  isolation_class: nonEmptyStringSchema,
  trust_tier: runtimeTrustTierSchema,
  preset_id: nonEmptyStringSchema.optional(),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
  destroyed_at: isoDateTimeSchema.optional(),
  workspace_stage: runtimeWorkspaceStageSpecSchema.optional(),
  host_workspace_root: nonEmptyStringSchema.optional(),
  workspace_stage_mode: z.enum(["read_only", "read_write"]).optional(),
  workspace_stage_transport: runtimeWorkspaceStageTransportSchema.optional(),
  staging_status: runtimeWorkspaceStagingStatusSchema.default("none"),
  last_commit: workspaceCommitResultSchema.optional(),
  error: runtimeErrorEnvelopeSchema.optional(),
});

export type RuntimeAdapterHealth = z.infer<typeof runtimeAdapterHealthSchema>;
export type RuntimeDescriptor = z.infer<typeof runtimeDescriptorSchema>;
export type RuntimeNodeDescriptor = z.infer<typeof runtimeNodeDescriptorSchema>;
export type RuntimeSessionDescriptor = z.infer<typeof runtimeSessionDescriptorSchema>;
