import type { JobStreamEvent } from "../contracts/index.ts";
import { normalizeLegacyJobStreamEvent } from "../contracts/platform/compat.ts";

interface JobStreamState {
  readonly history: JobStreamEvent[];
  readonly subscribers: Set<(event: JobStreamEvent) => void>;
  terminal: boolean;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
}

export class JobStreamBroker {
  private readonly streams = new Map<string, JobStreamState>();

  public constructor(private readonly terminalRetentionMs = 60_000) {}

  public publish(jobId: string, event: JobStreamEvent): void {
    const state = this.ensure(jobId);
    state.history.push(event);
    if (event.event === "job.completed" || event.event === "job.failed" || event.event === "job.aborted") {
      state.terminal = true;
      this.scheduleCleanup(jobId, state);
    }
    for (const subscriber of state.subscribers) {
      subscriber(event);
    }
  }

  public history(jobId: string): JobStreamEvent[] {
    return [...this.ensure(jobId).history];
  }

  public stream(jobId: string): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const state = this.ensure(jobId);
    let subscriber: ((event: JobStreamEvent) => void) | null = null;

    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        if (state.cleanupTimer !== null) {
          clearTimeout(state.cleanupTimer);
          state.cleanupTimer = null;
        }
        for (const event of state.history) {
          controller.enqueue(encoder.encode(formatSseEvent(event)));
        }

        if (state.terminal) {
          this.scheduleCleanup(jobId, state);
          controller.close();
          return;
        }

        subscriber = (event: JobStreamEvent): void => {
          controller.enqueue(encoder.encode(formatSseEvent(event)));
          if (event.event === "job.completed" || event.event === "job.failed" || event.event === "job.aborted") {
            if (subscriber !== null) {
              state.subscribers.delete(subscriber);
            }
            this.scheduleCleanup(jobId, state);
            controller.close();
          }
        };

        state.subscribers.add(subscriber);
      },
      cancel: () => {
        if (subscriber !== null) {
          state.subscribers.delete(subscriber);
          this.scheduleCleanup(jobId, state);
        }
      },
    });
  }

  public has(jobId: string): boolean {
    return this.streams.has(jobId);
  }

  private ensure(jobId: string): JobStreamState {
    const existing = this.streams.get(jobId);
    if (existing !== undefined) {
      return existing;
    }

    const created: JobStreamState = {
      history: [],
      subscribers: new Set(),
      terminal: false,
      cleanupTimer: null,
    };
    this.streams.set(jobId, created);
    return created;
  }

  private scheduleCleanup(jobId: string, state: JobStreamState): void {
    if (!state.terminal || state.subscribers.size > 0) {
      return;
    }
    if (state.cleanupTimer !== null) {
      clearTimeout(state.cleanupTimer);
    }
    state.cleanupTimer = setTimeout(() => {
      const current = this.streams.get(jobId);
      if (current?.terminal && current.subscribers.size === 0) {
        this.streams.delete(jobId);
      }
    }, this.terminalRetentionMs);
  }
}

const formatSseEvent = (event: JobStreamEvent): string => {
  const normalized = normalizeLegacyJobStreamEvent(event);
  return `event: ${normalized.event}\ndata: ${JSON.stringify(normalized.data)}\n\n`;
};