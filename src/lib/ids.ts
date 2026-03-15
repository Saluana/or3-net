/**
 * @module src/lib/ids
 *
 * Purpose:
 * Generates OR3-style identifiers with stable, human-recognizable prefixes.
 */
/**
 * Purpose:
 * Creates a random identifier in the `<prefix>_<uuid>` format used across OR3
 * control-plane records.
 *
 * Constraints:
 * - Uses `crypto.randomUUID()` for randomness
 * - Removes hyphens to keep ids compact and transport-friendly
 */
export const createId = (prefix: string): string => {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  return `${prefix}_${suffix}`;
};