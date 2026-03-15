/**
 * @module src/lib/time
 *
 * Purpose:
 * Small time-format helpers shared by persistence and contract code.
 */
/**
 * Purpose:
 * Converts a millisecond timestamp into an ISO-8601 UTC string suitable for OR3
 * wire contracts and stored rows.
 */
export const toIsoDateTime = (timestampMs: number): string => new Date(timestampMs).toISOString();
/**
 * Purpose:
 * Parses an ISO-8601 timestamp string into Unix milliseconds.
 *
 * Constraints:
 * - Returns `NaN` for invalid input because it delegates to `Date.parse()`
 */
export const fromIsoDateTime = (timestamp: string): number => Date.parse(timestamp);