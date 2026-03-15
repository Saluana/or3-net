/**
 * @module src/db/event-retention
 *
 * Purpose:
 * Shared append-and-trim helpers for bounded retained event tables.
 *
 * Responsibilities:
 * - Allocate monotonic per-entity event sequence numbers
 * - Enforce bounded retention by trimming older rows after insert
 * - Sanitize event payloads so diagnostic writes stay JSON-safe and size-bounded
 *
 * Non-responsibilities:
 * - Does not define event schemas
 * - Does not choose table-specific SQL; callers supply those details
 *
 * @remarks
 * Internal API. Exported for reuse by multiple database modules after the DB
 * client split.
 */
import type { Database, SQLQueryBindings } from "bun:sqlite";

import { fromIsoDateTime } from "../lib/time.ts";

const createEventId = (): string => `evt_${crypto.randomUUID().replace(/-/g, "")}`;

/**
 * Purpose:
 * Configuration bundle for appending into a bounded retained-event table.
 *
 * Behavior:
 * Callers provide the SQL fragments and row-specific parameter mapping while the
 * helper manages sequencing, payload sanitization, and trimming.
 *
 * Constraints:
 * - `selectLatestSequenceSql` and `trimSql` must operate on the same logical key
 * - `retention` is count-based, not time-based
 */
export interface AppendRetainedEventOptions {
  readonly db: Database;
  readonly workspaceId: string;
  readonly keyValue: string;
  readonly retention: number;
  readonly createdAt: string | undefined;
  readonly payload: Record<string, unknown>;
  readonly selectLatestSequenceSql: string;
  readonly insertSql: string;
  readonly insertParams: (
    eventId: string,
    nextSequence: number,
    payloadJson: string,
    createdAtMs: number,
  ) => readonly SQLQueryBindings[];
  readonly trimSql: string;
  readonly trimParams: (cutoffSequence: number) => readonly SQLQueryBindings[];
  readonly selectByIdSql: string;
  readonly parseErrorLabel: string;
}

/**
 * Purpose:
 * Appends an event row, trims older retained rows, and returns the stored row.
 *
 * Behavior:
 * Runs inside a single SQLite transaction so sequence allocation and trimming
 * remain atomic for a workspace/key pair.
 *
 * Constraints:
 * - Caller-provided SQL must scope all operations to the same workspace/key
 * - Payloads are sanitized before storage, so the stored JSON is diagnostic and
 *   bounded rather than a byte-for-byte mirror of the original object
 *
 * Non-Goals:
 * - Does not parse the returned row into a domain-specific shape
 */
export const appendRetainedEvent = (options: AppendRetainedEventOptions): unknown => {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const eventId = createEventId();
  const payloadJson = sanitizePayloadJson(options.payload);
  const createdAtMs = fromIsoDateTime(createdAt);

  const row = options.db.transaction(() => {
    const latestSequence = options.db
      .query<{ sequence: number }, [string, string]>(options.selectLatestSequenceSql)
      .get(options.workspaceId, options.keyValue)?.sequence ?? 0;
    const nextSequence = latestSequence + 1;

    options.db.prepare(options.insertSql).run(...options.insertParams(eventId, nextSequence, payloadJson, createdAtMs));

    const cutoffSequence = nextSequence - options.retention;
    if (cutoffSequence > 0) {
      options.db.prepare(options.trimSql).run(...options.trimParams(cutoffSequence));
    }

    return options.db
      .query<unknown, [string, string]>(options.selectByIdSql)
      .get(options.workspaceId, eventId);
  })();

  if (row === null) {
    throw new Error(`${options.parseErrorLabel} ${eventId} was not found in workspace ${options.workspaceId}`);
  }

  return row;
};

const sanitizePayloadJson = (payload: Record<string, unknown>): string => JSON.stringify(sanitizeValue(payload));

const sanitizeValue = (value: unknown, seen = new WeakSet<object>()): unknown => {
  if (typeof value === "string") {
    if (value.length > 2048) {
      return {
        _truncated: true,
        _original_length: value.length,
        value: value.slice(0, 2048),
      };
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (typeof value === "bigint" || typeof value === "symbol") {
    return value.toString();
  }
  if (typeof value === "undefined") {
    return "undefined";
  }
  if (typeof value === "function") {
    return `[function ${value.name || "anonymous"}]`;
  }
  if (typeof value !== "object") {
    return null;
  }
  if (seen.has(value)) {
    return {
      _circular: true,
    };
  }

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, 25).map((entry) => sanitizeValue(entry, seen));
      if (value.length > 25) {
        return {
          _truncated: true,
          _original_length: value.length,
          items,
        };
      }
      return items;
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const entries = keys.slice(0, 50).map((key) => [key, sanitizeValue(record[key], seen)] as const);
    const mapped = Object.fromEntries(entries);
    if (keys.length > 50) {
      return {
        _truncated: true,
        _original_length: keys.length,
        entries: mapped,
      };
    }
    return mapped;
  } finally {
    seen.delete(value);
  }
};
