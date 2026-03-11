import type { NodeRequest, NodeResponse } from "../contracts/index.ts";

export interface NodeRpcTransport {
  readonly kind: "https" | "outbound-wss";
  request(request: NodeRequest): Promise<NodeResponse>;
  stream(request: NodeRequest): AsyncIterable<Record<string, unknown>>;
}