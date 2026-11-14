import { HttpError } from "./http.ts";
import type { Emit, RunEvent, RunEventBody } from "./types.ts";

export type JobManagerOptions = {
  keepEvents?: number;
};

type RunningJob = {
  controller: AbortController;
};

export class JobManager {
  private readonly keepEvents: number;
  private readonly running = new Map<string, RunningJob>();
  private readonly projectEvents = new Map<string, RunEvent[]>();
  private readonly nextIds = new Map<string, number>();
  private readonly subscribers = new Map<string, Set<(e: RunEvent) => void>>();
  private readonly idleWaiters = new Map<string, Set<() => void>>();

  constructor(opts?: JobManagerOptions) {
    this.keepEvents = opts?.keepEvents ?? 2000;
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  runningIds(): string[] {
    return Array.from(this.running.keys());
  }

  subscriberCount(id: string): number {
    return this.subscribers.get(id)?.size ?? 0;
  }

  emit(id: string, body: RunEventBody): RunEvent {
    const curId = this.nextIds.get(id) ?? 1;
    this.nextIds.set(id, curId + 1);

    const event: RunEvent = {
      ...body,
      id: curId,
      at: new Date().toISOString(),
    };

    let list = this.projectEvents.get(id);
    if (!list) {
      list = [];
      this.projectEvents.set(id, list);
    }
    list.push(event);
    if (list.length > this.keepEvents) {
      list.shift();
    }

    const subs = this.subscribers.get(id);
    if (subs) {
      for (const fn of [...subs]) {
        try {
          fn(event);
        } catch {}
      }
    }
    return event;
  }

  start(id: string, work: (emit: Emit, signal: AbortSignal) => Promise<void>): void {
    if (this.isRunning(id)) {
      throw new HttpError(409, "This project is already running.");
    }
    const controller = new AbortController();
    this.running.set(id, { controller });

    const emit: Emit = (body: RunEventBody) => {
      this.emit(id, body);
    };

    (async () => {
      try {
        await work(emit, controller.signal);
      } catch (err) {
        if (controller.signal.aborted) {
          emit({ type: "run-end", status: "cancelled" });
        } else {
          const error = err instanceof Error ? err.message : String(err);
          emit({ type: "run-end", status: "failed", error });
        }
      } finally {
        this.running.delete(id);
        const waiters = this.idleWaiters.get(id);
        if (waiters) {
          this.idleWaiters.delete(id);
          for (const resolve of waiters) {
            try {
              resolve();
            } catch {}
          }
        }
      }
    })();
  }

  cancel(id: string): boolean {
    const job = this.running.get(id);
    if (!job) {
      return false;
    }
    job.controller.abort();
    return true;
  }

  async abortAll(): Promise<void> {
    const ids = Array.from(this.running.keys());
    for (const id of ids) {
      this.cancel(id);
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 3000);
      timer.unref?.();
    });
    try {
      await Promise.race([
        Promise.all(ids.map((id) => this.idle(id))),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  events(id: string, afterId = 0): RunEvent[] {
    const list = this.projectEvents.get(id);
    if (!list) {
      return [];
    }
    return list.filter((e) => e.id > afterId);
  }

  subscribe(id: string, fn: (e: RunEvent) => void): () => void {
    let subs = this.subscribers.get(id);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(id, subs);
    }
    subs.add(fn);
    return () => {
      subs?.delete(fn);
      if (subs && subs.size === 0) {
        this.subscribers.delete(id);
      }
    };
  }

  async idle(id: string): Promise<void> {
    if (!this.isRunning(id)) {
      return;
    }
    return new Promise<void>((resolve) => {
      let waiters = this.idleWaiters.get(id);
      if (!waiters) {
        waiters = new Set();
        this.idleWaiters.set(id, waiters);
      }
      waiters.add(resolve);
    });
  }
}
