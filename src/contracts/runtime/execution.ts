import { z } from "zod";

import { jsonObjectSchema, nonEmptyStringSchema, nonNegativeIntegerSchema, positiveIntegerSchema } from "../shared.ts";
import { runtimeArtifactDescriptorSchema } from "./artifacts.ts";

export const runtimeExecutionRequestSchema = z.object({
  command: nonEmptyStringSchema,
  args: z.array(z.string()).default([]),
  cwd: nonEmptyStringSchema.optional(),
  env: z.record(z.string(), z.string()).default({}),
  timeout_ms: positiveIntegerSchema.optional(),
  stdin: z.string().optional(),
  background: z.boolean().default(false),
});

export const runtimeExecutionStdoutEventSchema = z.object({
  type: z.literal("stdout"),
  chunk: z.string(),
});

export const runtimeExecutionStderrEventSchema = z.object({
  type: z.literal("stderr"),
  chunk: z.string(),
});

export const runtimeExecutionExitEventSchema = z.object({
  type: z.literal("exit"),
  exit_code: nonNegativeIntegerSchema,
  signal: z.string().optional(),
});

export const runtimeExecutionEventSchema = z.discriminatedUnion("type", [
  runtimeExecutionStdoutEventSchema,
  runtimeExecutionStderrEventSchema,
  runtimeExecutionExitEventSchema,
]);

export const runtimeExecutionResultSchema = z.object({
  exit_code: nonNegativeIntegerSchema,
  stdout: z.string().default(""),
  stderr: z.string().default(""),
  artifacts: z.array(runtimeArtifactDescriptorSchema).default([]),
  meta: jsonObjectSchema.default({}),
});

export const runtimeExecutionAbortResultSchema = z.object({
  acknowledged: z.boolean(),
  message: z.string().optional(),
});

export type RuntimeExecutionRequest = z.infer<typeof runtimeExecutionRequestSchema>;
export type RuntimeExecutionEvent = z.infer<typeof runtimeExecutionEventSchema>;
export type RuntimeExecutionResult = z.infer<typeof runtimeExecutionResultSchema>;
export type RuntimeExecutionAbortResult = z.infer<typeof runtimeExecutionAbortResultSchema>;

export interface RuntimeExecutionHandle {
  execution_id: string;
  stream?: AsyncIterable<RuntimeExecutionEvent>;
  result: Promise<RuntimeExecutionResult>;
  abort(): Promise<RuntimeExecutionAbortResult>;
}
