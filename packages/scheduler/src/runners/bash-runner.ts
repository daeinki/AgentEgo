import type { Contracts, SessionPolicy } from '@agent-platform/core';
import type { CronTask, TaskRunContext, TaskRunResult, TaskRunner } from '../types.js';

export interface BashTaskRunnerDeps {
  /** Same ToolSandbox AgentRunner uses — InProcessSandbox or DockerSandbox. */
  toolSandbox: Contracts.ToolSandbox;
  /** Same guard AgentRunner uses. Enforces capability limits per task id. */
  capabilityGuard: Contracts.CapabilityGuard;
  /**
   * Factory building a SessionPolicy keyed on the task id. Defaults to
   * `ownerPolicy(...)` if omitted — scheduler runs under the single-owner
   * master-token trust level (ADR-004).
   */
  policyFor: (taskId: string) => SessionPolicy;
  /**
   * Name of the registered bash tool. Default `'bash.run'` — matches the
   * built-in added by `buildDefaultTools`. Exposed so callers running the
   * scheduler with a custom tool registry can rename.
   */
  toolName?: string;
}

type BashTask = Extract<CronTask, { type: 'bash' }>;

/**
 * Runs a shell command on a cron trigger through the same path an agent uses:
 *   CapabilityGuard.check → ToolSandbox.acquire → .execute → .release.
 *
 * Reusing this path means scheduled bash inherits the repo's sandbox + allow-
 * list story for free (Docker image pinning, gVisor opt-in, cap-drop, etc.).
 * No direct `child_process.spawn` — the scheduler itself never bypasses the
 * guard.
 */
export class BashTaskRunner implements TaskRunner<BashTask> {
  readonly type = 'bash' as const;
  private readonly toolName: string;

  constructor(private readonly deps: BashTaskRunnerDeps) {
    this.toolName = deps.toolName ?? 'bash.run';
  }

  async run(task: BashTask, _ctx: TaskRunContext): Promise<TaskRunResult> {
    const policy = this.deps.policyFor(task.id);
    const args: Record<string, unknown> = { command: task.bash.command };
    if (task.bash.cwd !== undefined) args['cwd'] = task.bash.cwd;

    const decision = await this.deps.capabilityGuard.check(policy.sessionId, this.toolName, args);
    if (!decision.allowed) {
      return {
        ok: false,
        error: `permission denied: ${decision.reason ?? 'no reason given'}`,
      };
    }

    const sandbox = await this.deps.toolSandbox.acquire(policy);
    try {
      const result = await this.deps.toolSandbox.execute(
        sandbox,
        this.toolName,
        args,
        task.bash.timeoutMs ?? 30_000,
      );
      return {
        ok: result.success,
        summary: summarizeOutput(result.output),
        ...(result.success ? {} : { error: result.error ?? 'bash command failed' }),
      };
    } finally {
      await this.deps.toolSandbox.release(sandbox);
    }
  }
}

function summarizeOutput(output: unknown): string {
  if (typeof output === 'string') {
    const trimmed = output.trim();
    if (trimmed.length === 0) return 'bash ok (empty stdout)';
    const firstLine = trimmed.split('\n')[0] ?? '';
    return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
  }
  return 'bash ok';
}
