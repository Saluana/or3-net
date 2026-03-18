/**
 * @module src/nodes/transport-wss
 *
 * Purpose:
 * In-process outbound WebSocket style transport abstraction used for nodes that
 * maintain a long-lived reverse connection into the control plane.
 */
import type { ControlPlaneDatabase } from "../db/index.ts";
import { createId } from "../lib/ids.ts";
import { nodeResponseSchema, nodeTransportFrameSchema, type JobResult, type JobStreamEvent, type NodeEvent, type NodeRequest, type NodeResponse, type TaskPackage } from "../contracts/index.ts";

import {
  normalizeNodeEvent,
  parseNodeResponseResult,
  RemoteExecutionError,
  type NodeExecutionContext,
  type NodeExecutionHandle,
  type NodeRpcTransport,
} from "./transport.ts";

type RequestHandler = (request: NodeRequest, context: NodeExecutionContext) => Promise<NodeResponse>;
type StreamHandler = (request: NodeRequest, context: NodeExecutionContext) => AsyncIterable<NodeEvent>;

interface LiveSocketLike {
  send(data: string): void;
  close?(code?: number, reason?: string): void;
}

interface PendingLiveRequest {
  readonly context: NodeExecutionContext;
  readonly request: NodeRequest;
  readonly response: Promise<NodeResponse>;
  resolve(response: NodeResponse): void;
  reject(error: Error): void;
  pushEvent(event: NodeEvent): void;
  closeEvents(): void;
  failEvents(error: Error): void;
  readonly stream: AsyncIterable<JobStreamEvent>;
}

interface LiveConnection {
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly socket: LiveSocketLike;
  lastSeenAt: string;
  connectedAt: string;
  readonly pending: Map<string, PendingLiveRequest>;
}

export interface OutboundWssNodeTransportOptions {
  readonly database?: ControlPlaneDatabase;
  readonly staleConnectionMs?: number;
  readonly now?: () => number;
}

export interface ConnectedNodeDescriptor {
  readonly workspace_id: string;
  readonly node_id: string;
  readonly connected_at: string;
  readonly last_seen_at: string;
  readonly stale: boolean;
}

/**
 * Purpose:
 * Simulates an outbound WSS transport using request and stream handlers attached
 * to connected nodes.
 */
export class OutboundWssNodeTransport implements NodeRpcTransport {
  public readonly kind = "outbound-wss" as const;
  private readonly handlers = new Map<string, RequestHandler>();
  private readonly streamHandlers = new Map<string, StreamHandler>();
  private readonly liveConnections = new Map<string, LiveConnection>();
  private readonly staleConnectionMs: number;
  private readonly now: () => number;
  private readonly database: ControlPlaneDatabase | undefined;

  public constructor(optionsOrHandler?: OutboundWssNodeTransportOptions | ((request: NodeRequest) => Promise<NodeResponse>)) {
    if (typeof optionsOrHandler === "function") {
      this.attachConnection("default", async (request) => optionsOrHandler(request));
      this.staleConnectionMs = 30_000;
      this.now = Date.now;
      return;
    }
    this.database = optionsOrHandler?.database;
    this.staleConnectionMs = optionsOrHandler?.staleConnectionMs ?? 30_000;
    this.now = optionsOrHandler?.now ?? Date.now;
  }

  /** Purpose: Attaches request and optional stream handlers for a connected node. */
  public attachConnection(nodeId: string, handler: RequestHandler, streamHandler?: StreamHandler): void {
    this.handlers.set(nodeId, handler);
    if (streamHandler !== undefined) {
      this.streamHandlers.set(nodeId, streamHandler);
    }
  }

  /** Purpose: Resolves and authenticates a websocket connection token when database-backed credentials are configured. */
  public async authenticateConnectionToken(token: string): Promise<{ workspaceId: string; nodeId: string } | null> {
    if (this.database === undefined) {
      return null;
    }
    const credential = await this.database.resolveActiveNodeCredential(token, this.now());
    if (credential === null) {
      return null;
    }

    const node = this.database.workspace(credential.workspace_id).getNode(credential.node_id);
    if (node.status !== "approved") {
      return null;
    }

    return {
      workspaceId: credential.workspace_id,
      nodeId: credential.node_id,
    };
  }

  /** Purpose: Attaches a live socket-backed node session after the caller has authenticated it. */
  public attachLiveConnection(input: { workspaceId: string; nodeId: string; socket: LiveSocketLike }): void {
    const nowIso = new Date(this.now()).toISOString();
    const connection: LiveConnection = {
      workspaceId: input.workspaceId,
      nodeId: input.nodeId,
      socket: input.socket,
      connectedAt: nowIso,
      lastSeenAt: nowIso,
      pending: new Map<string, PendingLiveRequest>(),
    };
    this.liveConnections.set(buildConnectionKey(input.workspaceId, input.nodeId), connection);
    this.touchNodeHealth(input.workspaceId, input.nodeId, "healthy", undefined, nowIso);
  }

  /** Purpose: Handles a framed message sent by a live connected node. */
  public handleLiveMessage(workspaceId: string, nodeId: string, rawMessage: string): void {
    const connection = this.requireLiveConnection(workspaceId, nodeId);
    connection.lastSeenAt = new Date(this.now()).toISOString();
    this.touchNodeHealth(workspaceId, nodeId, "healthy", undefined, connection.lastSeenAt);
    const frame = nodeTransportFrameSchema.parse(JSON.parse(rawMessage) as unknown);
    switch (frame.type) {
      case "response": {
        const pending = connection.pending.get(frame.payload.id);
        if (pending === undefined) {
          return;
        }
        pending.resolve(frame.payload);
        pending.closeEvents();
        connection.pending.delete(frame.payload.id);
        return;
      }
      case "event": {
        const pending = connection.pending.get(frame.request_id);
        pending?.pushEvent(frame.payload);
        return;
      }
      case "heartbeat":
        return;
      case "request":
        return;
    }
  }

  /** Purpose: Detaches a live connection and fails any in-flight executions. */
  public detachLiveConnection(workspaceId: string, nodeId: string, reason = "connection closed"): void {
    const key = buildConnectionKey(workspaceId, nodeId);
    const connection = this.liveConnections.get(key);
    if (connection === undefined) {
      return;
    }
    this.liveConnections.delete(key);
    const error = new RemoteExecutionError("remote_transport_disconnected", reason, {
      details: { workspace_id: workspaceId, node_id: nodeId },
    });
    for (const pending of connection.pending.values()) {
      pending.reject(error);
      pending.failEvents(error);
    }
    this.touchNodeHealth(workspaceId, nodeId, "stale", reason);
  }

  /** Purpose: Lists currently connected node sessions and whether they are stale. */
  public listConnectedNodes(): readonly ConnectedNodeDescriptor[] {
    return [...this.liveConnections.values()].map((connection) => ({
      workspace_id: connection.workspaceId,
      node_id: connection.nodeId,
      connected_at: connection.connectedAt,
      last_seen_at: connection.lastSeenAt,
      stale: this.isConnectionStale(connection),
    }));
  }

  public async startExecution(taskPackage: TaskPackage, context: NodeExecutionContext): Promise<NodeExecutionHandle> {
    const liveConnection = this.getUsableLiveConnection(context);
    if (liveConnection !== null) {
      return this.startLiveExecution(taskPackage, context, liveConnection);
    }

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
    const liveConnection = this.getUsableLiveConnection(context);
    if (liveConnection !== null) {
      await this.sendLiveRequest(
        liveConnection,
        {
          id: createId("rpc"),
          method: "heartbeat",
        },
        context,
      ).response;
      return;
    }

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

  /** Purpose: Sends an arbitrary RPC request to a connected node and returns the response. */
  public async sendRequest(request: NodeRequest, context: NodeExecutionContext): Promise<NodeResponse> {
    const liveConnection = this.getUsableLiveConnection(context);
    if (liveConnection !== null) {
      return this.sendLiveRequest(liveConnection, request, context).response;
    }
    const handler = this.handlers.get(context.nodeId) ?? this.handlers.get("default");
    if (handler === undefined) {
      throw new Error(`no outbound-wss connection is attached for node ${context.nodeId}`);
    }
    return nodeResponseSchema.parse(await handler(request, context));
  }

  private startLiveExecution(
    taskPackage: TaskPackage,
    context: NodeExecutionContext,
    connection: LiveConnection,
  ): Promise<NodeExecutionHandle> {
    const request: NodeRequest = {
      id: createId("rpc"),
      method: "execute",
      params: taskPackage,
    };
    const pending = this.sendLiveRequest(connection, request, context);
    return Promise.resolve({
      nodeId: context.nodeId,
      stream: pending.stream,
      result: pending.response.then((response) => parseNodeResponseResult(nodeResponseSchema.parse(response))),
      abort: async (): Promise<void> => {
        await this.sendLiveRequest(
          connection,
          {
            id: createId("rpc"),
            method: "abort",
            params: { job_id: taskPackage.job_id },
          },
          context,
        ).response;
      },
    });
  }

  private sendLiveRequest(
    connection: LiveConnection,
    request: NodeRequest,
    context: NodeExecutionContext,
  ): PendingLiveRequest {
    const pending = createPendingLiveRequest(context, request);
    connection.pending.set(request.id, pending);
    connection.socket.send(JSON.stringify({ type: "request", payload: request }));
    return pending;
  }

  private getUsableLiveConnection(context: NodeExecutionContext): LiveConnection | null {
    const connection = this.liveConnections.get(buildConnectionKey(context.workspaceId, context.nodeId));
    if (connection === undefined) {
      return null;
    }
    if (this.isConnectionStale(connection)) {
      this.detachLiveConnection(context.workspaceId, context.nodeId, "connection became stale");
      return null;
    }
    return connection;
  }

  private isConnectionStale(connection: LiveConnection): boolean {
    return this.now() - new Date(connection.lastSeenAt).getTime() > this.staleConnectionMs;
  }

  private requireLiveConnection(workspaceId: string, nodeId: string): LiveConnection {
    const connection = this.liveConnections.get(buildConnectionKey(workspaceId, nodeId));
    if (connection === undefined) {
      throw new Error(`no outbound-wss live connection is attached for node ${nodeId}`);
    }
    return connection;
  }

  private touchNodeHealth(
    workspaceId: string,
    nodeId: string,
    healthStatus: "healthy" | "stale",
    lastError?: string,
    lastSeenAt = new Date(this.now()).toISOString(),
  ): void {
    if (this.database === undefined) {
      return;
    }
    const workspace = this.database.workspace(workspaceId);
    try {
      const node = workspace.getNode(nodeId);
      workspace.saveNode({
        manifest: node.manifest,
        pubkey_fingerprint: node.pubkey_fingerprint,
        status: node.status as "pending" | "approved" | "revoked",
        health_status: healthStatus,
        ...(node.approved_at === null ? {} : { approved_at: node.approved_at }),
        ...(node.revoked_at === null ? {} : { revoked_at: node.revoked_at }),
        last_seen_at: lastSeenAt,
        ...(lastError === undefined ? {} : { last_error: lastError }),
        created_at: node.created_at,
      });
    } catch {
      return;
    }
  }
}

const buildConnectionKey = (workspaceId: string, nodeId: string): string => `${workspaceId}:${nodeId}`;

const createPendingLiveRequest = (
  context: NodeExecutionContext,
  request: NodeRequest,
): PendingLiveRequest => {
  let resolveResponse: ((response: NodeResponse) => void) | null = null;
  let rejectResponse: ((error: Error) => void) | null = null;
  const queue = createStreamQueue();
  const response = new Promise<NodeResponse>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  return {
    context,
    request,
    response,
    resolve: (resolvedResponse): void => {
      resolveResponse?.(resolvedResponse);
      queue.push({ type: "done" });
    },
    reject: (error): void => {
      rejectResponse?.(error);
    },
    pushEvent: (event): void => {
      const normalized = normalizeNodeEvent(event);
      if (normalized !== null) {
        queue.push({ type: "value", value: normalized });
      }
    },
    closeEvents: (): void => {
      queue.push({ type: "done" });
    },
    failEvents: (error): void => {
      queue.push({ type: "error", error });
    },
    stream: createQueuedStream(() => queue.take()),
  };
};

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
