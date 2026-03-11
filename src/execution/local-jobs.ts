import { z } from "zod";

import { jobErrorSchema, type Job, type JobStreamEvent, taskPackageSchema, type TaskPackage } from "../contracts/index.ts";
import type { ControlPlaneDatabase, StoredJobWithDiagnostics } from "../db/index.ts";
import { createId } from "../lib/ids.ts";
import type { SandboxNodeAdapter } from "../nodes/adapter-sandbox.ts";
import type { LeaseScheduler } from "../scheduler/scheduler.ts";
import type { InternClient, InternJobEvent } from "../../sdk/intern/index.ts";
import { JobStreamBroker } from "./job-streams.ts";

export const createJobRequestSchema = z.object({
  session_key: z.string().trim().min(1),
  message: z.string().trim().min(1),
  allowed_tools: z.array(z.string().trim().min(1)).default([]),
  meta: z.record(z.string(), z.unknown()).default({}),
  profile_name: z.string().trim().min(1).optional(),
});

export interface LocalJobServiceOptions {
  readonly database: ControlPlaneDatabase;
  readonly internClient: InternClient;
  readonly streamBroker?: JobStreamBroker;
  readonly leaseScheduler?: LeaseScheduler;
  readonly sandboxNodeAdapter?: SandboxNodeAdapter;
}

const terminalStatuses = new Set<Job["status"]>(["completed", "failed", "aborted"]);

export class LocalJobService {
  private readonly streamBroker: JobStreamBroker;
  private readonly backendJobIds = new Map<string, string>();
  private readonly pendingAbortJobs = new Set<string>();

  public constructor(private readonly options: LocalJobServiceOptions) {
    this.streamBroker = options.streamBroker ?? new JobStreamBroker();
  }

  public submitJob(
    workspaceId: string,
    requestInput: z.input<typeof createJobRequestSchema>,
  ): { job_id: string; status: Job["status"]; workspace_id: string } {
    const request = createJobRequestSchema.parse(requestInput);
    const jobId = createId("job");
    const now = new Date().toISOString();
    const taskPackage = this.buildTaskPackage(workspaceId, jobId, request);

    this.options.database.workspace(workspaceId).saveJob({
      job: {
        job_id: jobId,
        workspace_id: workspaceId,
        status: "pending",
        created_at: now,
      },
      task_package: taskPackage,
    });

    this.applyEvent(workspaceId, jobId, taskPackage, {
      event: "job.accepted",
      data: { job_id: jobId },
    });
    this.streamBroker.publish(jobId, {
      event: "job.accepted",
      data: { job_id: jobId },
    });

    if (this.shouldUseRemoteExecution(workspaceId)) {
      void this.runRemoteTask(jobId, workspaceId, taskPackage);
    } else {
      void this.runLocalTurn(jobId, workspaceId, request, taskPackage);
    }

    return {
      job_id: jobId,
      status: "pending",
      workspace_id: workspaceId,
    };
  }

  public getJob(workspaceId: string, jobId: string): StoredJobWithDiagnostics {
    return this.options.database.workspace(workspaceId).getJob(jobId);
  }

  public streamJob(workspaceId: string, jobId: string): ReadableStream<Uint8Array> {
    void this.getJob(workspaceId, jobId);
    return this.streamBroker.stream(jobId);
  }

  public async abortJob(workspaceId: string, jobId: string): Promise<{ ok: boolean; job_id: string }> {
    void this.getJob(workspaceId, jobId);
    const backendJobId = this.backendJobIds.get(jobId);
    if (backendJobId === undefined) {
      this.pendingAbortJobs.add(jobId);
      this.finalizeAbort(workspaceId, jobId);
      return { ok: true, job_id: jobId };
    }

    await this.options.internClient.abortJob(backendJobId);
    this.finalizeAbort(workspaceId, jobId);
    return { ok: true, job_id: jobId };
  }

  private buildTaskPackage(
    workspaceId: string,
    jobId: string,
    request: z.output<typeof createJobRequestSchema>,
  ): TaskPackage {
    return taskPackageSchema.parse({
      workspace_id: workspaceId,
      job_id: jobId,
      kind: "turn",
      instructions: request.message,
      artifacts: [],
      tool_policy: {
        mode: request.allowed_tools.length === 0 ? "allow_all" : "allow_list",
        allowed_tools: request.allowed_tools,
        blocked_tools: [],
      },
      timeout: {
        soft_ms: 60_000,
      },
      lease_profile: {
        profile_id: request.profile_name ?? "local-default",
        ttl_seconds: 300,
        required_capabilities: ["exec"],
      },
      subagent_policy: {
        enabled: false,
        max_depth: 0,
        max_jobs: 0,
      },
      metadata: request.meta,
    });
  }

  private async runLocalTurn(
    jobId: string,
    workspaceId: string,
    request: z.output<typeof createJobRequestSchema>,
    taskPackage: TaskPackage,
  ): Promise<void> {
    let sawTerminalEvent = false;
    try {
      for await (const event of this.options.internClient.submitTurnStream({
        sessionKey: request.session_key,
        message: request.message,
        allowedTools: request.allowed_tools,
        meta: request.meta,
        ...(request.profile_name === undefined ? {} : { profileName: request.profile_name }),
      })) {
        const backendJobId = getStringRecordValue(event.data, "job_id");
        if (backendJobId !== null) {
          this.backendJobIds.set(jobId, backendJobId);
          if (this.pendingAbortJobs.has(jobId)) {
            this.pendingAbortJobs.delete(jobId);
            await this.options.internClient.abortJob(backendJobId);
          }
        }

        const normalized = normalizeInternEvent(jobId, event);
        if (normalized === null) {
          continue;
        }

        if (isTerminalEvent(normalized)) {
          sawTerminalEvent = true;
        }

        this.applyEvent(workspaceId, jobId, taskPackage, normalized);
        this.streamBroker.publish(jobId, normalized);
      }

      if (!sawTerminalEvent) {
        this.finalizeUnexpectedEof(workspaceId, jobId, taskPackage);
      }
    } catch (error) {
      const failure = jobErrorSchema.parse({
        code: "intern_request_failed",
        message: error instanceof Error ? error.message : "Intern request failed",
        retriable: true,
        details: {},
      });
      const stored = this.options.database.workspace(workspaceId).getJob(jobId);
      this.options.database.workspace(workspaceId).saveJob({
        job: {
          ...stored.job,
          status: "failed",
          completed_at: new Date().toISOString(),
          error: failure,
        },
        task_package: taskPackage,
      });
      this.streamBroker.publish(jobId, {
        event: "job.failed",
        data: failure,
      });
    }
  }

  private async runRemoteTask(jobId: string, workspaceId: string, taskPackage: TaskPackage): Promise<void> {
    const scheduler = this.options.leaseScheduler;
    const adapter = this.options.sandboxNodeAdapter;
    if (scheduler === undefined || adapter === undefined) {
      throw new Error("remote execution path is not configured");
    }

    try {
      const lease = scheduler.issueLease({
        workspace_id: workspaceId,
        job_id: jobId,
        task_package: taskPackage,
      });
      this.applyEvent(workspaceId, jobId, taskPackage, {
        event: "job.started",
        data: { job_id: jobId },
      });
      this.streamBroker.publish(jobId, {
        event: "job.started",
        data: { job_id: jobId },
      });

      const result = await adapter.executeTask(workspaceId, taskPackage);
      this.options.database.workspace(workspaceId).saveJob({
        job: {
          ...this.options.database.workspace(workspaceId).getJob(jobId).job,
          status: "completed",
          node_id: lease.lease.node_id,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          result: {
            output_text: `sandbox exit ${String(result.exit_code)}`,
            artifacts: [],
            meta: {
              exit_code: result.exit_code,
              sandbox_id: result.sandbox.id,
            },
          },
        },
        task_package: taskPackage,
      });
      this.streamBroker.publish(jobId, {
        event: "job.completed",
        data: {
          output_text: `sandbox exit ${String(result.exit_code)}`,
          artifacts: [],
          meta: {
            exit_code: result.exit_code,
            sandbox_id: result.sandbox.id,
          },
        },
      });
    } catch (error) {
      const failure = jobErrorSchema.parse({
        code: "remote_execution_failed",
        message: error instanceof Error ? error.message : "Remote execution failed",
        retriable: true,
        details: {},
      });
      this.applyEvent(workspaceId, jobId, taskPackage, { event: "job.failed", data: failure });
      this.streamBroker.publish(jobId, { event: "job.failed", data: failure });
    }
  }

  private applyEvent(
    workspaceId: string,
    jobId: string,
    taskPackage: TaskPackage,
    event: JobStreamEvent,
  ): void {
    const workspaceStore = this.options.database.workspace(workspaceId);
    const stored = workspaceStore.getJob(jobId);
    if (terminalStatuses.has(stored.job.status)) {
      return;
    }
    const now = new Date().toISOString();

    switch (event.event) {
      case "job.accepted":
        workspaceStore.saveJob({
          job: {
            ...stored.job,
            status: "scheduled",
          },
          task_package: taskPackage,
        });
        return;
      case "job.started":
        workspaceStore.saveJob({
          job: {
            ...stored.job,
            status: "running",
            started_at: stored.job.started_at ?? now,
          },
          task_package: taskPackage,
        });
        return;
      case "job.completed":
        workspaceStore.saveJob({
          job: {
            ...stored.job,
            status: "completed",
            started_at: stored.job.started_at ?? now,
            completed_at: now,
            result: event.data,
          },
          task_package: taskPackage,
        });
        return;
      case "job.aborted":
        workspaceStore.saveJob({
          job: {
            ...stored.job,
            status: "aborted",
            started_at: stored.job.started_at ?? now,
            completed_at: now,
          },
          task_package: taskPackage,
        });
        return;
      case "job.failed":
        workspaceStore.saveJob({
          job: {
            ...stored.job,
            status: "failed",
            started_at: stored.job.started_at ?? now,
            completed_at: now,
            error: event.data,
          },
          task_package: taskPackage,
        });
        return;
      case "text.delta":
      case "tool.call":
      case "tool.result":
        return;
      default:
        return;
    }
  }

  private shouldUseRemoteExecution(workspaceId: string): boolean {
    if (this.options.leaseScheduler === undefined || this.options.sandboxNodeAdapter === undefined) {
      return false;
    }

    return this.options.database
      .workspace(workspaceId)
      .listNodes()
      .some((node) => node.status === "approved" && node.health_status !== "stale");
  }

  private finalizeAbort(workspaceId: string, jobId: string): void {
    const stored = this.options.database.workspace(workspaceId).getJob(jobId);
    if (terminalStatuses.has(stored.job.status)) {
      return;
    }

    this.options.database.workspace(workspaceId).saveJob({
      job: {
        ...stored.job,
        status: "aborted",
        completed_at: new Date().toISOString(),
        started_at: stored.job.started_at ?? new Date().toISOString(),
      },
      task_package: stored.task_package,
    });
    this.streamBroker.publish(jobId, { event: "job.aborted", data: { job_id: jobId } });
  }

  private finalizeUnexpectedEof(workspaceId: string, jobId: string, taskPackage: TaskPackage): void {
    const stored = this.options.database.workspace(workspaceId).getJob(jobId);
    if (terminalStatuses.has(stored.job.status)) {
      return;
    }

    const failure = jobErrorSchema.parse({
      code: "intern_stream_ended_without_terminal_event",
      message: "Intern stream ended without a terminal event",
      retriable: true,
      details: {},
    });
    this.options.database.workspace(workspaceId).saveJob({
      job: {
        ...stored.job,
        status: "failed",
        started_at: stored.job.started_at ?? new Date().toISOString(),
        completed_at: new Date().toISOString(),
        error: failure,
      },
      task_package: taskPackage,
    });
    this.streamBroker.publish(jobId, { event: "job.failed", data: failure });
  }
}

const isTerminalEvent = (event: JobStreamEvent): boolean =>
  event.event === "job.completed" || event.event === "job.failed" || event.event === "job.aborted";

const normalizeInternEvent = (jobId: string, event: InternJobEvent): JobStreamEvent | null => {
  switch (event.event) {
    case "queued":
      return null;
    case "started":
      return { event: "job.started", data: { job_id: jobId } };
    case "text_delta":
      return { event: "text.delta", data: { text: getStringRecordValue(event.data, "content") ?? "" } };
    case "tool_call":
      return { event: "tool.call", data: { name: getStringRecordValue(event.data, "name") ?? "unknown" } };
    case "tool_result":
      return {
        event: "tool.result",
        data: {
          name: getStringRecordValue(event.data, "name") ?? "unknown",
          result: stringifyRecordValue(event.data["result"]),
        },
      };
    case "completion": {
      const status = getStringRecordValue(event.data, "status");
      if (status === "aborted") {
        return { event: "job.aborted", data: { job_id: jobId } };
      }
      return {
        event: "job.completed",
        data: {
          output_text: getStringRecordValue(event.data, "final_text") ?? "",
          artifacts: [],
          meta: filterRecordValues(event.data),
        },
      };
    }
    case "error":
    case "runtime_error":
      return {
        event: "job.failed",
        data: {
          code: "intern_error",
          message: getStringRecordValue(event.data, "message") ?? "Intern job failed",
          retriable: false,
          details: filterRecordValues(event.data),
        },
      };
    default:
      return null;
  }
};

const getStringRecordValue = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];
  return typeof value === "string" ? value : null;
};

const stringifyRecordValue = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
};

const filterRecordValues = (record: Record<string, unknown>): Record<string, string | number | boolean | null> => {
  const filtered: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      filtered[key] = value;
    }
  }
  return filtered;
};