/**
 * @module src/db/client
 *
 * Purpose:
 * Compatibility facade for the OR3 Net control-plane database. Keeps the
 * historical import path stable while the implementation lives in smaller,
 * responsibility-focused modules.
 *
 * Responsibilities:
 * - Re-export the public database types used by services and tests
 * - Re-export the workspace-scoped and top-level database entry points
 * - Preserve downstream imports during internal refactors
 *
 * Non-responsibilities:
 * - Does not contain persistence logic or SQL
 * - Does not define stored row shapes; see `schema.ts`
 *
 * @remarks
 * Prefer importing from `src/db/index.ts` at package boundaries. This module
 * exists primarily to preserve compatibility for existing direct imports.
 */
export * from "./types.ts";
export * from "./workspace-store.ts";
export * from "./control-plane-database.ts";
