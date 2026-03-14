import { z } from "zod";

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

export const runtimeCapabilityNotes = {
  "workspace-materialize":
    "Stages selected workspace content into a runtime session. Host root resolution and explicit commit semantics stay in the host-workspace-staging layer.",
} as const;

const runtimeExtensionCapabilityPattern = /^ext:[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/;

export const runtimeCoreCapabilitySchema = z.enum(runtimeCoreCapabilityValues);
export const runtimeExtensionCapabilitySchema = z.string().regex(runtimeExtensionCapabilityPattern);
export const runtimeCapabilitySchema = z.union([
  runtimeCoreCapabilitySchema,
  runtimeExtensionCapabilitySchema,
]);

export type RuntimeCapability = z.infer<typeof runtimeCapabilitySchema>;

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

export const runtimeCapabilitySetSchema = z
  .array(runtimeCapabilitySchema)
  .transform((capabilities) => RuntimeCapabilitySet.fromValues(capabilities));
