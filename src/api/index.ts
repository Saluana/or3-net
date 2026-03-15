/**
 * @module src/api/index
 *
 * Purpose:
 * Shared API metadata contracts and helper re-exports used by the OR3 Net HTTP
 * layer.
 */
/**
 * Purpose:
 * Lightweight description of a registered API route for discovery and docs.
 */
export interface RouteDescriptor {
  readonly method: string;
  readonly path: string;
  readonly summary: string;
}

export * from "./response-helpers.ts";