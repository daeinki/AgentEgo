import cron, { type ScheduledTask } from 'node-cron';
import type {
  CronTask,
  CronTaskType,
  TaskHistory,
  TaskRunResult,
  TaskRunner,
} from './types.js';

/**
 * Read-only descriptor shape surfaced over RPC `cron.list`. Matches
 * gateway-cli's `CronTaskDescriptor` structurally so the scheduler can be
 * passed directly as `RpcDeps.cron` without an adapter.
 */
export interface CronTaskDescriptor {
  id: string;
  spec: string;
  status: 'idle' | 'running' | 'disabled' | 'error';
  nextRunAt?: number;
  lastRunAt?: number;
  lastError?: string;
}

/**
 * What a scheduler exposes to callers (gateway-cli, tests, platform.ts
 * shutdown hook). The `list()` / `runNow()` pair is structurally compatible
 * with `gateway-cli`'s `CronRegistry` interface.
 */
export interface SchedulerHandle {
  start(): void;
  stop(): Promise<void>;
  list(): readonly CronTaskDescriptor[];
  runNow(id: string): Promise<{ startedAt: number }>;
}

export interface SchedulerServiceDeps {
  /** Loaded task definitions — typically from `loadTasksFromFile`. */
  tasks: CronTask[];
  /** One runner per task type. Missing type → registration fails fast. */
  runners: Partial<Record<CronTaskType, TaskRunner>>;
  /**
   * Optional hook fired after every run (success or failure). Useful for
   * tests and for future trace-logger integration. Fired synchronously
   * against `dispatch()`'s completion.
   */
  onRun?: (event: SchedulerRunEvent) => void;
}

export interface SchedulerRunEvent {
  taskId: string;
  type: CronTaskType;
  trigger: 'scheduled' | 'manual';
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  summary?: string;
  error?: string;
}

/**
 * In-memory cron scheduler. Responsibilities:
 *   - register each enabled task with `node-cron` on `start()`
 *   - dispatch fires + `runNow()` calls to the matching `TaskRunner`
 *   - maintain in-memory `TaskHistory` (lastRunAt / lastError / running flag)
 *   - expose a `list()` snapshot matching gateway-cli's `CronTaskDescriptor`
 *
 * Concurrency policy: a task that is already `running` skips its next fire
 * (log-and-continue). `runNow()` throws if the same id is in flight.
 */
export class SchedulerService implements SchedulerHandle {
  private readonly tasks = new Map<string, CronTask>();
  private readonly history = new Map<string, TaskHistory>();
  private readonly jobs = new Map<string, ScheduledTask>();
  private readonly runners: Partial<Record<CronTaskType, TaskRunner>>;
  private readonly onRun?: (event: SchedulerRunEvent) => void;
  private started = false;

  constructor(deps: SchedulerServiceDeps) {
    this.runners = deps.runners;
    if (deps.onRun) this.onRun = deps.onRun;
    for (const t of deps.tasks) {
      this.tasks.set(t.id, t);
      this.history.set(t.id, { running: false, runCount: 0 });
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const task of this.tasks.values()) {
      if (!task.enabled) continue;
      if (!this.runners[task.type]) {
        throw new Error(`[scheduler] no runner registered for type '${task.type}' (task=${task.id})`);
      }
      if (!cron.validate(task.spec)) {
        throw new Error(`[scheduler] invalid cron spec for task '${task.id}': ${task.spec}`);
      }
      const job = cron.schedule(task.spec, () => {
        void this.dispatch(task, 'scheduled');
      });
      this.jobs.set(task.id, job);
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    for (const job of this.jobs.values()) {
      try {
        job.stop();
      } catch {
        // best-effort
      }
    }
    this.jobs.clear();
  }

  list(): readonly CronTaskDescriptor[] {
    return [...this.tasks.values()].map((t) => this.describe(t));
  }

  get(id: string): CronTaskDescriptor | undefined {
    const t = this.tasks.get(id);
    return t ? this.describe(t) : undefined;
  }

  async runNow(id: string): Promise<{ startedAt: number }> {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`[scheduler] unknown task: ${id}`);
    const hist = this.history.get(id);
    if (hist?.running) {
      throw new Error(`[scheduler] task already running: ${id}`);
    }
    const startedAt = Date.now();
    // Fire and return immediately — the caller sees acknowledgement while
    // the actual run continues in the background.
    void this.dispatch(task, 'manual');
    return { startedAt };
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private async dispatch(task: CronTask, trigger: 'scheduled' | 'manual'): Promise<void> {
    const runner = this.runners[task.type];
    const hist = this.getHistory(task.id);
    if (hist.running) {
      // Scheduled fire coincided with an in-flight run; skip to preserve
      // single-concurrency per task id.
      return;
    }
    if (!runner) {
      hist.lastError = `no runner for type '${task.type}'`;
      return;
    }
    hist.running = true;
    const startedAt = Date.now();
    let result: TaskRunResult;
    try {
      result = await runner.run(task as never, { trigger, startedAt });
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const finishedAt = Date.now();
    hist.running = false;
    hist.runCount += 1;
    hist.lastRunAt = finishedAt;
    hist.lastRunMs = finishedAt - startedAt;
    if (result.ok) {
      delete hist.lastError;
    } else {
      hist.lastError = result.error ?? 'unknown error';
    }
    this.onRun?.({
      taskId: task.id,
      type: task.type,
      trigger,
      startedAt,
      finishedAt,
      ok: result.ok,
      ...(result.summary !== undefined ? { summary: result.summary } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    });
  }

  private getHistory(id: string): TaskHistory {
    let h = this.history.get(id);
    if (!h) {
      h = { running: false, runCount: 0 };
      this.history.set(id, h);
    }
    return h;
  }

  private describe(t: CronTask): CronTaskDescriptor {
    const hist = this.history.get(t.id);
    const status: CronTaskDescriptor['status'] = !t.enabled
      ? 'disabled'
      : hist?.running
        ? 'running'
        : hist?.lastError
          ? 'error'
          : 'idle';
    const out: CronTaskDescriptor = { id: t.id, spec: t.spec, status };
    if (hist?.lastRunAt !== undefined) out.lastRunAt = hist.lastRunAt;
    if (hist?.lastError !== undefined) out.lastError = hist.lastError;
    return out;
  }
}
