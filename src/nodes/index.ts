export * from "./registry.ts";
export * from "./signatures.ts";
export * from "./transport.ts";
export * from "./transport-https.ts";
export * from "./transport-wss.ts";

export interface NodeTransport {
  readonly kind: "https" | "outbound-wss";
}