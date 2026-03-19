/**
 * @module src/contracts/runtime/capabilities
 *
 * Purpose:
 * Defines the normalized runtime capability vocabulary used by adapters,
 * manifests, and selection logic.
 *
 * Constraints:
 * - Core capabilities use stable literals
 * - Extension capabilities must follow the `ext:<namespace>:<name>` pattern
 */
import { z } from "zod";

/** Purpose: Stable built-in runtime capability values recognized by OR3 Net. */
export const runtimeCoreCapabilityValues = [
  "exec",
  "stop",
  "resume",
  "copy-in",
  "copy-out",
  "file-browse",
  "file-rw",
  "workspace-materialize",
  "log-stream",
  "service-expose",
  "snapshot",
  "artifact-push",
  "internet",
  "public-ingress",
  "persistent-session",
  "browser",
  "package-install",
  "secret-inject",
  "workspace-write",
] as const;

/**
 * Purpose:
 * Human guidance for capabilities that have non-obvious semantics or layering
 * boundaries.
 */
export const runtimeCapabilityNotes = {
  "workspace-materialize":
    "Stages selected workspace content into a runtime session. Host root resolution and explicit commit semantics stay in the host-workspace-staging layer.",
  "ext:or3:pty":
    "Interactive terminal access for runtime sessions. Implementations may project this over a native PTY or a remote terminal transport.",
} as const;

/** Purpose: Namespaced runtime capability used for interactive PTY access. */
export const runtimePtyCapability = "ext:or3:pty" as const;

const runtimeExtensionCapabilityPattern = /^ext:[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/;

/** Purpose: Schema for built-in runtime capabilities. */
export const runtimeCoreCapabilitySchema = z.enum(runtimeCoreCapabilityValues);
/** Purpose: Schema for extension-defined runtime capabilities. */
export const runtimeExtensionCapabilitySchema = z.string().regex(runtimeExtensionCapabilityPattern);
/** Purpose: Union of built-in and extension-defined runtime capabilities. */
export const runtimeCapabilitySchema = z.union([
  runtimeCoreCapabilitySchema,
  runtimeExtensionCapabilitySchema,
]);

export type RuntimeCapability = z.infer<typeof runtimeCapabilitySchema>;

/**
 * Purpose:
 * Ordered set-like container for runtime capabilities.
 *
 * Behavior:
 * Deduplicates input values while preserving insertion order so manifests remain
 * predictable when serialized back to arrays.
 */
export class RuntimeCapabilitySet extends Array<RuntimeCapability> {
  static fromValues(values: Iterable<RuntimeCapability>): RuntimeCapabilitySet {
    return new RuntimeCapabilitySet(...new Set(values));
  }

  has(capability: RuntimeCapability): boolean {
    return this.includes(capability);
  }

  hasAll(required: Iterable<RuntimeCapability>): boolean {
    return Array.from(required).every((capability) => this.includes(capability));
  }
}

/**
 * Purpose:
 * Schema that normalizes capability arrays into a deduplicated
 * `RuntimeCapabilitySet`.
 */
export const runtimeCapabilitySetSchema = z
  .array(runtimeCapabilitySchema)
  .transform((capabilities) => RuntimeCapabilitySet.fromValues(capabilities));
