/**
 * @module src/contracts/runtime/manifest
 *
 * Purpose:
 * Contract for describing a runtime adapter's identity, trust posture, and
 * supported capabilities.
 */
import { z } from "zod";

import { nonEmptyStringSchema } from "../shared.ts";
import { runtimeCapabilitySetSchema } from "./capabilities.ts";

/** Purpose: Stable adapter-kind literals understood by runtime selection. */
export const runtimeAdapterKindValues = [
  "sandbox",
  "remote",
  "local",
  "fly",
  "cloudflare",
  "ssh-vm",
  "akash",
] as const;
/** Purpose: Trust tiers surfaced to scheduling and policy decisions. */
export const runtimeTrustTierValues = [
  "production",
  "staging",
  "development",
  "untrusted",
] as const;
/** Purpose: Locality values describing where runtime execution occurs. */
export const runtimeLocalityValues = ["local", "remote", "hybrid"] as const;
/** Purpose: Runtime session persistence modes. */
export const runtimeSessionModeValues = ["ephemeral", "persistent"] as const;

const runtimeVersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/);

export const runtimeAdapterKindSchema = z.enum(runtimeAdapterKindValues);
export const runtimeTrustTierSchema = z.enum(runtimeTrustTierValues);
export const runtimeLocalitySchema = z.enum(runtimeLocalityValues);
export const runtimeSessionModeSchema = z.enum(runtimeSessionModeValues);

/**
 * Purpose:
 * Canonical manifest published by a runtime adapter implementation.
 */
export const runtimeAdapterManifestSchema = z.object({
  adapter_id: nonEmptyStringSchema,
  display_name: nonEmptyStringSchema,
  version: runtimeVersionSchema,
  adapter_kind: runtimeAdapterKindSchema,
  isolation_class: nonEmptyStringSchema,
  trust_tier: runtimeTrustTierSchema,
  locality: runtimeLocalitySchema,
  capabilities: runtimeCapabilitySetSchema,
  supported_presets: z.array(nonEmptyStringSchema).default([]),
  session_modes: z.array(runtimeSessionModeSchema).min(1),
});

export type RuntimeAdapterManifest = z.infer<typeof runtimeAdapterManifestSchema>;
export type RuntimeAdapterKind = z.infer<typeof runtimeAdapterKindSchema>;
export type RuntimeTrustTier = z.infer<typeof runtimeTrustTierSchema>;
export type RuntimeLocality = z.infer<typeof runtimeLocalitySchema>;
export type RuntimeSessionMode = z.infer<typeof runtimeSessionModeSchema>;
