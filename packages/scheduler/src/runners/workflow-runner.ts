import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { Contracts, SessionPolicy } from '@agent-platform/core';
import {
  executeWorkflow,
  validateWorkflow,
  type WorkflowToolAdapter,
} from '@agent-platform/workflow';
import type { CronTask, TaskRunContext, TaskRunResult, TaskRunner } from '../types.js';

export interface WorkflowTaskRunnerDeps {
  toolSandbox: Contracts.ToolSandbox;
  capabilityGuard: Contracts.CapabilityGuard;
  policyFor: (taskId: string) => SessionPolicy;
  /**
   * Base directory for resolving relative `workflow.path` values. Typical
   * choice is `<stateDir>/scheduler/` so that alongside `tasks.json` you can
   * drop workflow files without spelling out an absolute path.
   */
  workflowBaseDir?: string;
  /** Per-tool_call wall-clock timeout forwarded to ToolSandbox. Default 30s. */
  toolTimeoutMs?: number;
}

type WorkflowTask = Extract<CronTask, { type: 'workflow' }>;

/**
 * Runs a workflow DSL file on cron. Reads the JSON from disk, validates it,
 * acquires a sandbox under the task's policy, and bridges the workflow's
 * `WorkflowToolAdapter` calls to `ToolSandbox.execute()` — so workflow tool
 * invocations inherit the same CapabilityGuard + sandbox path as agent tool
 * calls.
 *
 * The sandbox is acquired once per workflow run (not per tool_call) so a
 * multi-step workflow shares setup cost. Any step failure aborts the run
 * (workflow's default `abortOnToolError: true`).
 */
export class WorkflowTaskRunner implements TaskRunner<WorkflowTask> {
  readonly type = 'workflow' as const;
  private readonly toolTimeoutMs: number;

  constructor(private readonly deps: WorkflowTaskRunnerDeps) {
    this.toolTimeoutMs = deps.toolTimeoutMs ?? 30_000;
  }

  async run(task: WorkflowTask, _ctx: TaskRunContext): Promise<TaskRunResult> {
    const resolvedPath = isAbsolute(task.workflow.path)
      ? task.workflow.path
      : resolve(this.deps.workflowBaseDir ?? process.cwd(), task.workflow.path);

    let raw: string;
    try {
      raw = await readFile(resolvedPath, 'utf8');
    } catch (err) {
      return { ok: false, error: `failed to read workflow: ${(err as Error).message}` };
    }

    let wf;
    try {
      wf = validateWorkflow(JSON.parse(raw));
    } catch (err) {
      return { ok: false, error: `invalid workflow: ${(err as Error).message}` };
    }

    const policy = this.deps.policyFor(task.id);
    const sandbox = await this.deps.toolSandbox.acquire(policy);
    const adapter: WorkflowToolAdapter = {
      execute: async (name, args) => {
        const argObj = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
        const decision = await this.deps.capabilityGuard.check(policy.sessionId, name, argObj);
        if (!decision.allowed) {
          return { success: false, error: `permission denied: ${decision.reason ?? 'no reason'}` };
        }
        const result = await this.deps.toolSandbox.execute(
          sandbox,
          name,
          argObj,
          this.toolTimeoutMs,
        );
        const out: { success: boolean; output?: string; error?: string } = {
          success: result.success,
        };
        if (typeof result.output === 'string') out.output = result.output;
        if (!result.success && result.error) out.error = result.error;
        return out;
      },
    };

    try {
      const executeOpts: Parameters<typeof executeWorkflow>[1] = { tools: adapter };
      if (task.workflow.initialVars) executeOpts.initialVars = task.workflow.initialVars;
      const result = await executeWorkflow(wf, executeOpts);
      if (!result.completed) {
        return {
          ok: false,
          error: result.error ?? 'workflow aborted',
          summary: `workflow partial (${result.stepsExecuted} steps)`,
        };
      }
      return {
        ok: true,
        summary: `workflow ok (${result.stepsExecuted} steps)`,
      };
    } finally {
      await this.deps.toolSandbox.release(sandbox);
    }
  }
}
