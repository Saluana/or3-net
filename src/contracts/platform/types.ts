import { z } from "zod";

import {
  isoDateTimeSchema,
  jsonObjectSchema,
  nonEmptyStringSchema,
  positiveIntegerSchema,
} from "../shared.ts";
import { platformErrorCodes } from "./error-codes.ts";

export const workspacePrincipalSchema = z.object({
  subject: nonEmptyStringSchema,
  workspace_id: nonEmptyStringSchema,
  scopes: z.array(nonEmptyStringSchema).min(1),
  auth_type: z.enum(["workspace-token", "api-key"]),
  issued_at: positiveIntegerSchema,
  expires_at: positiveIntegerSchema,
});

export const platformSessionClientKindSchema = z.enum(["chat", "cli", "sdk", "console", "legacy"]);

export const platformSessionRefSchema = z.object({
  workspace_id: nonEmptyStringSchema,
  client_kind: platformSessionClientKindSchema,
  client_session_id: nonEmptyStringSchema,
  network_session_id: nonEmptyStringSchema,
  session_key: nonEmptyStringSchema,
});

export const capabilityGrantKindSchema = z.enum(["preview-launch", "service-launch", "tunnel-access", "file-download"]);

export const capabilityGrantSchema = z.object({
  capability_id: nonEmptyStringSchema,
  workspace_id: nonEmptyStringSchema,
  kind: capabilityGrantKindSchema,
  scope: jsonObjectSchema.default({}),
  expires_at: isoDateTimeSchema,
  revoked_at: isoDateTimeSchema.nullable(),
});

export const secretClassSchema = z.enum(["user-local", "control-plane", "service-bootstrap", "ephemeral-capability"]);

export const secretRefSchema = z.object({
  secret_id: nonEmptyStringSchema,
  class: secretClassSchema,
  owner_scope: nonEmptyStringSchema,
  created_at: isoDateTimeSchema,
  rotated_at: isoDateTimeSchema.nullable(),
});

export const platformErrorCodeSchema = z.enum(Object.values(platformErrorCodes));

export const errorEnvelopeSchema = z.object({
  error: nonEmptyStringSchema,
  code: platformErrorCodeSchema,
  status: positiveIntegerSchema,
  request_id: nonEmptyStringSchema,
  retry_after_ms: positiveIntegerSchema.optional(),
});

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
