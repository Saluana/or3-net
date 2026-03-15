/**
 * @module src/contracts/core
 *
 * Purpose:
 * Canonical control-plane contracts for jobs, leases, agents, workspaces, and
 * related policy objects. These schemas define the stable wire surface shared by
 * the API, persistence layer, and runtime adapters.
 *
 * Constraints:
 * - Field names remain snake_case to match stored rows and API payloads
 * - Zod defaults are part of the contract, not just implementation detail
 */
import { z } from "zod";

import {
  isoDateTimeSchema,
  jsonObjectSchema,
  nonEmptyStringSchema,
  nonNegativeIntegerSchema,
  positiveIntegerSchema,
} from "./shared.ts";

/** Purpose: Supported runtime adapter kinds. */
export const adapterKindValues = ["local", "remote", "sandbox"] as const;
/** Purpose: Supported node transport channels. */
export const transportKindValues = ["https", "outbound-wss"] as const;
export const resetMethodValues = [
  "process_kill",
  "fs_scrub",
  "credential_rotation",
] as const;
export const leaseStateValues = ["active", "expired", "released", "failed"] as const;
export const jobStatusValues = [
  "pending",
  "scheduled",
  "running",
  "completed",
  "failed",
  "aborted",
] as const;
export const nodeApprovalStatusValues = ["pending", "approved", "revoked"] as const;
export const nodeHealthStatusValues = ["unknown", "healthy", "degraded", "stale"] as const;
export const toolPolicyModeValues = ["allow_all", "deny_all", "allow_list", "deny_list"] as const;
export const adapterKindSchema = z.enum(adapterKindValues);
export const transportKindSchema = z.enum(transportKindValues);
export const resetMethodSchema = z.enum(resetMethodValues);
export const leaseStateSchema = z.enum(leaseStateValues);
export const jobStatusSchema = z.enum(jobStatusValues);
export const nodeApprovalStatusSchema = z.enum(nodeApprovalStatusValues);
export const nodeHealthStatusSchema = z.enum(nodeHealthStatusValues);

/**
 * Purpose:
 * Describes how tool invocations are permitted or blocked for an agent or task.
 *
 * Constraints:
 * - `allow_list` requires at least one `allowed_tools` entry
 * - `deny_list` requires at least one `blocked_tools` entry
 */
export const toolPolicySchema = z
  .object({
    mode: z.enum(toolPolicyModeValues),
    allowed_tools: z.array(nonEmptyStringSchema).default([]),
    blocked_tools: z.array(nonEmptyStringSchema).default([]),
  })
  .superRefine((value, context) => {
    if (value.mode === "allow_list" && value.allowed_tools.length === 0) {
      context.addIssue({
        code: "custom",
        message: "allow_list policies must declare at least one allowed tool",
        path: ["allowed_tools"],
      });
    }

    if (value.mode === "deny_list" && value.blocked_tools.length === 0) {
      context.addIssue({
        code: "custom",
        message: "deny_list policies must declare at least one blocked tool",
        path: ["blocked_tools"],
      });
    }
  });

/**
 * Purpose:
 * Expresses node-selection hints used by scheduling and runtime selection.
 */
export const nodeRequirementsSchema = z.object({
  adapter_kind: adapterKindSchema.optional(),
  capabilities: z.array(nonEmptyStringSchema).default([]),
  isolation_class: nonEmptyStringSchema.optional(),
  preferred_node_ids: z.array(nonEmptyStringSchema).default([]),
});

/**
 * Purpose:
 * Signed capability and resource declaration published by a node.
 */
export const nodeManifestSchema = z.object({
  node_id: nonEmptyStringSchema,
  pubkey: nonEmptyStringSchema,
  signature: nonEmptyStringSchema,
  adapter_kind: adapterKindSchema,
  capabilities: z.array(nonEmptyStringSchema).min(1),
  isolation_class: nonEmptyStringSchema,
  supports_transports: z.array(transportKindSchema).min(1),
  resource_limits: z.object({
    max_concurrent_jobs: positiveIntegerSchema,
    cpu_cores: positiveIntegerSchema,
    memory_mb: positiveIntegerSchema,
    disk_mb: positiveIntegerSchema,
  }),
  lease_policy: z.object({
    max_ttl_seconds: positiveIntegerSchema,
    supports_warm_pool: z.boolean(),
    reset_methods: z.array(resetMethodSchema).min(1),
  }),
  certification: z
    .object({
      issuer: nonEmptyStringSchema,
      certificate: nonEmptyStringSchema,
      expires_at: isoDateTimeSchema,
    })
    .optional(),
  version: nonEmptyStringSchema,
});

/**
 * Purpose:
 * Portable artifact payload returned by jobs and runtime operations.
 *
 * Constraints:
 * - At least one content source must be provided
 */
export const artifactDescriptorSchema = z
  .object({
    artifact_id: nonEmptyStringSchema,
    path: nonEmptyStringSchema,
    kind: nonEmptyStringSchema,
    content_type: nonEmptyStringSchema,
    size_bytes: nonNegativeIntegerSchema,
    text: z.string().optional(),
    bytes_base64: z.string().optional(),
    source_url: z.url().optional(),
  })
  .refine(
    (value) => value.text !== undefined || value.bytes_base64 !== undefined || value.source_url !== undefined,
    {
      message: "artifact descriptors must provide inline text, bytes, or a source URL",
    },
  );

/** Purpose: Lease request profile used during node acquisition. */
export const leaseProfileSchema = z.object({
  profile_id: nonEmptyStringSchema,
  ttl_seconds: positiveIntegerSchema,
  isolation_class: nonEmptyStringSchema.optional(),
  required_capabilities: z.array(nonEmptyStringSchema).default([]),
});

/** Purpose: Limits how deeply jobs may spawn delegated subagents. */
export const subagentPolicySchema = z.object({
  enabled: z.boolean(),
  max_depth: nonNegativeIntegerSchema,
  max_jobs: nonNegativeIntegerSchema,
});

/**
 * Purpose:
 * Complete unit of work dispatched to a runtime node.
 */
export const taskPackageSchema = z.object({
  workspace_id: nonEmptyStringSchema,
  job_id: nonEmptyStringSchema,
  kind: nonEmptyStringSchema,
  instructions: nonEmptyStringSchema,
  artifacts: z.array(artifactDescriptorSchema).default([]),
  tool_policy: toolPolicySchema,
  timeout: z.object({
    soft_ms: positiveIntegerSchema,
    hard_ms: positiveIntegerSchema.optional(),
  }),
  lease_profile: leaseProfileSchema,
  subagent_policy: subagentPolicySchema,
  metadata: jsonObjectSchema.default({}),
});

/** Purpose: Active or historical node lease contract. */
export const leaseSchema = z.object({
  lease_id: nonEmptyStringSchema,
  node_id: nonEmptyStringSchema,
  profile: leaseProfileSchema,
  ttl: positiveIntegerSchema,
  reset_required: z.boolean(),
  state: leaseStateSchema,
});

/** Purpose: Structured successful job output payload. */
export const jobResultSchema = z.object({
  output_text: z.string().optional(),
  artifacts: z.array(artifactDescriptorSchema).default([]),
  meta: jsonObjectSchema.default({}),
});

/** Purpose: Structured failed job payload surfaced over APIs and streams. */
export const jobErrorSchema = z.object({
  code: nonEmptyStringSchema,
  message: nonEmptyStringSchema,
  retriable: z.boolean().default(false),
  details: jsonObjectSchema.default({}),
});

/** Purpose: Persisted job state exposed by the control plane. */
export const jobSchema = z.object({
  job_id: nonEmptyStringSchema,
  workspace_id: nonEmptyStringSchema,
  status: jobStatusSchema,
  node_id: nonEmptyStringSchema.optional(),
  created_at: isoDateTimeSchema,
  started_at: isoDateTimeSchema.optional(),
  completed_at: isoDateTimeSchema.optional(),
  result: jobResultSchema.optional(),
  error: jobErrorSchema.optional(),
});

/** Purpose: Saved reusable agent definition bound to a workspace. */
export const agentSchema = z.object({
  agent_id: nonEmptyStringSchema,
  workspace_id: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  instructions: nonEmptyStringSchema,
  tool_policy: toolPolicySchema,
  node_requirements: nodeRequirementsSchema,
  created_at: isoDateTimeSchema.optional(),
  updated_at: isoDateTimeSchema.optional(),
});

/** Purpose: Workspace metadata known to the OR3 Net control plane. */
export const workspaceSchema = z.object({
  workspace_id: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema.optional(),
  config: jsonObjectSchema.optional(),
});

/** Purpose: Signed or minted auth token payload returned to API clients. */
export const authTokenSchema = z.object({
  token: nonEmptyStringSchema,
  workspace_id: nonEmptyStringSchema,
  expires_at: isoDateTimeSchema,
  scopes: z.array(nonEmptyStringSchema).min(1),
});

export type AdapterKind = z.infer<typeof adapterKindSchema>;
export type Agent = z.infer<typeof agentSchema>;
export type ArtifactDescriptor = z.infer<typeof artifactDescriptorSchema>;
export type AuthToken = z.infer<typeof authTokenSchema>;
export type Job = z.infer<typeof jobSchema>;
export type JobError = z.infer<typeof jobErrorSchema>;
export type JobResult = z.infer<typeof jobResultSchema>;
export type Lease = z.infer<typeof leaseSchema>;
export type LeaseProfile = z.infer<typeof leaseProfileSchema>;
export type NodeHealthStatus = z.infer<typeof nodeHealthStatusSchema>;
export type NodeApprovalStatus = z.infer<typeof nodeApprovalStatusSchema>;
export type NodeManifest = z.infer<typeof nodeManifestSchema>;
export type NodeRequirements = z.infer<typeof nodeRequirementsSchema>;
export type TaskPackage = z.infer<typeof taskPackageSchema>;
export type ToolPolicy = z.infer<typeof toolPolicySchema>;
export type Workspace = z.infer<typeof workspaceSchema>;