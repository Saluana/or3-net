import { z } from "zod";

import { jobErrorSchema, type Job, type JobResult, type JobStreamEvent, taskPackageSchema, type TaskPackage } from "../contracts/index.ts";
import { auditContextSchema, type AuditContext, type PlatformSessionRef } from "../contracts/platform/types.ts";
import type {
  ControlPlaneDatabase,
  StartupReconciliationSummary,
  StoredJobEvent,
  StoredJobWithDiagnostics,
  StoredNetworkSession,
  StoredNode,
} from "../db/index.ts";
import { createId } from "../lib/ids.ts";
import type { RemoteNodeExecutor } from "../nodes/executor.ts";
import type { SandboxNodeAdapter } from "../nodes/adapter-sandbox.ts";
import type { LeaseScheduler } from "../scheduler/scheduler.ts";
import {
  isRemoteExecutionError,
  remoteExecutionErrorToJobError,
  toRemoteExecutionError,
  type NodeExecutionHandle,
} from "../nodes/transport.ts";
import type { InternClient, InternJobEvent } from "../../sdk/intern/index.ts";
import type { SandboxExecEvent } from "../../sdk/sandbox/index.ts";
import { JobStreamBroker } from "./job-streams.ts";
import { SessionBindingService } from "../session/service.ts";
import { normalizeInternError, normalizeSandboxError, toPlatformSessionRef } from "../contracts/platform/compat.ts";

export const createJobRequestSchema = z.object({
  session_key: z.string().trim().min(1).optional(),
  network_session_id: z.string().trim().min(1).optional(),
  client_kind: z.string().trim().min(1).optional(),
  client_session_id: z.string().trim().min(1).optional(),
  message: z.string().trim().min(1),
  allowed_tools: z.array(z.string().trim().min(1)).default([]),
  meta: z.record(z.string(), z.unknown()).default({}),
  profile_name: z.string().trim().min(1).optional(),
  execution_target: z.enum(["local", "remote"]).default("local"),
}).superRefine((value, ctx) => {
  if (value.network_session_id === undefined && value.session_key === undefined && value.client_session_id === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["session_key"],
      message: "job submission requires network_session_id, client_session_id, or session_key",
    });
  }

  if (value.client_session_id !== undefined && value.client_kind === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["client_kind"],
      message: "client_kind is required when client_session_id is provided",
    });
  }
});

export interface LocalJobServiceOptions {
  readonly database: ControlPlaneDatabase;
  readonly internClient: InternClient;
  readonly streamBroker?: JobStreamBroker;
  readonly leaseScheduler?: LeaseScheduler;
  readonly sandboxNodeAdapter?: SandboxNodeAdapter;
  readonly remoteNodeExecutor?: RemoteNodeExecutor;
  readonly sessionBindingService?: SessionBindingService;
  readonly reconcileOnStartup?: boolean;
  readonly startupReconciliationNowMs?: number;
}

interface SubmitJobOptions {
  readonly initiator_subject?: string;
  readonly request_id?: string;
}

interface LiveJobState {
  readonly workspaceId: string;
  readonly taskPackage: TaskPackage;
  readonly networkSessionId: string | null;
  job: Job;
}

const terminalStatuses = new Set<Job["status"]>(["completed", "failed", "aborted"]);

export class LocalJobService {
  private readonly streamBroker: JobStreamBroker;
  private readonly sessionBindingService: SessionBindingService;
  private readonly backendJobIds = new Map<string, string>();
  private readonly pendingAbortJobs = new Set<string>();
  private readonly activeRemoteRuns = new Map<string, { workspaceId: string; leaseId: string; run: NodeExecutionHandle }>();
  private readonly liveJobs = new Map<string, LiveJobState>();
  private readonly startupReconciliationSummary: StartupReconciliationSummary | null;

  public constructor(private readonly options: LocalJobServiceOptions) {
    this.streamBroker = options.streamBroker ?? new JobStreamBroker();
    this.sessionBindingService = options.sessionBindingService ?? new SessionBindingService(options.database);
    this.startupReconciliationSummary =
      options.reconcileOnStartup === false
        ? null
        : options.database.reconcileStartupState(options.startupReconciliationNowMs);
  }

  public getStartupReconciliationSummary(): StartupReconciliationSummary | null {
    return this.startupReconciliationSummary;
  }

  public submitJob(
    workspaceId: string,
    requestInput: z.input<typeof createJobRequestSchema>,
    options: SubmitJobOptions = {},
  ): { job_id: string; status: Job["status"]; workspace_id: string } {
    const request = createJobRequestSchema.parse(requestInput);
    const jobId = createId("job");
    const now = new Date().toISOString();
    const resolvedSessionBinding = this.sessionBindingService.resolvePlatformSessionBinding({
      workspace_id: workspaceId,
      ...(request.network_session_id === undefined ? {} : { network_session_id: request.network_session_id }),
      ...(request.client_kind === undefined ? {} : { client_kind: request.client_kind }),
      ...(request.client_session_id === undefined ? {} : { client_session_id: request.client_session_id }),
      ...(request.session_key === undefined ? {} : { session_key: request.session_key }),
      ...(options.initiator_subject === undefined ? {} : { initiator_subject: options.initiator_subject }),
    });
    const sessionBinding = resolvedSessionBinding.binding;
    const auditContext: AuditContext = {
      request_id: options.request_id ?? createId("req"),
      workspace_id: workspaceId,
      subject: options.initiator_subject ?? "system",
      network_session_id: sessionBinding.network_session_id,
      session_key: sessionBinding.intern_session_key,
      job_id: jobId,
    };
    const taskPackage = this.buildTaskPackage(workspaceId, jobId, sessionBinding, request, auditContext);
    const initialJob: Job = {
      job_id: jobId,
      workspace_id: workspaceId,
      status: "pending",
      created_at: now,
    };

    this.options.database.workspace(workspaceId).saveJob({
      job: initialJob,
      task_package: taskPackage,
      network_session_id: sessionBinding.network_session_id,
    });
    this.liveJobs.set(jobId, {
      workspaceId,
      taskPackage,
      networkSessionId: sessionBinding.network_session_id,
      job: initialJob,
    });
    this.sessionBindingService.touchBinding(workspaceId, sessionBinding.network_session_id, {
      last_job_id: jobId,
    });

    const accepted = this.applyEvent(workspaceId, jobId, taskPackage, {
      event: "job.accepted",
      data: { job_id: jobId },
    });
    if (accepted) {
      this.streamBroker.publish(jobId, {
        event: "job.accepted",
        data: { job_id: jobId },
      });
    }

    if (this.shouldUseRemoteExecution(workspaceId, request.execution_target)) {
      void this.runRemoteTask(jobId, workspaceId, taskPackage);
    } else if (request.execution_target === "remote") {
      this.publishIfApplied(workspaceId, jobId, taskPackage, {
        event: "job.failed",
        data: jobErrorSchema.parse({
          code: "remote_execution_start_failed",
          message: "no eligible remote node is available for this workspace",
          retriable: true,
          details: {
            workspace_id: workspaceId,
          },
        }),
      });
    } else {
      void this.runLocalTurn(jobId, workspaceId, resolvedSessionBinding.platform_session_ref, auditContext, request, taskPackage);
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

  public listJobs(workspaceId: string, input: { status?: "running" | "terminal" | "all"; network_session_id?: string } = {}): StoredJobWithDiagnostics[] {
    return this.options.database.workspace(workspaceId).listJobsByFilter(input.status, input.network_session_id);
  }

  public listSessions(workspaceId: string): StoredNetworkSession[] {
    return this.sessionBindingService.listBindings(workspaceId);
  }

  public getSession(workspaceId: string, sessionId: string): StoredNetworkSession {
    return this.sessionBindingService.getBinding(workspaceId, sessionId);
  }

  public listSessionJobs(workspaceId: string, sessionId: string): StoredJobWithDiagnostics[] {
    return this.options.database.workspace(workspaceId).listJobsByFilter("all", sessionId);
  }

  public listSessionEvents(workspaceId: string, sessionId: string): StoredJobEvent[] {
    return this.options.database.workspace(workspaceId).listJobEvents({ network_session_id: sessionId });
  }

  public streamJob(workspaceId: string, jobId: string): ReadableStream<Uint8Array> {
    void this.getJob(workspaceId, jobId);
    return this.streamBroker.stream(jobId);
  }

  public async abortJob(workspaceId: string, jobId: string): Promise<{ ok: boolean; job_id: string }> {
    const stored = this.getJob(workspaceId, jobId);
    if (terminalStatuses.has(stored.job.status)) {
      return { ok: true, job_id: jobId };
    }
    const activeRemoteRun = this.activeRemoteRuns.get(jobId);
    if (activeRemoteRun !== undefined) {
      try {
        this.pendingAbortJobs.add(jobId);
        await activeRemoteRun.run.abort();
        this.finalizeRemoteRun(workspaceId, jobId, "released");
        this.finalizeAbort(workspaceId, jobId);
        this.pendingAbortJobs.delete(jobId);
        return { ok: true, job_id: jobId };
      } catch (error) {
        this.pendingAbortJobs.delete(jobId);
        this.finalizeRemoteRun(workspaceId, jobId, "failed");
        this.publishIfApplied(workspaceId, jobId, this.options.database.workspace(workspaceId).getJob(jobId).task_package, {
          event: "job.failed",
          data: remoteExecutionErrorToJobError(
            toRemoteExecutionError(error, "remote_abort_failed", { job_id: jobId, workspace_id: workspaceId }),
          ),
        });
        throw error;
      }
    }

    const backendJobId = this.backendJobIds.get(jobId);
    if (backendJobId === undefined) {
      this.pendingAbortJobs.add(jobId);
      const activeLease = this.options.database
        .workspace(workspaceId)
        .listLeases()
        .find((lease) => lease.job_id === jobId && lease.lease.state === "active");
      if (activeLease !== undefined) {
        this.options.leaseScheduler?.releaseLease(workspaceId, activeLease.lease.lease_id);
      }
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
    sessionBinding: ReturnType<SessionBindingService["resolveBinding"]>,
    request: z.output<typeof createJobRequestSchema>,
    auditContext: AuditContext,
  ): TaskPackage {
    const platformSessionRef = toPlatformSessionRef(sessionBinding);

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
      metadata: {
        ...request.meta,
        network_session_id: sessionBinding.network_session_id,
        intern_session_key: sessionBinding.intern_session_key,
        platform_session_ref: platformSessionRef,
        audit_context: auditContext,
        execution_target: request.execution_target,
        ...(request.client_kind === undefined ? {} : { client_kind: request.client_kind }),
        ...(request.client_session_id === undefined ? {} : { client_session_id: request.client_session_id }),
      },
    });
  }

  private async runLocalTurn(
    jobId: string,
    workspaceId: string,
    platformSessionRef: PlatformSessionRef,
    auditContext: AuditContext,
    request: z.output<typeof createJobRequestSchema>,
    taskPackage: TaskPackage,
  ): Promise<void> {
    let sawTerminalEvent = false;
    try {
      for await (const event of this.options.internClient.submitTurnStream({
        sessionKey: platformSessionRef.session_key,
        platformSessionRef,
        requestContext: {
          requestId: auditContext.request_id,
          workspaceId: auditContext.workspace_id,
          ...(auditContext.network_session_id === undefined
            ? {}
            : { networkSessionId: auditContext.network_session_id }),
        },
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

        const applied = this.applyEvent(workspaceId, jobId, taskPackage, normalized);
        if (applied) {
          this.streamBroker.publish(jobId, normalized);
        }
      }

      if (!sawTerminalEvent) {
        this.finalizeUnexpectedEof(workspaceId, jobId, taskPackage);
      }
    } catch (error) {
      const failure = toJobErrorFromEnvelope(normalizeInternError(error, auditContext.request_id));
      const failureEvent: JobStreamEvent = {
        event: "job.failed",
        data: failure,
      };
      if (this.applyEvent(workspaceId, jobId, taskPackage, failureEvent)) {
        this.streamBroker.publish(jobId, failureEvent);
      }
    }
  }

  private async runRemoteTask(jobId: string, workspaceId: string, taskPackage: TaskPackage): Promise<void> {
    const scheduler = this.options.leaseScheduler;
    if (scheduler === undefined) {
      throw new Error("remote execution path is not configured");
    }

    try {
      const lease = scheduler.issueLease({
        workspace_id: workspaceId,
        job_id: jobId,
        task_package: taskPackage,
      });
      const node = this.options.database.workspace(workspaceId).getNode(lease.lease.node_id);
      this.options.database.workspace(workspaceId).attachLease(jobId, lease.lease.lease_id, node.manifest.node_id);
      const liveJob = this.getOrHydrateLiveJobState(workspaceId, jobId, taskPackage);
      liveJob.job = {
        ...liveJob.job,
        node_id: node.manifest.node_id,
      };

      if (node.manifest.adapter_kind === "sandbox") {
        this.publishIfApplied(workspaceId, jobId, taskPackage, {
          event: "job.started",
          data: { job_id: jobId },
        });
        let terminalEventCount = 0;
        const result = await this.executeRemoteTask(workspaceId, node.manifest.adapter_kind, node, taskPackage, (event) => {
          if (isTerminalEvent(event)) {
            terminalEventCount += 1;
          }
          this.publishIfApplied(workspaceId, jobId, taskPackage, event);
        });
        if (terminalEventCount === 0) {
          this.publishIfApplied(workspaceId, jobId, taskPackage, {
            event: "job.completed",
            data: result,
          });
        }
        return;
      }

      const executor = this.options.remoteNodeExecutor;
      if (!executor?.canExecute(node)) {
        throw new Error(`no remote executor is registered for node ${node.manifest.node_id}`);
      }

      const run = await executor.startExecution(node, taskPackage);
      this.activeRemoteRuns.set(jobId, { workspaceId, leaseId: lease.lease.lease_id, run });
      this.publishIfApplied(workspaceId, jobId, taskPackage, {
        event: "job.started",
        data: { job_id: jobId },
      });
      if (this.pendingAbortJobs.delete(jobId)) {
        void run.result.catch(() => undefined);
        await run.abort();
        this.finalizeRemoteRun(workspaceId, jobId, "released");
        this.finalizeAbort(workspaceId, jobId);
        this.pendingAbortJobs.delete(jobId);
        return;
      }
      const [result] = await Promise.all([
        run.result,
        this.publishRemoteStream(workspaceId, jobId, taskPackage, run.stream),
      ]);
      this.publishIfApplied(workspaceId, jobId, taskPackage, {
        event: "job.completed",
        data: result,
      });
    } catch (error) {
      if (this.pendingAbortJobs.has(jobId) || terminalStatuses.has(this.options.database.workspace(workspaceId).getJob(jobId).job.status)) {
        return;
      }

      const failure = toRemoteExecutionJobError(error, this.options.database.workspace(workspaceId).getJob(jobId).job.status === "running" ? "running" : "starting", {
        job_id: jobId,
        workspace_id: workspaceId,
        request_id: getAuditContextFromTaskPackage(taskPackage)?.request_id,
      });
      const failureEvent: JobStreamEvent = { event: "job.failed", data: failure };
      if (this.applyEvent(workspaceId, jobId, taskPackage, failureEvent)) {
        this.streamBroker.publish(jobId, failureEvent);
      }
    } finally {
      this.finalizeRemoteRun(workspaceId, jobId, "released");
    }
  }

  private finalizeRemoteRun(workspaceId: string, jobId: string, leaseState: "released" | "failed"): void {
    const activeRemoteRun = this.activeRemoteRuns.get(jobId);
    if (activeRemoteRun !== undefined) {
      this.activeRemoteRuns.delete(jobId);
      this.options.leaseScheduler?.releaseLease(workspaceId, activeRemoteRun.leaseId, leaseState);
      return;
    }

    const lease = this.options.database
      .workspace(workspaceId)
      .listLeases()
      .find((item) => item.job_id === jobId && item.lease.state === "active");
    if (lease !== undefined) {
      this.options.leaseScheduler?.releaseLease(workspaceId, lease.lease.lease_id, leaseState);
    }
  }

  private async publishRemoteStream(
    workspaceId: string,
    jobId: string,
    taskPackage: TaskPackage,
    stream?: AsyncIterable<JobStreamEvent>,
  ): Promise<void> {
    if (stream === undefined) {
      return;
    }

    try {
      for await (const event of stream) {
        this.publishIfApplied(workspaceId, jobId, taskPackage, event);
      }
    } catch (error) {
      throw toRemoteExecutionError(error, "remote_transport_disconnected", {
        job_id: jobId,
        workspace_id: workspaceId,
      });
    }
  }

  private publishIfApplied(workspaceId: string, jobId: string, taskPackage: TaskPackage, event: JobStreamEvent): void {
    if (this.applyEvent(workspaceId, jobId, taskPackage, event)) {
      this.streamBroker.publish(jobId, event);
    }
  }

  private applyEvent(
    workspaceId: string,
    jobId: string,
    taskPackage: TaskPackage,
    event: JobStreamEvent,
  ): boolean {
    const liveJob = this.getOrHydrateLiveJobState(workspaceId, jobId, taskPackage);
    if (terminalStatuses.has(liveJob.job.status)) {
      return false;
    }

    const now = new Date().toISOString();
    let nextJob: Job | null = null;

    switch (event.event) {
      case "job.accepted":
        nextJob = {
          ...liveJob.job,
          status: "scheduled",
        };
        break;
      case "job.started":
        nextJob = {
          ...liveJob.job,
          status: "running",
          started_at: liveJob.job.started_at ?? now,
        };
        break;
      case "job.completed":
        nextJob = {
          ...liveJob.job,
          status: "completed",
          started_at: liveJob.job.started_at ?? now,
          completed_at: now,
          result: event.data,
        };
        break;
      case "job.aborted":
        nextJob = {
          ...liveJob.job,
          status: "aborted",
          started_at: liveJob.job.started_at ?? now,
          completed_at: now,
        };
        break;
      case "job.failed":
        nextJob = {
          ...liveJob.job,
          status: "failed",
          started_at: liveJob.job.started_at ?? now,
          completed_at: now,
          error: event.data,
        };
        break;
      case "text.delta":
      case "tool.call":
      case "tool.result":
        return true;
      default:
        return false;
    }

    if (nextJob === null) {
      return false;
    }

    this.persistLiveJobState(liveJob, nextJob);
    this.persistDurableEvent(workspaceId, liveJob.networkSessionId, jobId, event, getAuditContextFromTaskPackage(taskPackage));
    if (liveJob.networkSessionId !== null) {
      this.sessionBindingService.touchBinding(workspaceId, liveJob.networkSessionId, {
        last_job_id: jobId,
        ...(isTerminalEvent(event) ? { status: "active" } : {}),
      });
    }

    return true;
  }

  private shouldUseRemoteExecution(workspaceId: string, executionTarget: "local" | "remote"): boolean {
    if (executionTarget !== "remote") {
      return false;
    }
    if (this.options.leaseScheduler === undefined) {
      return false;
    }

    return this.options.database
      .workspace(workspaceId)
      .listNodes()
      .some(
        (node) =>
          node.status === "approved" &&
          node.health_status !== "stale" &&
          ((node.manifest.adapter_kind === "sandbox" && this.options.sandboxNodeAdapter !== undefined) ||
            (this.options.remoteNodeExecutor?.canExecute(node) ?? false)),
      );
  }

  private async executeRemoteTask(
    workspaceId: string,
    adapterKind: string,
    node: StoredNode,
    taskPackage: TaskPackage,
    onEvent?: (event: JobStreamEvent) => void,
  ): Promise<JobResult> {
    if (adapterKind === "sandbox") {
      const adapter = this.options.sandboxNodeAdapter;
      if (adapter === undefined) {
        throw new Error("sandbox node adapter is not configured");
      }

      const result = await adapter.executeTaskWithProgress(workspaceId, taskPackage, (event) => {
        const normalized = normalizeSandboxExecEvent(event);
        if (normalized !== null) {
          onEvent?.(normalized);
        }
      });
      return {
        output_text: `sandbox exit ${String(result.exit_code)}`,
        artifacts: [],
        meta: {
          exit_code: result.exit_code,
          sandbox_id: result.sandbox.id,
        },
      };
    }

    const executor = this.options.remoteNodeExecutor;
    if (!executor?.canExecute(node)) {
      throw new Error(`no remote executor is registered for node ${node.manifest.node_id}`);
    }

    return executor.executeTask(node, taskPackage);
  }

  private finalizeAbort(workspaceId: string, jobId: string): void {
    const liveJob = this.getOrHydrateLiveJobState(workspaceId, jobId);
    if (terminalStatuses.has(liveJob.job.status)) {
      return;
    }

    const now = new Date().toISOString();
    const nextJob: Job = {
      ...liveJob.job,
      status: "aborted",
      completed_at: now,
      started_at: liveJob.job.started_at ?? now,
    };
    this.persistLiveJobState(liveJob, nextJob);
    const event: JobStreamEvent = { event: "job.aborted", data: { job_id: jobId } };
    this.persistDurableEvent(workspaceId, liveJob.networkSessionId, jobId, event, getAuditContextFromTaskPackage(liveJob.taskPackage));
    this.streamBroker.publish(jobId, event);
  }

  private finalizeUnexpectedEof(workspaceId: string, jobId: string, taskPackage: TaskPackage): void {
    const liveJob = this.getOrHydrateLiveJobState(workspaceId, jobId, taskPackage);
    if (terminalStatuses.has(liveJob.job.status)) {
      return;
    }

    const failure = jobErrorSchema.parse({
      code: "intern_stream_ended_without_terminal_event",
      message: "Intern stream ended without a terminal event",
      retriable: true,
      details: {},
    });
    const now = new Date().toISOString();
    this.persistLiveJobState(liveJob, {
      ...liveJob.job,
      status: "failed",
      started_at: liveJob.job.started_at ?? now,
      completed_at: now,
      error: failure,
    });
    const event: JobStreamEvent = { event: "job.failed", data: failure };
    this.persistDurableEvent(workspaceId, liveJob.networkSessionId, jobId, event, getAuditContextFromTaskPackage(liveJob.taskPackage));
    this.streamBroker.publish(jobId, event);
  }

  private persistDurableEvent(
    workspaceId: string,
    networkSessionId: string | null,
    jobId: string,
    event: JobStreamEvent,
    auditContext?: AuditContext,
  ): void {
    this.options.database.workspace(workspaceId).appendJobEvent({
      job_id: jobId,
      ...(networkSessionId === null ? {} : { network_session_id: networkSessionId }),
      event_type: event.event,
      payload: summarizeEventData(event, auditContext),
    });
  }

  private getOrHydrateLiveJobState(workspaceId: string, jobId: string, taskPackage?: TaskPackage): LiveJobState {
    const existing = this.liveJobs.get(jobId);
    if (existing !== undefined) {
      return existing;
    }

    const stored = this.options.database.workspace(workspaceId).getJob(jobId);
    const hydrated: LiveJobState = {
      workspaceId,
      taskPackage: taskPackage ?? stored.task_package,
      networkSessionId: stored.network_session_id,
      job: stored.job,
    };
    this.liveJobs.set(jobId, hydrated);
    return hydrated;
  }

  private persistLiveJobState(liveJob: LiveJobState, nextJob: Job): void {
    this.options.database.workspace(liveJob.workspaceId).saveJob({
      job: nextJob,
      task_package: liveJob.taskPackage,
      ...(liveJob.networkSessionId === null ? {} : { network_session_id: liveJob.networkSessionId }),
    });
    liveJob.job = nextJob;
    if (terminalStatuses.has(nextJob.status)) {
      this.liveJobs.delete(nextJob.job_id);
    }
  }
}

const isTerminalEvent = (event: JobStreamEvent): boolean =>
  event.event === "job.completed" || event.event === "job.failed" || event.event === "job.aborted";

const toRemoteExecutionJobError = (
  error: unknown,
  phase: "starting" | "running",
  details: Record<string, unknown>,
): NonNullable<Job["error"]> => {
  const requestId = typeof details["request_id"] === "string" ? details["request_id"] : createId("req");
  if (error instanceof Error && error.name === "SandboxRequestError") {
    return toJobErrorFromEnvelope(normalizeSandboxError(error, requestId));
  }
  if (error instanceof Error && error.name === "InternRequestError") {
    return toJobErrorFromEnvelope(normalizeInternError(error, requestId));
  }
  if (isRemoteExecutionError(error)) {
    return jobErrorSchema.parse(remoteExecutionErrorToJobError(error));
  }

  const fallbackCode =
    phase === "starting"
      ? "remote_execution_start_failed"
      : isDisconnectLikeError(error)
        ? "remote_transport_disconnected"
        : "remote_execution_failed";
  return jobErrorSchema.parse(remoteExecutionErrorToJobError(toRemoteExecutionError(error, fallbackCode, details)));
};

const isDisconnectLikeError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  return /(disconnect|connection closed|socket closed|ended without a terminal event)/i.test(error.message);
};

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

const normalizeSandboxExecEvent = (event: SandboxExecEvent): JobStreamEvent | null => {
  switch (event.event) {
    case "stdout":
    case "stderr": {
      const chunk = getStringRecordValue(event.data, "chunk") ?? "";
      if (chunk === "") {
        return null;
      }
      return { event: "text.delta", data: { text: chunk } };
    }
    case "result":
      return {
        event: "job.completed",
        data: {
          output_text: `sandbox exit ${String(getNumberRecordValue(event.data, "exit_code") ?? 0)}`,
          artifacts: [],
          meta: filterRecordValues(event.data),
        },
      };
    case "error":
      return {
        event: "job.failed",
        data: {
          code: getStringRecordValue(event.data, "code") ?? "sandbox_error",
          message: getStringRecordValue(event.data, "message") ?? "Sandbox execution failed",
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

const getNumberRecordValue = (record: Record<string, unknown>, key: string): number | null => {
  const value = record[key];
  return typeof value === "number" ? value : null;
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

const summarizeEventData = (event: JobStreamEvent, auditContext?: AuditContext): Record<string, unknown> => {
  const auditSummary = auditContext === undefined ? {} : { audit_context: auditContext };
  switch (event.event) {
    case "job.accepted":
    case "job.started":
    case "job.aborted":
      return { job_id: event.data.job_id, ...auditSummary };
    case "text.delta":
      return { text: event.data.text, ...auditSummary };
    case "tool.call":
      return { name: event.data.name, ...auditSummary };
    case "tool.result":
      return { name: event.data.name, result: event.data.result, ...auditSummary };
    case "job.completed":
      return {
        output_text: event.data.output_text ?? "",
        artifact_count: event.data.artifacts.length,
        meta: event.data.meta,
        ...auditSummary,
      };
    case "job.failed":
      return {
        code: event.data.code,
        message: event.data.message,
        retriable: event.data.retriable,
        ...auditSummary,
      };
  }
};

const getAuditContextFromTaskPackage = (taskPackage: TaskPackage): AuditContext | undefined => {
  const parsed = auditContextSchema.safeParse(taskPackage.metadata["audit_context"]);
  return parsed.success ? parsed.data : undefined;
};

const toJobErrorFromEnvelope = (envelope: ReturnType<typeof normalizeInternError>): NonNullable<Job["error"]> =>
  jobErrorSchema.parse({
    code: envelope.code,
    message: envelope.error,
    retriable: envelope.status >= 500 || envelope.status === 429,
    details: {
      status: envelope.status,
      request_id: envelope.request_id,
      ...(envelope.retry_after_ms === undefined ? {} : { retry_after_ms: envelope.retry_after_ms }),
    },
  });
