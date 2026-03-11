import { z } from "zod";

import {
  isoDateTimeSchema,
  nonEmptyStringSchema,
  nonNegativeIntegerSchema,
} from "./shared.ts";

export const workspaceFileKindValues = ["file", "directory"] as const;
export const previewKindValues = ["static-site", "web-app", "dashboard", "artifact-preview"] as const;
export const previewDeliveryModeValues = [
  "embedded",
  "external",
  "embedded-preferred",
  "external-preferred",
] as const;
export const previewSourceTypeValues = ["files", "live-service"] as const;
export const previewStatusValues = ["ready", "pending", "revoked", "expired", "error"] as const;
export const launchModeHintValues = ["pane", "new_tab", "external_browser"] as const;

export const workspaceFileEntrySchema = z.object({
  workspace_id: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
  kind: z.enum(workspaceFileKindValues),
  size_bytes: nonNegativeIntegerSchema,
  mime_type: z.string().optional(),
  etag: z.string().optional(),
  modified_at: isoDateTimeSchema,
});

export const previewDescriptorSchema = z.object({
  preview_id: nonEmptyStringSchema,
  workspace_id: nonEmptyStringSchema,
  node_id: nonEmptyStringSchema.optional(),
  kind: z.enum(previewKindValues),
  delivery_mode: z.enum(previewDeliveryModeValues),
  source_type: z.enum(previewSourceTypeValues),
  path: nonEmptyStringSchema.optional(),
  port: nonNegativeIntegerSchema.optional(),
  entry_path: nonEmptyStringSchema.optional(),
  service_id: nonEmptyStringSchema.optional(),
  status: z.enum(previewStatusValues),
  embed_url: z.url().optional(),
  launch_url: z.url().optional(),
  expires_at: isoDateTimeSchema.optional(),
  supports_iframe: z.boolean(),
  supports_new_tab: z.boolean(),
});

export const previewLaunchRequestSchema = z.object({
  launch_mode_hint: z.enum(launchModeHintValues).optional(),
  path_hint: nonEmptyStringSchema.optional(),
});

export const previewLaunchMetadataSchema = z.object({
  preview_id: nonEmptyStringSchema,
  workspace_id: nonEmptyStringSchema,
  launch_url: z.url(),
  embed_url: z.url().optional(),
  delivery_mode: z.enum(previewDeliveryModeValues),
  supports_iframe: z.boolean(),
  supports_new_tab: z.boolean(),
  reused_tunnel: z.boolean().default(false),
  service_status: z.enum(previewStatusValues),
  expires_at: isoDateTimeSchema,
});

export type PreviewDescriptor = z.infer<typeof previewDescriptorSchema>;
export type PreviewLaunchMetadata = z.infer<typeof previewLaunchMetadataSchema>;
export type PreviewLaunchRequest = z.infer<typeof previewLaunchRequestSchema>;
export type WorkspaceFileEntry = z.infer<typeof workspaceFileEntrySchema>;