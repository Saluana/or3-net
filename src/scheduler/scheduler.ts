/**
 * @module src/scheduler/scheduler
 *
 * Purpose:
 * Issues and releases node leases for remote execution jobs.
 *
 * Behavior:
 * Evaluates workspace nodes against approval, health, capability, transport,
 * credential, certification, and capacity rules before selecting the least busy
 * eligible node.
 */
import type { ControlPlaneDatabase, StoredLease, StoredNode } from "../db/index.ts";
import type { Lease, TaskPackage } from "../contracts/index.ts";
import { runtimePtyCapability } from "../contracts/runtime/capabilities.ts";
import { createId } from "../lib/ids.ts";
import type { NodeTransportRegistry } from "../nodes/transport-registry.ts";

type NodeEligibilityIssue =
  | "not_approved"
  | "stale"
  | "missing_capability"
  | "isolation_mismatch"
  | "no_registered_transport"
  | "unsupported_registered_transport"
  | "missing_runtime_credential"
  | "missing_valid_certification"
  | "at_capacity";

/** Purpose: Construction options for the lease scheduler. */
export interface SchedulerOptions {
  readonly database: ControlPlaneDatabase;
  readonly transportRegistry?: NodeTransportRegistry;
  readonly enforceManagedCertification?: boolean;
}

/** Purpose: Input required to issue a remote-execution lease. */
export interface ScheduleJobInput {
  readonly workspace_id: string;
  readonly job_id: string;
  readonly task_package: TaskPackage;
}

/**
 * Purpose:
 * Selects nodes for remote jobs and persists the resulting lease records.
 */
export class LeaseScheduler {
  public constructor(private readonly options: SchedulerOptions) {}

  /** Purpose: Chooses an eligible node and issues a persisted active lease. */
  public issueLease(input: ScheduleJobInput): StoredLease {
    const workspaceStore = this.options.database.workspace(input.workspace_id);
    const nowMs = Date.now();
    workspaceStore.expireActiveLeases(nowMs);

    const activeLeaseCounts = new Map<string, number>();
    for (const lease of workspaceStore.listLeases()) {
      if (lease.lease.state !== "active" || Date.parse(lease.expires_at) <= nowMs) {
        continue;
      }

      activeLeaseCounts.set(lease.lease.node_id, (activeLeaseCounts.get(lease.lease.node_id) ?? 0) + 1);
    }

    const activeCredentialNodeIds = new Set(
      workspaceStore
        .listActiveNodeCredentials(nowMs)
        .filter((credential) => credential.token_ciphertext !== null)
        .map((credential) => credential.node_id),
    );

    const evaluatedNodes = workspaceStore.listNodes().map((node) => {
      const reasons = evaluateNodeEligibility(
        node,
        input.task_package,
        this.options.transportRegistry,
        this.options.enforceManagedCertification === true,
        activeCredentialNodeIds,
      );
      const activeLeases = activeLeaseCounts.get(node.manifest.node_id) ?? 0;
      return {
        node,
        activeLeases,
        reasons:
          activeLeases < node.manifest.resource_limits.max_concurrent_jobs
            ? reasons
            : [...reasons, "at_capacity" as const],
      };
    });

    const candidate = evaluatedNodes
      .filter(({ reasons }) => reasons.length === 0)
      .sort((left, right) => left.activeLeases - right.activeLeases)[0];

    if (candidate === undefined) {
      throw new Error(buildLeaseFailureMessage(evaluatedNodes));
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

  /** Purpose: Releases an active lease with the supplied terminal state. */
  public releaseLease(workspaceId: string, leaseId: string, state: Exclude<Lease["state"], "active"> = "released"): StoredLease {
    const workspaceStore = this.options.database.workspace(workspaceId);
    return workspaceStore.releaseLease(leaseId, state, new Date().toISOString());
  }
}

const hasCapabilities = (node: StoredNode, requiredCapabilities: string[]): boolean =>
  requiredCapabilities.every((capability) => {
    if (capability === runtimePtyCapability) {
      return node.manifest.capabilities.includes(runtimePtyCapability) || node.manifest.capabilities.includes("pty");
    }

    return node.manifest.capabilities.includes(capability);
  });

const hasValidCertification = (node: StoredNode): boolean => {
  const certification = node.manifest.certification;
  if (certification === undefined) {
    return false;
  }

  return Date.parse(certification.expires_at) > Date.now();
};

const isTransportEligible = (
  node: StoredNode,
  transportRegistry?: NodeTransportRegistry,
  activeCredentialNodeIds?: ReadonlySet<string>,
): NodeEligibilityIssue[] => {
  if (node.manifest.adapter_kind !== "remote") {
    return [];
  }

  if (transportRegistry === undefined) {
    return [];
  }

  const resolution = transportRegistry.describeResolution(node);
  if (!resolution.ok) {
    return [resolution.reason];
  }

  return activeCredentialNodeIds?.has(node.manifest.node_id) ?? false ? [] : ["missing_runtime_credential"];
};

const evaluateNodeEligibility = (
  node: StoredNode,
  taskPackage: TaskPackage,
  transportRegistry: NodeTransportRegistry | undefined,
  enforceManagedCertification: boolean,
  activeCredentialNodeIds: ReadonlySet<string>,
): NodeEligibilityIssue[] => {
  const reasons: NodeEligibilityIssue[] = [];
  if (node.status !== "approved") {
    reasons.push("not_approved");
  }
  if (node.health_status === "stale") {
    reasons.push("stale");
  }
  if (!hasCapabilities(node, taskPackage.lease_profile.required_capabilities)) {
    reasons.push("missing_capability");
  }
  if (
    taskPackage.lease_profile.isolation_class !== undefined &&
    node.manifest.isolation_class !== taskPackage.lease_profile.isolation_class
  ) {
    reasons.push("isolation_mismatch");
  }
  reasons.push(...isTransportEligible(node, transportRegistry, activeCredentialNodeIds));
  if (enforceManagedCertification && !hasValidCertification(node)) {
    reasons.push("missing_valid_certification");
  }
  return reasons;
};

const buildLeaseFailureMessage = (
  nodes: readonly { node: StoredNode; reasons: readonly NodeEligibilityIssue[] }[],
): string => {
  const relevant = nodes
    .filter(({ reasons }) => reasons.length > 0)
    .map(({ node, reasons }) => `${node.manifest.node_id}: ${reasons.map(describeIssue).join(", ")}`);

  if (relevant.length === 0) {
    return "no approved node is currently available for this lease profile";
  }

  return `no approved node is currently available for this lease profile (${relevant.join("; ")})`;
};

const describeIssue = (issue: NodeEligibilityIssue): string => {
  switch (issue) {
    case "not_approved":
      return "not approved";
    case "stale":
      return "health is stale";
    case "missing_capability":
      return "missing required capability";
    case "isolation_mismatch":
      return "isolation class mismatch";
    case "no_registered_transport":
      return "no registered transport";
    case "unsupported_registered_transport":
      return "registered transport is unsupported by the node";
    case "missing_runtime_credential":
      return "missing runtime credential";
    case "missing_valid_certification":
      return "missing valid certification";
    case "at_capacity":
      return "at capacity";
  }
};
