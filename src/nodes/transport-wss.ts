import { createId } from "../lib/ids.ts";
import { nodeResponseSchema, type JobResult, type JobStreamEvent, type NodeEvent, type NodeRequest, type NodeResponse, type TaskPackage } from "../contracts/index.ts";

import {
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
      ...(trackedStream === undefined ? {} : { stream: trackedStream.stream }),
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

  public async heartbeat(context: NodeExecutionContext): Promise<void> {
    const handler = this.handlers.get(context.nodeId) ?? this.handlers.get("default");
    if (handler === undefined) {
      throw new Error(`no outbound-wss connection is attached for node ${context.nodeId}`);
    }

    await handler(
      {
        id: createId("rpc"),
        method: "heartbeat",
      },
      context,
    );
  }
}

const trackExecutionStream = (
  stream: AsyncIterable<NodeEvent>,
  fallback: ReturnType<typeof parseNodeResponseResult>,
): { stream: AsyncIterable<JobStreamEvent>; result: Promise<JobResult> } => {
  const queue = createStreamQueue();

  const result = (async () => {
    let terminalResult = fallback;
    let terminalError: Error | null = null;
    let sawTerminal = false;

    try {
      for await (const event of stream) {
        if (!sawTerminal && event.event === "complete") {
          terminalResult = event.data;
          sawTerminal = true;
        } else if (!sawTerminal && event.event === "error") {
          terminalError = new Error(event.data.message);
          sawTerminal = true;
        }

        const normalized = normalizeNodeEvent(event);
        if (normalized !== null) {
          queue.push({ type: "value", value: normalized });
        }
      }

      if (terminalError !== null) {
        throw terminalError;
      }
      queue.push({ type: "done" });
      return terminalResult;
    } catch (error: unknown) {
      const thrown = error instanceof Error ? error : new Error("outbound-wss transport failed");
      queue.push({ type: "error", error: thrown });
      throw thrown;
    }
  })();

  return {
    stream: createQueuedStream(() => queue.take()),
    result,
  };
};

type StreamQueueEntry =
  | { readonly type: "value"; readonly value: JobStreamEvent }
  | { readonly type: "done" }
  | { readonly type: "error"; readonly error: unknown };

interface StreamQueueNode {
  readonly entry: StreamQueueEntry;
  next: StreamQueueNode | null;
}

const createQueuedStream = (takeEntry: () => Promise<StreamQueueEntry>): AsyncIterable<JobStreamEvent> => ({
  [Symbol.asyncIterator](): AsyncIterator<JobStreamEvent> {
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

const createStreamQueue = (): {
  push(entry: StreamQueueEntry): void;
  take(): Promise<StreamQueueEntry>;
} => {
  let head: StreamQueueNode | null = null;
  let tail: StreamQueueNode | null = null;
  let pendingResolve: ((entry: StreamQueueEntry) => void) | null = null;

  return {
    push(entry: StreamQueueEntry): void {
      if (pendingResolve !== null) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve(entry);
        return;
      }

      const node: StreamQueueNode = { entry, next: null };
      if (tail === null) {
        head = node;
        tail = node;
        return;
      }

      tail.next = node;
      tail = node;
    },
    take(): Promise<StreamQueueEntry> {
      if (head !== null) {
        const node = head;
        head = node.next;
        if (head === null) {
          tail = null;
        }
        return Promise.resolve(node.entry);
      }

      return new Promise((resolve) => {
        pendingResolve = resolve;
      });
    },
  };
};
