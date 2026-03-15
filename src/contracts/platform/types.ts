/**
 * @module src/contracts/platform/types
 *
 * Purpose:
 * Platform-scoped identity, capability, audit, and error-envelope contracts
 * shared by OR3 Net APIs.
 *
 * Constraints:
 * - These schemas define the external surface consumed by clients
 * - Field names stay in snake_case to match API payloads and stored rows
 */
import { z } from "zod";

import {
  isoDateTimeSchema,
  jsonObjectSchema,
  nonEmptyStringSchema,
  positiveIntegerSchema,
} from "../shared.ts";
import { platformErrorCodes } from "./error-codes.ts";

/** Purpose: Authenticated caller identity after OR3 bearer-token resolution. */
export const workspacePrincipalSchema = z.object({
  subject: nonEmptyStringSchema,
  workspace_id: nonEmptyStringSchema,
  scopes: z.array(nonEmptyStringSchema).min(1),
  auth_type: z.enum(["workspace-token", "api-key"]),
  issued_at: positiveIntegerSchema,
  expires_at: positiveIntegerSchema,
});

/** Purpose: Supported client kinds that can own a platform session. */
export const platformSessionClientKindSchema = z.enum(["chat", "cli", "sdk", "console", "legacy"]);

/**
 * Purpose:
 * Stable session reference handed back to clients so future calls can be bound
 * to the same network session.
 */
export const platformSessionRefSchema = z.object({
  workspace_id: nonEmptyStringSchema,
  client_kind: platformSessionClientKindSchema,
  client_session_id: nonEmptyStringSchema,
  network_session_id: nonEmptyStringSchema,
  session_key: nonEmptyStringSchema,
});

/** Purpose: Capability-grant categories surfaced to clients. */
export const capabilityGrantKindSchema = z.enum(["preview-launch", "service-launch", "tunnel-access", "file-download"]);

/** Purpose: Time-bounded delegated capability grant. */
export const capabilityGrantSchema = z.object({
  capability_id: nonEmptyStringSchema,
  workspace_id: nonEmptyStringSchema,
  kind: capabilityGrantKindSchema,
  scope: jsonObjectSchema.default({}),
  expires_at: isoDateTimeSchema,
  revoked_at: isoDateTimeSchema.nullable(),
});

/** Purpose: Classification for secrets managed by the platform. */
export const secretClassSchema = z.enum(["user-local", "control-plane", "service-bootstrap", "ephemeral-capability"]);

/** Purpose: Metadata reference for a managed secret without exposing the value. */
export const secretRefSchema = z.object({
  secret_id: nonEmptyStringSchema,
  class: secretClassSchema,
  owner_scope: nonEmptyStringSchema,
  created_at: isoDateTimeSchema,
  rotated_at: isoDateTimeSchema.nullable(),
});

/** Purpose: Schema view of the canonical platform error-code set. */
export const platformErrorCodeSchema = z.enum(Object.values(platformErrorCodes));

/**
 * Purpose:
 * Standard machine-readable error envelope returned by OR3 Net APIs.
 */
export const errorEnvelopeSchema = z.object({
  error: nonEmptyStringSchema,
  code: platformErrorCodeSchema,
  status: positiveIntegerSchema,
  request_id: nonEmptyStringSchema,
  retry_after_ms: positiveIntegerSchema.optional(),
});

/**
 * Purpose:
 * Audit metadata captured alongside requests and execution events.
 */
export const auditContextSchema = z.object({
  request_id: nonEmptyStringSchema,
  workspace_id: nonEmptyStringSchema,
  subject: nonEmptyStringSchema,
  network_session_id: nonEmptyStringSchema.optional(),
  job_id: nonEmptyStringSchema.optional(),
  session_key: nonEmptyStringSchema.optional(),
  sandbox_id: nonEmptyStringSchema.optional(),
});

export type AuditContext = z.infer<typeof auditContextSchema>;
export type CapabilityGrant = z.infer<typeof capabilityGrantSchema>;
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
export type PlatformSessionRef = z.infer<typeof platformSessionRefSchema>;
export type SecretRef = z.infer<typeof secretRefSchema>;
export type WorkspacePrincipalContract = z.infer<typeof workspacePrincipalSchema>;
