import { createId } from "../lib/ids.ts";
import { nodeResponseSchema, type JobResult, type StoredNode, type TaskPackage } from "../index.ts";

import type { NodeTransportRegistry } from "./transport-registry.ts";

export class RemoteNodeExecutor {
  public constructor(private readonly transportRegistry: NodeTransportRegistry) {}

  public canExecute(node: StoredNode): boolean {
    return this.transportRegistry.canResolve(node);
  }

  public async executeTask(node: StoredNode, taskPackage: TaskPackage): Promise<JobResult> {
    const transport = this.transportRegistry.resolve(node);
    const response = nodeResponseSchema.parse(
      await transport.request({
        id: createId("rpc"),
        method: "execute",
        params: taskPackage,
      }),
    );

    if ("error" in response) {
      throw new Error(response.error.message);
    }

    return response.result;
  }
}