/**
 * @module src/runtime/selection
 *
 * Purpose:
 * Chooses the best available runtime adapter or node for a workspace based on
 * capabilities, trust tier, locality, and health.
 */
import {
  type RuntimeAdapter,
  type RuntimeAdapterHealth,
  type RuntimeCapability,
  type RuntimeNodeDescriptor,
  type RuntimeTrustTier,
  type RuntimeLocality,
  RuntimeError,
} from "../contracts/runtime/index.ts";
import type { RuntimeRegistry } from "./registry.ts";

const healthRank: Record<RuntimeAdapterHealth["status"], number> = {
  healthy: 4,
  degraded: 3,
  unknown: 2,
  unavailable: 0,
};

const trustTierRank: Record<RuntimeTrustTier, number> = {
  production: 4,
  staging: 3,
  development: 2,
  untrusted: 1,
};

const localityRank: Record<RuntimeLocality, number> = {
  local: 3,
  hybrid: 2,
  remote: 1,
};

/** Purpose: Criteria used to select a runtime adapter or node. */
export interface RuntimeSelectionCriteria {
  readonly required_capabilities?: readonly RuntimeCapability[];
  readonly preset_id?: string;
  readonly trust_tier?: RuntimeTrustTier;
  readonly isolation_class?: string;
  readonly locality?: RuntimeLocality;
}

/** Purpose: Selected runtime target including adapter health and optional node. */
export interface RuntimeSelectionResult {
  readonly adapter: RuntimeAdapter;
  readonly health: RuntimeAdapterHealth;
  readonly node?: RuntimeNodeDescriptor;
}

/**
 * Purpose:
 * Scores available runtime adapters and nodes against requested criteria.
 */
export class RuntimeSelectionService {
  public constructor(private readonly registry: RuntimeRegistry) {}

  /** Purpose: Selects the best runtime target for the given workspace and criteria. */
  public async select(workspaceId: string, criteria: RuntimeSelectionCriteria): Promise<RuntimeSelectionResult> {
    const requiredCapabilities = [...(criteria.required_capabilities ?? [])];
    const candidates: (RuntimeSelectionResult | null)[] = await Promise.all(
      this.registry.list().map(async (adapter) => {
        const adapterHealth = await getAdapterHealth(adapter, workspaceId);
        if (healthRank[adapterHealth.status] === 0) {
          return null;
        }

        if (!hasAllCapabilities(adapter.manifest.capabilities, requiredCapabilities)) {
          return null;
        }

        if (
          criteria.preset_id !== undefined &&
          !adapter.manifest.supported_presets.includes(criteria.preset_id)
        ) {
          return null;
        }

        if (
          criteria.trust_tier !== undefined &&
          trustTierRank[adapter.manifest.trust_tier] < trustTierRank[criteria.trust_tier]
        ) {
          return null;
        }

        if (criteria.locality !== undefined && adapter.manifest.locality !== criteria.locality) {
          return null;
        }

        const nodes = await adapter.listNodes({ workspace_id: workspaceId });
        const node = selectBestNode(nodes, criteria, requiredCapabilities);
        if (nodes.length > 0 && node === undefined) {
          return null;
        }

        return node === undefined ? { adapter, health: adapterHealth } : { adapter, health: adapterHealth, node };
      }),
    );

    const available = candidates.filter((candidate): candidate is RuntimeSelectionResult => candidate !== null);
    if (available.length === 0) {
      throw new RuntimeError("policy_denied", "no runtime adapter matches the requested criteria", {
        details: {
          workspace_id: workspaceId,
          required_capabilities: requiredCapabilities,
          preset_id: criteria.preset_id,
          trust_tier: criteria.trust_tier,
          isolation_class: criteria.isolation_class,
          locality: criteria.locality,
        },
      });
    }
    const [selected] = available.sort((left, right) => compareCandidates(left, right, criteria));
    if (selected === undefined) {
      throw new RuntimeError("adapter_internal", "invariant: available candidates were empty after validation");
    }

    return selected;
  }
}

const getAdapterHealth = async (
  adapter: RuntimeAdapter,
  workspaceId: string,
): Promise<RuntimeAdapterHealth> => {
  try {
    return await adapter.health({ workspace_id: workspaceId });
  } catch {
    return {
      status: "unavailable",
      checked_at: new Date().toISOString(),
    };
  }
};

const selectBestNode = (
  nodes: readonly RuntimeNodeDescriptor[],
  criteria: RuntimeSelectionCriteria,
  requiredCapabilities: readonly RuntimeCapability[],
): RuntimeNodeDescriptor | undefined =>
  [...nodes]
    .filter((node) => healthRank[node.health.status] > 0)
    .filter((node) => hasAllCapabilities(node.capabilities, requiredCapabilities))
    .filter((node) => criteria.locality === undefined || node.locality === criteria.locality)
    .sort((left, right) => compareNodes(left, right, criteria))[0];

const compareCandidates = (
  left: RuntimeSelectionResult,
  right: RuntimeSelectionResult,
  criteria: RuntimeSelectionCriteria,
): number => {
  const leftLocality = left.node?.locality ?? left.adapter.manifest.locality;
  const rightLocality = right.node?.locality ?? right.adapter.manifest.locality;
  const scores: [number, number][] = [
    [healthRank[left.health.status], healthRank[right.health.status]],
    [
      matchScore(left.adapter.manifest.isolation_class, criteria.isolation_class),
      matchScore(right.adapter.manifest.isolation_class, criteria.isolation_class),
    ],
    [localityPreference(leftLocality, criteria.locality), localityPreference(rightLocality, criteria.locality)],
    [trustTierRank[left.adapter.manifest.trust_tier], trustTierRank[right.adapter.manifest.trust_tier]],
  ];

  for (const [leftScore, rightScore] of scores) {
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }
  }

  return left.adapter.manifest.adapter_id.localeCompare(right.adapter.manifest.adapter_id);
};

const compareNodes = (
  left: RuntimeNodeDescriptor,
  right: RuntimeNodeDescriptor,
  criteria: RuntimeSelectionCriteria,
): number => {
  const scores: [number, number][] = [
    [healthRank[left.health.status], healthRank[right.health.status]],
    [matchScore(left.locality, criteria.locality), matchScore(right.locality, criteria.locality)],
    [
      matchScore(left.resource_limits.max_concurrent_execs, undefined),
      matchScore(right.resource_limits.max_concurrent_execs, undefined),
    ],
  ];

  for (const [leftScore, rightScore] of scores) {
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }
  }

  return left.node_id.localeCompare(right.node_id);
};

const matchScore = <T>(value: T | undefined, expected: T | undefined): number => {
  if (value === undefined) {
    return 0;
  }

  if (expected === undefined) {
    return 1;
  }

  return value === expected ? 3 : 0;
};

const localityPreference = (value: RuntimeLocality, required: RuntimeLocality | undefined): number => {
  if (required !== undefined) {
    return value === required ? 5 : 0;
  }

  return localityRank[value];
};

const hasAllCapabilities = (
  declaredCapabilities: { includes(capability: RuntimeCapability): boolean },
  requiredCapabilities: readonly RuntimeCapability[],
): boolean => requiredCapabilities.every((capability) => declaredCapabilities.includes(capability));
