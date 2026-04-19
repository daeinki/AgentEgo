import type { WorkflowStep, Workflow } from './schema.js';

/**
 * Minimal tool facade the workflow engine needs. Narrow on purpose so workflow
 * doesn't depend on agent-worker.
 */
export interface WorkflowToolAdapter {
  execute(name: string, args: unknown): Promise<{ success: boolean; output?: string; error?: string }>;
}

export interface ExecuteOptions {
  tools: WorkflowToolAdapter;
  /**
   * Initial variables (read/writable by set_var and tool_call.saveAs).
   */
  initialVars?: Record<string, unknown>;
  /**
   * Per-step telemetry callback. Fires before and after every step.
   */
  onStep?: (evt: StepEvent) => void;
  /**
   * Abort the whole workflow when any tool_call reports `success: false`.
   * Default: true (strict mode). Set to false to continue past tool failures.
   */
  abortOnToolError?: boolean;
}

export type StepEvent =
  | { type: 'start'; stepId: string; kind: WorkflowStep['kind'] }
  | { type: 'end'; stepId: string; kind: WorkflowStep['kind']; ok: boolean; error?: string };

export interface ExecuteResult {
  completed: boolean;
  vars: Record<string, unknown>;
  error?: string;
  stepsExecuted: number;
}

/**
 * Interpreter for the Workflow DSL. Depth-first, mostly sequential, with
 * `parallel` steps running children concurrently. Variables are scoped per
 * execution (no nesting / closures).
 */
export async function executeWorkflow(wf: Workflow, options: ExecuteOptions): Promise<ExecuteResult> {
  const vars: Record<string, unknown> = { ...(options.initialVars ?? {}) };
  const state: ExecState = {
    tools: options.tools,
    vars,
    stepCount: 0,
    onStep: options.onStep,
    abortOnToolError: options.abortOnToolError ?? true,
    failed: false,
    error: undefined,
  };
  await runStep(wf.entry, state);
  return {
    completed: !state.failed,
    vars,
    stepsExecuted: state.stepCount,
    ...(state.error ? { error: state.error } : {}),
  };
}

interface ExecState {
  tools: WorkflowToolAdapter;
  vars: Record<string, unknown>;
  stepCount: number;
  onStep: ExecuteOptions['onStep'];
  abortOnToolError: boolean;
  failed: boolean;
  error: string | undefined;
}

async function runStep(step: WorkflowStep, state: ExecState): Promise<void> {
  if (state.failed) return;
  state.onStep?.({ type: 'start', stepId: step.id, kind: step.kind });
  state.stepCount += 1;

  try {
    switch (step.kind) {
      case 'tool_call':
        await runToolCall(step, state);
        break;
      case 'set_var':
        state.vars[step.name] = step.value;
        break;
      case 'sequence':
        for (const child of step.steps) {
          if (state.failed) break;
          await runStep(child, state);
        }
        break;
      case 'parallel':
        await Promise.all(step.steps.map((child: WorkflowStep) => runStep(child, state)));
        break;
      case 'branch': {
        const result = evalCondition(step.condition, state.vars);
        if (result) {
          await runStep(step.whenTrue, state);
        } else if (step.whenFalse) {
          await runStep(step.whenFalse, state);
        }
        break;
      }
    }
    state.onStep?.({ type: 'end', stepId: step.id, kind: step.kind, ok: !state.failed });
  } catch (err) {
    state.failed = true;
    state.error = (err as Error).message;
    state.onStep?.({
      type: 'end',
      stepId: step.id,
      kind: step.kind,
      ok: false,
      error: state.error,
    });
  }
}

async function runToolCall(
  step: Extract<WorkflowStep, { kind: 'tool_call' }>,
  state: ExecState,
): Promise<void> {
  const args = resolveArgs(step.args, state.vars);
  const result = await state.tools.execute(step.tool, args);
  if (step.saveAs) state.vars[step.saveAs] = result.output ?? null;
  if (!result.success) {
    if (state.abortOnToolError) {
      state.failed = true;
      state.error = result.error ?? `tool ${step.tool} failed`;
    }
  }
}

function resolveArgs(args: Record<string, unknown>, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = resolveValue(v, vars);
  }
  return out;
}

function resolveValue(v: unknown, vars: Record<string, unknown>): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const rec = v as Record<string, unknown>;
    if (typeof rec['$fromVar'] === 'string') {
      return vars[rec['$fromVar']];
    }
  }
  return v;
}

/**
 * Tiny expression evaluator used by `branch` conditions.
 */
export function evalCondition(expr: unknown, vars: Record<string, unknown>): boolean {
  if (expr === null || expr === undefined) return false;
  if (typeof expr === 'boolean') return expr;
  if (typeof expr === 'string' || typeof expr === 'number') return Boolean(expr);

  if (Array.isArray(expr)) return expr.length > 0;

  const rec = expr as Record<string, unknown>;
  if ('$var' in rec && typeof rec['$var'] === 'string') {
    return Boolean(vars[rec['$var']]);
  }
  if ('$equals' in rec && Array.isArray(rec['$equals']) && rec['$equals'].length === 2) {
    const [a, b] = rec['$equals'];
    return resolveValue(a, vars) === resolveValue(b, vars);
  }
  if ('$not' in rec) {
    return !evalCondition(rec['$not'], vars);
  }
  if ('$exists' in rec && typeof rec['$exists'] === 'string') {
    return vars[rec['$exists']] !== undefined;
  }
  return false;
}
