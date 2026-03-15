/**
 * @module src/scheduler/index
 *
 * Purpose:
 * Barrel export for lease scheduling helpers.
 */
export * from "./scheduler.ts";

/** Purpose: Lightweight view of a scheduler candidate node and its active lease count. */
export interface SchedulerCandidate {
  readonly node_id: string;
  readonly active_leases: number;
}