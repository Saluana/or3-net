import type { StoredNode } from "../db/index.ts";

import type { NodeRpcTransport } from "./transport.ts";

export class NodeTransportRegistry {
  private readonly nodeTransports = new Map<string, NodeRpcTransport>();
  private readonly kindTransports = new Map<NodeRpcTransport["kind"], NodeRpcTransport>();

  public registerNodeTransport(nodeId: string, transport: NodeRpcTransport): void {
    this.nodeTransports.set(nodeId, transport);
  }

  public registerKindTransport(kind: NodeRpcTransport["kind"], transport: NodeRpcTransport): void {
    this.kindTransports.set(kind, transport);
  }

  public canResolve(node: StoredNode): boolean {
    if (this.nodeTransports.has(node.manifest.node_id)) {
      return true;
    }

    return node.manifest.supports_transports.some((kind) => this.kindTransports.has(kind));
  }

  public resolve(node: StoredNode): NodeRpcTransport {
    const direct = this.nodeTransports.get(node.manifest.node_id);
    if (direct !== undefined) {
      return direct;
    }

    for (const kind of node.manifest.supports_transports) {
      const transport = this.kindTransports.get(kind);
      if (transport !== undefined) {
        return transport;
      }
    }

    throw new Error(`no registered transport for node ${node.manifest.node_id}`);
  }
}