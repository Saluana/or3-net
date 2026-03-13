export interface RouteDescriptor {
  readonly method: string;
  readonly path: string;
  readonly summary: string;
}

export * from "./response-helpers.ts";