/**
 * Cron-scheduled task definitions and the runtime contract every task runner
 * implements.
 *
 * Tasks live in `<stateDir>/scheduler/tasks.json` as a JSON5-ish file (comments
 * and trailing commas tolerated). At boot the platform reads the file once and
 * registers each `enabled` task with `node-cron`. Mutation RPCs are out of
 * scope for v1 — edit the file and restart the gateway.
 */

// ─── Discriminated union of task kinds ────────────────────────────────────

export interface CronTaskBase {
  /** Stable identifier. Also used as the default `sessionId` for chat tasks. */
  id: string;
  /** Standard 5-field cron expression, e.g. `'0 9 * * *'`. */
  spec: string;
  /** When false, scheduler skips registration but the task stays in the file. */
  enabled: boolean;
  /** Human-facing label shown by `cron.list` / TUI. Optional. */
  description?: string;
}

export interface ChatTaskConfig {
  /** Message text injected as the user turn. */
  prompt: string;
  /** Routing override; defaults to the platform's default agent. */
  agentId?: string;
  /**
   * Session identity strategy. `pinned` (default) reuses `sessionId`
   * (or `cron-<taskId>`) across runs so conversation history accumulates —
   * useful for "daily summary" patterns. `fresh` generates a new session
   * each run so turns are independent.
   */
  sessionStrategy?: 'pinned' | 'fresh';
  /** Explicit session override when `sessionStrategy === 'pinned'`. */
  sessionId?: string;
  /** Synthetic sender id; defaults to `cron-<taskId>`. */
  senderId?: string;
}

export interface BashTaskConfig {
  /** Shell command passed straight to the existing `bashTool` contract. */
  command: string;
  /** Cwd inside the sandbox. Defaults to the container's working dir. */
  cwd?: string;
  /** Wall-clock timeout in ms. Default 30_000 (matches ToolSandbox default). */
  timeoutMs?: number;
}

export interface WorkflowTaskConfig {
  /** Absolute or `<stateDir>`-relative path to a workflow JSON file. */
  path: string;
  /** Pre-seeded workflow variables (merged with `{}` default). */
  initialVars?: Record<string, unknown>;
}

export type CronTask =
  | (CronTaskBase & { type: 'chat'; chat: ChatTaskConfig })
  | (CronTaskBase & { type: 'bash'; bash: BashTaskConfig })
  | (CronTaskBase & { type: 'workflow'; workflow: WorkflowTaskConfig });

export type CronTaskType = CronTask['type'];

// ─── Runtime contracts ─────────────────────────────────────────────────────

export interface TaskRunContext {
  /** Invocation reason — used by runners to decide (e.g.) traceId prefix. */
  trigger: 'scheduled' | 'manual';
  /** When the run started (ms since epoch). */
  startedAt: number;
}

export interface TaskRunResult {
  ok: boolean;
  /** Short, human-facing result summary (shown by cron.list). */
  summary?: string;
  /** Error message when `ok === false`. */
  error?: string;
}

export interface TaskRunner<T extends CronTask = CronTask> {
  readonly type: T['type'];
  run(task: T, ctx: TaskRunContext): Promise<TaskRunResult>;
}

// ─── In-memory run history (reset on restart) ──────────────────────────────

export interface TaskHistory {
  lastRunAt?: number;
  lastRunMs?: number;
  lastError?: string;
  /** True while a run is in-flight — blocks concurrent `runNow`. */
  running: boolean;
  /** Monotonic counter of completed runs (success + failure). */
  runCount: number;
}
