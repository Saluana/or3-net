/**
 * @module src/contracts/runtime/artifacts
 *
 * Purpose:
 * Artifact descriptor contract for files produced within runtime sessions.
 */
import { z } from "zod";

import { jsonObjectSchema, nonEmptyStringSchema, nonNegativeIntegerSchema } from "../shared.ts";

/**
 * Purpose:
 * Metadata for an artifact emitted or uploaded by a runtime session.
 */
export const runtimeArtifactDescriptorSchema = z.object({
  artifact_id: nonEmptyStringSchema,
  session_id: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
  kind: nonEmptyStringSchema,
  content_type: nonEmptyStringSchema,
  size_bytes: nonNegativeIntegerSchema,
  source: jsonObjectSchema.default({}),
});

export type RuntimeArtifactDescriptor = z.infer<typeof runtimeArtifactDescriptorSchema>;
