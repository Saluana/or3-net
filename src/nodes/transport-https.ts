import type { NodeRequest, NodeResponse } from "../contracts/index.ts";

import type { NodeRpcTransport } from "./transport.ts";

export class HttpsNodeTransport implements NodeRpcTransport {
  public readonly kind = "https" as const;

  public constructor(
    private readonly options: {
      readonly endpoint: string;
      readonly fetch?: typeof fetch;
    },
  ) {}

  public async request(request: NodeRequest): Promise<NodeResponse> {
    const fetchImpl = this.options.fetch ?? fetch;
    const response = await fetchImpl(this.options.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      throw new Error(`HTTPS node transport failed with status ${String(response.status)}`);
    }
    return (await response.json()) as NodeResponse;
  }

  public async *stream(request: NodeRequest): AsyncIterable<Record<string, unknown>> {
    const result = await this.request(request);
    yield result as unknown as Record<string, unknown>;
  }
}