
/**
 * @module src/nodes/capabilities
 *
 * Purpose:
 * Normalizes node capability declarations into the specific service-launch truth
 * model used by OR3 Net.
 *
 * Responsibilities:
 * - Keep `service-launch` as the explicit launch gate
 * - Parse `service:<id>:<port>[:label]` capability descriptors
 * - Hide service actions when a node has descriptors but not the launch gate
 */
import type { NodeServiceDescriptor } from "./execution-adapter.ts";

/** Purpose: Explicit capability required before service actions are surfaced. */
export const nodeServiceLaunchCapability = "service-launch" as const;

const nodeServiceCapabilityPrefix = "service:";

export const nodeAdvertisesServiceLaunch = (node: { manifest: { capabilities: readonly string[] } }): boolean =>
  node.manifest.capabilities.includes(nodeServiceLaunchCapability);

export const listAdvertisedNodeServices = (node: { manifest: { capabilities: readonly string[] } }): NodeServiceDescriptor[] => {
  if (!nodeAdvertisesServiceLaunch(node)) {
    return [];
  }

  return node.manifest.capabilities
    .filter((capability) => capability.startsWith(nodeServiceCapabilityPrefix))
    .map(parseAdvertisedNodeServiceCapability)
    .filter((service): service is NodeServiceDescriptor => service !== null);
};

const parseAdvertisedNodeServiceCapability = (capability: string): NodeServiceDescriptor | null => {
  const [, serviceId, port, ...labelParts] = capability.split(":");
  const targetPort = Number.parseInt(port ?? "", 10);
  if (!serviceId || !Number.isInteger(targetPort) || targetPort <= 0) {
    return null;
  }
  const label = labelParts.join(":").trim();
  return {
    service_id: serviceId,
    label: label === "" ? serviceId : label,
    status: "ready",
    launchable: true,
    target_port: targetPort,
  };
};
