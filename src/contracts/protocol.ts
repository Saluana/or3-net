import { z } from "zod";

import { jobErrorSchema, jobResultSchema, nodeManifestSchema, taskPackageSchema } from "./core.ts";
import { nonEmptyStringSchema, nonNegativeIntegerSchema } from "./shared.ts";

export const executionProgressSchema = z.object({
  percent: nonNegativeIntegerSchema.max(100),
  message: nonEmptyStringSchema,
});

export const nodeRequestSchema = z.discriminatedUnion("method", [
  z.object({
    id: nonEmptyStringSchema,
    method: z.literal("handshake"),
    params: nodeManifestSchema,
  }),
  z.object({
    id: nonEmptyStringSchema,
    method: z.literal("execute"),
    params: taskPackageSchema,
  }),
  z.object({
    id: nonEmptyStringSchema,
    method: z.literal("heartbeat"),
  }),
  z.object({
    id: nonEmptyStringSchema,
    method: z.literal("abort"),
    params: z.object({
      job_id: nonEmptyStringSchema,
    }),
  }),
]);

export const nodeResponseSchema = z.union([
  z.object({
    id: nonEmptyStringSchema,
    result: jobResultSchema,
  }),
  z.object({
    id: nonEmptyStringSchema,
    error: jobErrorSchema,
  }),
]);

export const nodeEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("output"),
    data: z.object({
      text: z.string(),
    }),
  }),
  z.object({
    event: z.literal("tool_call"),
    data: z.object({
      name: nonEmptyStringSchema,
      params: z.record(z.string(), z.unknown()),
    }),
  }),
  z.object({
    event: z.literal("tool_result"),
    data: z.object({
      name: nonEmptyStringSchema,
      result: z.string(),
    }),
  }),
  z.object({
    event: z.literal("progress"),
    data: executionProgressSchema,
  }),
  z.object({
    event: z.literal("complete"),
    data: jobResultSchema,
  }),
  z.object({
    event: z.literal("error"),
    data: jobErrorSchema,
  }),
]);

export const jobStreamEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("job.accepted"), data: z.object({ job_id: nonEmptyStringSchema }) }),
  z.object({ event: z.literal("job.started"), data: z.object({ job_id: nonEmptyStringSchema }) }),
  z.object({ event: z.literal("text.delta"), data: z.object({ text: z.string() }) }),
  z.object({ event: z.literal("tool.call"), data: z.object({ name: nonEmptyStringSchema }) }),
  z.object({ event: z.literal("tool.result"), data: z.object({ name: nonEmptyStringSchema, result: z.string() }) }),
  z.object({ event: z.literal("job.completed"), data: jobResultSchema }),
  z.object({ event: z.literal("job.aborted"), data: z.object({ job_id: nonEmptyStringSchema }) }),
  z.object({ event: z.literal("job.failed"), data: jobErrorSchema }),
]);

export type JobStreamEvent = z.infer<typeof jobStreamEventSchema>;
export type NodeEvent = z.infer<typeof nodeEventSchema>;
export type NodeRequest = z.infer<typeof nodeRequestSchema>;
export type NodeResponse = z.infer<typeof nodeResponseSchema>;