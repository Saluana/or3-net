import { z } from "zod";

import { jobErrorSchema, jobResultSchema } from "../core.ts";
import { isoDateTimeSchema, jsonObjectSchema, nonEmptyStringSchema } from "../shared.ts";
import { errorEnvelopeSchema } from "./types.ts";

export const platformStreamEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("job.accepted"),
    data: z.object({ job_id: nonEmptyStringSchema }),
  }),
  z.object({
    event: z.literal("job.started"),
    data: z.object({
      job_id: nonEmptyStringSchema,
      started_at: isoDateTimeSchema.optional(),
    }),
  }),
  z.object({
    event: z.literal("text.delta"),
    data: z.object({ text: z.string() }),
  }),
  z.object({
    event: z.literal("tool.call"),
    data: z.object({
      name: nonEmptyStringSchema,
      tool_call_id: nonEmptyStringSchema.optional(),
      arguments: z.union([z.string(), jsonObjectSchema]).optional(),
    }),
  }),
  z.object({
    event: z.literal("tool.result"),
    data: z.object({
      name: nonEmptyStringSchema,
      tool_call_id: nonEmptyStringSchema.optional(),
      result: z.union([z.string(), jsonObjectSchema]).optional(),
      content: z.string().optional(),
    }),
  }),
  z.object({
    event: z.literal("job.completed"),
    data: jobResultSchema.extend({
      job_id: nonEmptyStringSchema.optional(),
    }),
  }),
  z.object({
    event: z.literal("job.failed"),
    data: z.union([
      jobErrorSchema,
      errorEnvelopeSchema,
    ]),
  }),
  z.object({
    event: z.literal("job.aborted"),
    data: z.object({ job_id: nonEmptyStringSchema }),
  }),
  z.object({
    event: z.literal("error"),
    data: errorEnvelopeSchema,
  }),
]);

export type PlatformStreamEvent = z.infer<typeof platformStreamEventSchema>;
