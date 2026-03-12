import { createId } from "../lib/ids.ts";
import { nodeResponseSchema, type JobStreamEvent, type NodeEvent, type NodeRequest, type NodeResponse, type TaskPackage } from "../contracts/index.ts";

import {
  nodeEventsToResult,
  normalizeNodeEvent,
  parseNodeResponseResult,
  type NodeExecutionContext,
  type NodeExecutionHandle,
  type NodeRpcTransport,
} from "./transport.ts";

type RequestHandler = (request: NodeRequest, context: NodeExecutionContext) => Promise<NodeResponse>;
type StreamHandler = (request: NodeRequest, context: NodeExecutionContext) => AsyncIterable<NodeEvent>;

export class OutboundWssNodeTransport implements NodeRpcTransport {
  public readonly kind = "outbound-wss" as const;
  private readonly handlers = new Map<string, RequestHandler>();
  private readonly streamHandlers = new Map<string, StreamHandler>();

  public constructor(handler?: (request: NodeRequest) => Promise<NodeResponse>) {
    if (handler !== undefined) {
      this.attachConnection("default", async (request) => handler(request));
    }
  }

  public attachConnection(nodeId: string, handler: RequestHandler, streamHandler?: StreamHandler): void {
    this.handlers.set(nodeId, handler);
    if (streamHandler !== undefined) {
      this.streamHandlers.set(nodeId, streamHandler);
    }
  }

  public async startExecution(taskPackage: TaskPackage, context: NodeExecutionContext): Promise<NodeExecutionHandle> {
    const handler = this.handlers.get(context.nodeId) ?? this.handlers.get("default");
    if (handler === undefined) {
      throw new Error(`no outbound-wss connection is attached for node ${context.nodeId}`);
    }

    const request: NodeRequest = {
      id: createId("rpc"),
      method: "execute",
      params: taskPackage,
    };
    const response = nodeResponseSchema.parse(await handler(request, context));
    const streamHandler = this.streamHandlers.get(context.nodeId) ?? this.streamHandlers.get("default");
    const trackedStream =
      streamHandler === undefined
        ? undefined
        : trackExecutionStream(
            streamHandler(
              {
                id: createId("rpc"),
                method: "execute",
                params: taskPackage,
              },
              context,
            ),
            parseNodeResponseResult(response),
          );

    return {
      nodeId: context.nodeId,
      stream: trackedStream?.stream,
      result: trackedStream?.result ?? Promise.resolve(parseNodeResponseResult(response)),
      abort: async () => {
        await handler(
          {
            id: createId("rpc"),
            method: "abort",
            params: { job_id: taskPackage.job_id },
          },
          context,
        );
      },
    };
  }
}

const createNormalizedStream = async function* (stream: AsyncIterable<NodeEvent>) {
  for await (const event of stream) {
    const normalized = normalizeNodeEvent(event);
    if (normalized !== null) {
      yield normalized;
    }
  }
};

const trackExecutionStream = (stream: AsyncIterable<NodeEvent>, fallback: NodeResponse extends never ? never : ReturnType<typeof parseNodeResponseResult>) => {
  const queue: StreamQueueEntry[] = [];
  let pendingResolve: ((entry: StreamQueueEntry) => void) | null = null;

  const pushEntry = (entry: StreamQueueEntry) => {
    if (pendingResolve !== null) {
      const resolve = pendingResolve;
      pendingResolve = null;
      resolve(entry);
      return;
    }

    queue.push(entry);
  };

  const takeEntry = (): Promise<StreamQueueEntry> => {
    const entry = queue.shift();
    if (entry !== undefined) {
      return Promise.resolve(entry);
    }

    return new Promise((resolve) => {
      pendingResolve = resolve;
    });
  };

  const result = (async () => {
    const events: NodeEvent[] = [];
    try {
      for await (const event of stream) {
        events.push(event);
        const normalized = normalizeNodeEvent(event);
        if (normalized !== null) {
          pushEntry({ type: "value", value: normalized });
        }
      }

      const finalResult = nodeEventsToResult(events, fallback);
      pushEntry({ type: "done" });
      return finalResult;
    } catch (error) {
      pushEntry({ type: "error", error });
      throw error;
    }
  })();

  return {
    stream: createQueuedStream(takeEntry),
    result,
  };
};

type StreamQueueEntry =
  | { readonly type: "value"; readonly value: JobStreamEvent }
  | { readonly type: "done" }
  | { readonly type: "error"; readonly error: unknown };

const createQueuedStream = (takeEntry: () => Promise<StreamQueueEntry>): AsyncIterable<JobStreamEvent> => ({
  [Symbol.asyncIterator]() {
    return {
      next: async (): Promise<IteratorResult<JobStreamEvent>> => {
        const entry = await takeEntry();
        switch (entry.type) {
          case "value":
            return { done: false, value: entry.value };
          case "done":
            return { done: true, value: undefined };
          case "error":
            throw entry.error;
        }
      },
    };
  },
});