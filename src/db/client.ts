/**
 * @module src/db/client
 *
 * Purpose:
 * Compatibility facade for the OR3 Net control-plane database. The public API
 * remains stable while the implementation is split into smaller modules.
 */
export * from "./types.ts";
export * from "./workspace-store.ts";
export * from "./control-plane-database.ts";
