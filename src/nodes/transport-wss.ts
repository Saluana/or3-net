import type { NodeRequest, NodeResponse } from "../contracts/index.ts";

import type { NodeRpcTransport } from "./transport.ts";

export class OutboundWssNodeTransport implements NodeRpcTransport {
  public readonly kind = "outbound-wss" as const;

  public constructor(private readonly handler: (request: NodeRequest) => Promise<NodeResponse>) {}

  public request(request: NodeRequest): Promise<NodeResponse> {
    return this.handler(request);
  }

  public async *stream(request: NodeRequest): AsyncIterable<Record<string, unknown>> {
    const response = await this.handler(request);
    yield response as unknown as Record<string, unknown>;
  }
}