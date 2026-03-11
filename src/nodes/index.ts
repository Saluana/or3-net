export * from "./registry.ts";
export * from "./signatures.ts";
export * from "./executor.ts";
export * from "./transport.ts";
export * from "./transport-https.ts";
export * from "./transport-registry.ts";
export * from "./transport-wss.ts";

export interface NodeTransport {
  readonly kind: "https" | "outbound-wss";
}