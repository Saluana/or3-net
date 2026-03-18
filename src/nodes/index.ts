/**
 * @module src/nodes/index
 *
 * Purpose:
 * Barrel export for node enrollment, transport, execution, and signature
 * helpers.
 */
export * from "./registry.ts";
export * from "./signatures.ts";
export * from "./executor.ts";
export * from "./execution-adapter.ts";
export * from "./adapter-opensandbox.ts";
export * from "./transport.ts";
export * from "./transport-https.ts";
export * from "./transport-registry.ts";
export * from "./transport-wss.ts";

/**
 * Purpose:
 * Minimal node transport descriptor shared by some higher-level wiring code.
 */
export interface NodeTransport {
  readonly kind: "https" | "outbound-wss";
}