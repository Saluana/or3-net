/**
 * @module src/nodes/executor
 *
 * Purpose:
 * Connects approved stored nodes to registered transports and credentials so the
 * control plane can start or monitor remote execution.
 */
import type { ControlPlaneDatabase } from "../db/index.ts";
import type { JobResult, NodeEvent, NodeRequest, NodeResponse, StoredNode, TaskPackage } from "../index.ts";

import type { NodeTransportRegistry } from "./transport-registry.ts";
import { RemoteExecutionError, type NodeExecutionHandle, type NodeRpcTransport, type NodeTransportCredential } from "./transport.ts";

/**
 * Purpose:
 * Starts remote node execution using the appropriate transport and credential.
 */
export class RemoteNodeExecutor {
  public constructor(
    private readonly transportRegistry: NodeTransportRegistry,
    private readonly database?: ControlPlaneDatabase,
  ) {}

  /** Purpose: Reports whether the node currently has enough wiring to execute work. */
  public canExecute(node: StoredNode): boolean {
    if (!this.transportRegistry.describeResolution(node).ok) {
      return false;
    }

    if (this.database === undefined) {
      return true;
    }

    const credential = this.database.workspace(node.workspace_id).getActiveNodeCredential(node.manifest.node_id);
    return credential?.token_ciphertext !== null && credential !== null;
  }

  /** Purpose: Starts remote execution on a node using an explicit or stored credential. */
  public async startExecution(
    node: StoredNode,
    taskPackage: TaskPackage,
    credential?: { token: string; expires_at: string },
  ): Promise<NodeExecutionHandle> {
    let transport;
    try {
      transport = this.transportRegistry.resolve(node);
    } catch (error) {
      throw new RemoteExecutionError(
        "remote_execution_start_failed",
        error instanceof Error ? error.message : `no runtime transport is available for node ${node.manifest.node_id}`,
        { details: { node_id: node.manifest.node_id } },
      );
    }
    const resolvedCredential = this.resolveCredential(node, credential);
    return transport.startExecution(taskPackage, {
      workspaceId: node.workspace_id,
      nodeId: node.manifest.node_id,
      credential: resolvedCredential,
    });
  }

  /** Purpose: Convenience helper that waits for a remote execution result. */
  public async executeTask(node: StoredNode, taskPackage: TaskPackage): Promise<JobResult> {
    const run = await this.startExecution(node, taskPackage);
    return run.result;
  }

  /** Purpose: Sends a heartbeat request when the resolved transport supports it. */
  public async heartbeat(
    node: StoredNode,
    credential?: { token: string; expires_at: string },
  ): Promise<void> {
    let transport;
    try {
      transport = this.transportRegistry.resolve(node);
    } catch (error) {
      throw new RemoteExecutionError(
        "remote_execution_start_failed",
        error instanceof Error ? error.message : `no runtime transport is available for node ${node.manifest.node_id}`,
        { details: { node_id: node.manifest.node_id } },
      );
    }

    if (transport.heartbeat === undefined) {
      return;
    }

    await transport.heartbeat({
      workspaceId: node.workspace_id,
      nodeId: node.manifest.node_id,
      credential: this.resolveCredential(node, credential),
    });
  }

  /** Purpose: Sends an arbitrary node RPC request when the resolved transport supports it. */
  public async sendRequest(
    node: StoredNode,
    request: NodeRequest,
    credential?: { token: string; expires_at: string },
  ): Promise<NodeResponse> {
    const transport = this.resolveTransport(node);
    if (transport.sendRequest === undefined) {
      throw new RemoteExecutionError(
        "remote_execution_failed",
        `transport ${transport.kind} does not support arbitrary RPC for node ${node.manifest.node_id}`,
        { details: { node_id: node.manifest.node_id } },
      );
    }
    return transport.sendRequest(request, {
      workspaceId: node.workspace_id,
      nodeId: node.manifest.node_id,
      credential: this.resolveCredential(node, credential),
    });
  }

  /** Purpose: Sends an RPC request that keeps streaming node events after the initial response. */
  public async sendStreamingRequest(
    node: StoredNode,
    request: NodeRequest,
    credential?: { token: string; expires_at: string },
  ): Promise<{ response: Promise<NodeResponse>; stream: AsyncIterable<NodeEvent> }> {
    const transport = this.resolveTransport(node);
    if (transport.sendStreamingRequest === undefined) {
      throw new RemoteExecutionError(
        "remote_execution_failed",
        `transport ${transport.kind} does not support streaming RPC for node ${node.manifest.node_id}`,
        { details: { node_id: node.manifest.node_id } },
      );
    }
    return transport.sendStreamingRequest(request, {
      workspaceId: node.workspace_id,
      nodeId: node.manifest.node_id,
      credential: this.resolveCredential(node, credential),
    });
  }

  private resolveTransport(node: StoredNode): NodeRpcTransport {
    try {
      return this.transportRegistry.resolve(node);
    } catch (error) {
      throw new RemoteExecutionError(
        "remote_execution_start_failed",
        error instanceof Error ? error.message : `no runtime transport is available for node ${node.manifest.node_id}`,
        { details: { node_id: node.manifest.node_id } },
      );
    }
  }

  private resolveCredential(node: StoredNode, credential?: { token: string; expires_at: string }): NodeTransportCredential {
    if (credential !== undefined) {
      return {
        token: credential.token,
        expiresAt: credential.expires_at,
      };
    }

    if (this.database === undefined) {
      throw new RemoteExecutionError(
        "remote_execution_start_failed",
        `no runtime credential is available for node ${node.manifest.node_id}`,
        { details: { node_id: node.manifest.node_id } },
      );
    }

    const stored = this.database.workspace(node.workspace_id).getActiveNodeCredential(node.manifest.node_id);
    if (stored?.token_ciphertext == null) {
      throw new RemoteExecutionError(
        "remote_execution_start_failed",
        `no runtime credential is available for node ${node.manifest.node_id}`,
        { details: { node_id: node.manifest.node_id } },
      );
    }

    return {
      token: stored.token_ciphertext,
      expiresAt: stored.expires_at,
    };
  }
}
