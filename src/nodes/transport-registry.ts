/**
 * @module src/nodes/transport-registry
 *
 * Purpose:
 * Resolves which remote node transport should be used for a given stored node.
 */
import type { StoredNode } from "../db/index.ts";

import type { NodeRpcTransport } from "./transport.ts";

/**
 * Purpose:
 * Result returned when describing how a node transport was or was not resolved.
 */
export type NodeTransportResolution =
  | {
      readonly ok: true;
      readonly transport: NodeRpcTransport;
      readonly source: "node" | "kind";
    }
  | {
      readonly ok: false;
      readonly reason: "no_registered_transport" | "unsupported_registered_transport";
      readonly message: string;
    };

/**
 * Purpose:
 * Registry of transport implementations keyed by node or transport kind.
 */
export class NodeTransportRegistry {
  private readonly nodeTransports = new Map<string, NodeRpcTransport>();
  private readonly kindTransports = new Map<NodeRpcTransport["kind"], NodeRpcTransport>();

  /** Purpose: Registers a transport override for a specific workspace-scoped node. */
  public registerNodeTransport(workspaceId: string, nodeId: string, transport: NodeRpcTransport): void {
    this.nodeTransports.set(buildNodeKey(workspaceId, nodeId), transport);
  }

  /** Purpose: Registers a default transport implementation for a transport kind. */
  public registerKindTransport(kind: NodeRpcTransport["kind"], transport: NodeRpcTransport): void {
    this.kindTransports.set(kind, transport);
  }

  /** Purpose: Reports whether a node can currently be resolved to a transport. */
  public canResolve(node: StoredNode): boolean {
    return this.describeResolution(node).ok;
  }

  /** Purpose: Explains how a node would resolve to a transport or why it cannot. */
  public describeResolution(node: StoredNode): NodeTransportResolution {
    const direct = this.nodeTransports.get(buildNodeKey(node.workspace_id, node.manifest.node_id));
    if (direct !== undefined) {
      if (node.manifest.supports_transports.includes(direct.kind)) {
        return { ok: true, transport: direct, source: "node" };
      }

      return {
        ok: false,
        reason: "unsupported_registered_transport",
        message: `registered node transport ${direct.kind} is not supported by node ${node.manifest.node_id}`,
      };
    }

    for (const kind of node.manifest.supports_transports) {
      const transport = this.kindTransports.get(kind);
      if (transport !== undefined) {
        return { ok: true, transport, source: "kind" };
      }
    }

    return {
      ok: false,
      reason: "no_registered_transport",
      message: `no registered transport matches node ${node.manifest.node_id} (${node.manifest.supports_transports.join(", ")})`,
    };
  }

  /** Purpose: Resolves a node to a usable transport or throws. */
  public resolve(node: StoredNode): NodeRpcTransport {
    const resolution = this.describeResolution(node);
    if (resolution.ok) {
      return resolution.transport;
    }

    throw new Error(resolution.message);
  }
}

const buildNodeKey = (workspaceId: string, nodeId: string): string => `${workspaceId}:${nodeId}`;
