/**
 * @module src/contracts/shared
 *
 * Purpose:
 * Shared primitive schemas and serialization helpers used across OR3 Net
 * contract modules.
 *
 * Responsibilities:
 * - Define reusable JSON and scalar schema fragments
 * - Provide schema-backed serialization and parsing helpers
 *
 * Non-responsibilities:
 * - Does not define domain-specific platform or runtime payloads
 */
import { z } from "zod";

/**
 * Purpose:
 * JSON primitive subset accepted by OR3 contract helpers.
 */
export type JsonPrimitive = boolean | null | number | string;
/**
 * Purpose:
 * Recursive JSON value type used for contract metadata and generic payloads.
 */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** Purpose: Reusable schema for required trimmed strings. */
export const nonEmptyStringSchema = z.string().trim().min(1);
/** Purpose: ISO-8601 datetime schema with explicit timezone offset. */
export const isoDateTimeSchema = z.iso.datetime({ offset: true });
/** Purpose: Positive integer schema for counts, durations, and ids. */
export const positiveIntegerSchema = z.number().int().positive();
/** Purpose: Non-negative integer schema for counters and byte sizes. */
export const nonNegativeIntegerSchema = z.number().int().nonnegative();

/**
 * Purpose:
 * Recursive JSON schema for metadata blobs that must remain transport-safe.
 */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/** Purpose: JSON object schema backed by string keys and JSON values. */
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

/**
 * Purpose:
 * Validates a value with a schema before serializing it to JSON.
 */
export const serializeWithSchema = <TSchema extends z.ZodType>(
  schema: TSchema,
  value: z.input<TSchema>,
): string => JSON.stringify(schema.parse(value));

/**
 * Purpose:
 * Parses JSON text and validates the decoded value against the supplied schema.
 */
export const parseWithSchema = <TSchema extends z.ZodType>(
  schema: TSchema,
  payload: string,
): z.output<TSchema> => schema.parse(JSON.parse(payload) as unknown);

/**
 * Purpose:
 * Parses an optional JSON payload when present, preserving `null` inputs.
 */
export const parseOptionalWithSchema = <TSchema extends z.ZodType>(
  schema: TSchema,
  payload: string | null,
): z.output<TSchema> | null => {
  if (payload === null) {
    return null;
  }

  return parseWithSchema(schema, payload);
};