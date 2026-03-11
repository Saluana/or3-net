import type { ControlPlaneDatabase, StoredLease, StoredNode } from "../db/index.ts";
import type { Lease, TaskPackage } from "../contracts/index.ts";
import { createId } from "../lib/ids.ts";

export interface SchedulerOptions {
  readonly database: ControlPlaneDatabase;
}

export interface ScheduleJobInput {
  readonly workspace_id: string;
  readonly job_id: string;
  readonly task_package: TaskPackage;
}

export class LeaseScheduler {
  public constructor(private readonly options: SchedulerOptions) {}

  public issueLease(input: ScheduleJobInput): StoredLease {
    const workspaceStore = this.options.database.workspace(input.workspace_id);
    const nowIso = new Date().toISOString();
    const leases = workspaceStore.listLeases().map((lease) => {
      if (lease.lease.state !== "active" || Date.parse(lease.expires_at) > Date.now()) {
        return lease;
      }

      return workspaceStore.saveLease({
        workspace_id: input.workspace_id,
        job_id: lease.job_id,
        lease: {
          ...lease.lease,
          state: "expired",
        },
        created_at: lease.created_at,
        expires_at: lease.expires_at,
        released_at: lease.released_at ?? nowIso,
      });
    });
    const approvedNodes = workspaceStore
      .listNodes()
      .filter((node) => node.status === "approved")
      .filter((node) => node.health_status !== "stale")
      .filter((node) => hasCapabilities(node, input.task_package.lease_profile.required_capabilities))
      .filter((node) => {
        if (input.task_package.lease_profile.isolation_class === undefined) {
          return true;
        }
        return node.manifest.isolation_class === input.task_package.lease_profile.isolation_class;
      });

    const candidate = approvedNodes
      .map((node) => ({
        node,
        activeLeases: countActiveLeases(leases, node.manifest.node_id),
      }))
      .filter(({ node, activeLeases }) => activeLeases < node.manifest.resource_limits.max_concurrent_jobs)
      .sort((left, right) => left.activeLeases - right.activeLeases)[0];

    if (candidate === undefined) {
      throw new Error("no approved node is currently available for this lease profile");
    }

    const ttlSeconds = Math.min(
      input.task_package.lease_profile.ttl_seconds,
      candidate.node.manifest.lease_policy.max_ttl_seconds,
    );
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1_000).toISOString();
    const lease: Lease = {
      lease_id: createId("lease"),
      node_id: candidate.node.manifest.node_id,
      profile: input.task_package.lease_profile,
      ttl: ttlSeconds,
      reset_required: true,
      state: "active",
    };

    return workspaceStore.saveLease({
      workspace_id: input.workspace_id,
      job_id: input.job_id,
      lease,
      created_at: createdAt,
      expires_at: expiresAt,
    });
  }
}

const hasCapabilities = (node: StoredNode, requiredCapabilities: string[]): boolean =>
  requiredCapabilities.every((capability) => node.manifest.capabilities.includes(capability));

const countActiveLeases = (leases: StoredLease[], nodeId: string): number =>
  leases.filter((lease) => lease.lease.node_id === nodeId && lease.lease.state === "active").length;