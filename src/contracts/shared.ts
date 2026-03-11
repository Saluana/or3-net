import { z } from "zod";

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const nonEmptyStringSchema = z.string().trim().min(1);
export const isoDateTimeSchema = z.iso.datetime({ offset: true });
export const positiveIntegerSchema = z.number().int().positive();
export const nonNegativeIntegerSchema = z.number().int().nonnegative();

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

export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

export const serializeWithSchema = <TSchema extends z.ZodType>(
  schema: TSchema,
  value: z.input<TSchema>,
): string => JSON.stringify(schema.parse(value));

export const parseWithSchema = <TSchema extends z.ZodType>(
  schema: TSchema,
  payload: string,
): z.output<TSchema> => schema.parse(JSON.parse(payload) as unknown);

export const parseOptionalWithSchema = <TSchema extends z.ZodType>(
  schema: TSchema,
  payload: string | null,
): z.output<TSchema> | null => {
  if (payload === null) {
    return null;
  }

  return parseWithSchema(schema, payload);
};