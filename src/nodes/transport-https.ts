import { createId } from "../lib/ids.ts";
import { nodeEventSchema, nodeResponseSchema, type JobStreamEvent, type NodeEvent, type NodeRequest, type NodeResponse } from "../contracts/index.ts";

import {
  nodeEventsToResult,
  normalizeNodeEvent,
  parseNodeResponseResult,
  type NodeExecutionHandle,
  type NodeExecutionContext,
  type NodeRpcTransport,
} from "./transport.ts";

export class HttpsNodeTransport implements NodeRpcTransport {
  public readonly kind = "https" as const;

  public constructor(
    private readonly options: {
      readonly endpoint: string;
      readonly fetch?: typeof fetch;
    },
  ) {}

  private async request(request: NodeRequest, context: NodeExecutionContext, endpoint = this.options.endpoint): Promise<NodeResponse> {
    const fetchImpl = this.options.fetch ?? fetch;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${context.credential.token}`,
      },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      throw new Error(`HTTPS node transport failed with status ${String(response.status)}`);
    }
    if (response.status === 204) {
      return { id: request.id, result: { output_text: "", artifacts: [], meta: {} } };
    }
    return nodeResponseSchema.parse((await response.json()) as NodeResponse);
  }

  public async startExecution(taskPackage: Parameters<NodeRpcTransport["startExecution"]>[0], context: NodeExecutionContext): Promise<NodeExecutionHandle> {
    const fetchImpl = this.options.fetch ?? fetch;
    const response = await fetchImpl(this.options.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${context.credential.token}`,
      },
      body: JSON.stringify({
        id: createId("rpc"),
        method: "execute",
        params: taskPackage,
      } satisfies NodeRequest),
    });

    if (!response.ok) {
      throw new Error(`HTTPS node transport failed with status ${String(response.status)}`);
    }

    const payload = (await response.json()) as NodeResponse | { events?: NodeEvent[] };
    const events = Array.isArray((payload as { events?: unknown }).events)
      ? ((payload as { events: unknown[] }).events.map((event) => nodeEventSchema.parse(event)))
      : [];
    const fallback = "id" in payload ? parseNodeResponseResult(nodeResponseSchema.parse(payload)) : undefined;

    return {
      nodeId: context.nodeId,
      stream: createNormalizedStream(events),
      result: Promise.resolve().then(() => nodeEventsToResult(events, fallback)),
      abort: async () => {
        await this.request(
          {
            id: createId("rpc"),
            method: "abort",
            params: { job_id: taskPackage.job_id },
          },
          context,
          `${this.options.endpoint.replace(/\/$/, "")}/abort`,
        );
      },
    };
  }
}

const createNormalizedStream = (events: readonly NodeEvent[]): AsyncIterable<JobStreamEvent> => ({
  [Symbol.asyncIterator](): AsyncIterator<JobStreamEvent> {
    let index = 0;

    return {
      next(): Promise<IteratorResult<JobStreamEvent>> {
        while (index < events.length) {
          const event = events[index];
          index += 1;
          if (event === undefined) {
            break;
          }

          const normalized = normalizeNodeEvent(event);
          if (normalized !== null) {
            return Promise.resolve({ done: false, value: normalized });
          }
        }

        return Promise.resolve({ done: true, value: undefined });
      },
    };
  },
});