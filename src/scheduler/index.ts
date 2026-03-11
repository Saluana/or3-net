export * from "./scheduler.ts";

export interface SchedulerCandidate {
  readonly node_id: string;
  readonly active_leases: number;
}