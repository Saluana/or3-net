/**
 * @module src/nodes/transport
 *
 * Purpose:
 * Shared node transport contracts and error-normalization helpers used by the
 * remote execution path.
 */
import type { JobError, JobResult, JobStreamEvent, NodeEvent, NodeRequest, NodeResponse, TaskPackage } from "../contracts/index.ts";

/** Purpose: Transport interface implemented by remote node RPC connectors. */
export interface NodeRpcTransport {
  readonly kind: "https" | "outbound-wss";
  startExecution(taskPackage: TaskPackage, context: NodeExecutionContext): Promise<NodeExecutionHandle>;
  heartbeat?(context: NodeExecutionContext): Promise<void>;
  sendRequest?(request: NodeRequest, context: NodeExecutionContext): Promise<NodeResponse>;
}

/** Purpose: Time-bounded credential material used for node transport auth. */
export interface NodeTransportCredential {
  readonly token: string;
  readonly expiresAt: string;
}

/** Purpose: Execution context supplied to a node transport invocation. */
export interface NodeExecutionContext {
  readonly workspaceId: string;
  readonly nodeId: string;
  readonly credential: NodeTransportCredential;
}

/** Purpose: Handle returned when a node transport starts executing a task. */
export interface NodeExecutionHandle {
  readonly nodeId: string;
  readonly stream?: AsyncIterable<JobStreamEvent>;
  readonly result: Promise<JobResult>;
  abort(): Promise<void>;
}

/**
 * Purpose:
 * Rich error type for failures that occur while starting, streaming, or aborting
 * remote node execution.
 */
export class RemoteExecutionError extends Error {
  public readonly retriable: boolean;
  public readonly details: Record<string, unknown>;

  public constructor(
    public readonly code:
      | "remote_execution_start_failed"
      | "remote_transport_disconnected"
      | "remote_abort_failed"
      | "remote_execution_failed",
    message: string,
    options: {
      readonly retriable?: boolean;
      readonly details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = "RemoteExecutionError";
    this.retriable = options.retriable ?? true;
    this.details = options.details ?? {};
  }
}

/** Purpose: Type guard for `RemoteExecutionError`. */
export const isRemoteExecutionError = (value: unknown): value is RemoteExecutionError => value instanceof RemoteExecutionError;

/** Purpose: Normalizes an unknown failure into a `RemoteExecutionError`. */
export const toRemoteExecutionError = (
  value: unknown,
  fallback:
    | "remote_execution_start_failed"
    | "remote_transport_disconnected"
    | "remote_abort_failed"
    | "remote_execution_failed",
  details: Record<string, unknown> = {},
): RemoteExecutionError => {
  if (isRemoteExecutionError(value)) {
    return value;
  }

  return new RemoteExecutionError(
    fallback,
    value instanceof Error ? value.message : "Remote execution failed",
    { details },
  );
};

/** Purpose: Converts a remote execution error into the canonical job-error shape. */
export const remoteExecutionErrorToJobError = (error: RemoteExecutionError): JobError => ({
  code: error.code,
  message: error.message,
  retriable: error.retriable,
  details: toJsonRecord(error.details),
});

/** Purpose: Normalizes raw node events into control-plane job stream events. */
export const normalizeNodeEvent = (event: NodeEvent): JobStreamEvent | null => {
  switch (event.event) {
    case "output":
      return { event: "text.delta", data: { text: event.data.text } };
    case "tool_call":
      return { event: "tool.call", data: { name: event.data.name } };
    case "tool_result":
      return { event: "tool.result", data: { name: event.data.name, result: event.data.result } };
    case "progress":
      return { event: "text.delta", data: { text: event.data.message } };
    case "complete":
    case "error":
      return null;
  }
};

/** Purpose: Extracts the terminal result from a sequence of node events. */
export const nodeEventsToResult = (events: readonly NodeEvent[], fallback?: JobResult): JobResult => {
  for (const event of events) {
    if (event.event === "complete") {
      return event.data;
    }
    if (event.event === "error") {
      throw new Error(event.data.message);
    }
  }

  if (fallback !== undefined) {
    return fallback;
  }

  throw new RemoteExecutionError("remote_transport_disconnected", "remote execution ended without a terminal event");
};

/** Purpose: Converts a job error payload into a plain `Error` instance. */
export const nodeErrorToError = (error: JobError): Error => new Error(error.message);

/** Purpose: Resolves a node RPC response into a successful job result or throws. */
export const parseNodeResponseResult = (response: NodeResponse): JobResult => {
  if ("error" in response) {
    throw nodeErrorToError(response.error);
  }

  return response.result;
};

const toJsonRecord = (value: Record<string, unknown>): JobError["details"] => {
  const record: JobError["details"] = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean" ||
      entry === null ||
      Array.isArray(entry) ||
      typeof entry === "object"
    ) {
      record[key] = entry as JobError["details"][string];
    }
  }
  return record;
};
