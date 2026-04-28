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
   * Note: this only applies to tool_call failures. A `try` step always
   * recovers from failures inside its `body` regardless of this flag.
   */
  abortOnToolError?: boolean;
  /**
   * Maximum nesting depth for `call` steps. Protects against runaway
   * recursion. Default 32 — generous enough for legitimate recursive
   * workflows but small enough that an infinite-recursion bug surfaces fast.
   */
  maxCallDepth?: number;
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

const DEFAULT_MAX_CALL_DEPTH = 32;

/**
 * Interpreter for the Workflow DSL. Depth-first, mostly sequential, with
 * `parallel` steps running children concurrently. Variables live in a stack
 * of frames — `call`, `scope`, and the catch-handler push fresh frames; the
 * other composite kinds (sequence/parallel/branch/try) inherit the parent
 * frame so existing flat-bag workflows keep working unchanged.
 */
export async function executeWorkflow(wf: Workflow, options: ExecuteOptions): Promise<ExecuteResult> {
  const root: Record<string, unknown> = { ...(options.initialVars ?? {}) };
  const state: ExecState = {
    workflow: wf,
    tools: options.tools,
    scopes: [root],
    stepCount: 0,
    onStep: options.onStep,
    abortOnToolError: options.abortOnToolError ?? true,
    failed: false,
    error: undefined,
    failedAtStepId: undefined,
    returning: false,
    returnValue: undefined,
    callDepth: 0,
    maxCallDepth: options.maxCallDepth ?? DEFAULT_MAX_CALL_DEPTH,
  };
  await runStep(wf.entry, state);
  return {
    completed: !state.failed,
    vars: root,
    stepsExecuted: state.stepCount,
    ...(state.error ? { error: state.error } : {}),
  };
}

interface ExecState {
  workflow: Workflow;
  tools: WorkflowToolAdapter;
  /**
   * Stack of variable frames. `scopes[0]` is the root frame (returned to the
   * caller as `result.vars`); subsequent frames are pushed by `call`,
   * `scope`, and `try`'s catch-handler. Reads chain top-down (innermost
   * first); writes always target the topmost frame.
   */
  scopes: Record<string, unknown>[];
  stepCount: number;
  onStep: ExecuteOptions['onStep'];
  abortOnToolError: boolean;
  failed: boolean;
  error: string | undefined;
  failedAtStepId: string | undefined;
  /**
   * Set by a `return` step. Causes `runStep` to short-circuit downstream
   * siblings the way `failed` does, until the enclosing `call` clears it.
   */
  returning: boolean;
  returnValue: unknown;
  callDepth: number;
  maxCallDepth: number;
}

async function runStep(step: WorkflowStep, state: ExecState): Promise<void> {
  // Either a hard failure or a pending `return` short-circuits forward
  // progress. (try/catch and call clear these at their own boundaries.)
  if (state.failed || state.returning) return;
  state.onStep?.({ type: 'start', stepId: step.id, kind: step.kind });
  state.stepCount += 1;

  try {
    switch (step.kind) {
      case 'tool_call':
        await runToolCall(step, state);
        break;
      case 'set_var':
        writeVar(state, step.name, resolveValue(step.value, state.scopes));
        break;
      case 'sequence':
        for (const child of step.steps) {
          if (state.failed || state.returning) break;
          await runStep(child, state);
        }
        break;
      case 'parallel':
        await Promise.all(step.steps.map((child: WorkflowStep) => runStep(child, state)));
        break;
      case 'branch': {
        const result = evalConditionScoped(step.condition, state.scopes);
        if (result) {
          await runStep(step.whenTrue, state);
        } else if (step.whenFalse) {
          await runStep(step.whenFalse, state);
        }
        break;
      }
      case 'call':
        await runCall(step, state);
        break;
      case 'return':
        state.returnValue = resolveValue(step.value, state.scopes);
        state.returning = true;
        break;
      case 'try':
        await runTry(step, state);
        break;
      case 'scope':
        state.scopes.push({});
        try {
          await runStep(step.body, state);
        } finally {
          state.scopes.pop();
        }
        break;
    }
    state.onStep?.({ type: 'end', stepId: step.id, kind: step.kind, ok: !state.failed });
  } catch (err) {
    state.failed = true;
    state.error = (err as Error).message;
    state.failedAtStepId = step.id;
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
  const args = resolveArgs(step.args, state.scopes);
  const result = await state.tools.execute(step.tool, args);
  if (step.saveAs) writeVar(state, step.saveAs, result.output ?? null);
  if (!result.success) {
    if (state.abortOnToolError) {
      state.failed = true;
      state.error = result.error ?? `tool ${step.tool} failed`;
      state.failedAtStepId = step.id;
    }
  }
}

async function runCall(
  step: Extract<WorkflowStep, { kind: 'call' }>,
  state: ExecState,
): Promise<void> {
  const fn = state.workflow.functions?.[step.function];
  if (!fn) {
    throw new Error(`call: function '${step.function}' is not defined`);
  }
  if (state.callDepth >= state.maxCallDepth) {
    throw new Error(
      `call: depth limit (${state.maxCallDepth}) exceeded — possible infinite recursion at function '${step.function}'`,
    );
  }

  // Bind args into a fresh frame. Each arg is resolved against the caller's
  // current scope chain (so `{ $fromVar: 'x' }` reads the caller's `x`),
  // then written into the new frame as a local variable named for the key.
  const localFrame: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(step.args ?? {})) {
    localFrame[k] = resolveValue(v, state.scopes);
  }

  // Save caller's return state so a nested `call` can't pollute it.
  const callerReturning = state.returning;
  const callerReturnValue = state.returnValue;
  state.returning = false;
  state.returnValue = undefined;

  state.scopes.push(localFrame);
  state.callDepth += 1;
  try {
    await runStep(fn, state);
  } finally {
    state.scopes.pop();
    state.callDepth -= 1;
  }

  const fnReturn = state.returnValue;
  // Restore caller's return state — `return` inside the callee must NOT
  // bubble out past the call boundary.
  state.returning = callerReturning;
  state.returnValue = callerReturnValue;

  if (step.saveAs && !state.failed) {
    writeVar(state, step.saveAs, fnReturn);
  }
}

async function runTry(
  step: Extract<WorkflowStep, { kind: 'try' }>,
  state: ExecState,
): Promise<void> {
  // Run body. If it fails, capture the error and clear the failed state so
  // the catch handler can run on a clean slate. If there's no catch, restore
  // the failure so it propagates past `try`.
  await runStep(step.body, state);
  let bodyFailed = false;
  let bodyError: string | undefined;
  let bodyErrorStepId: string | undefined;
  if (state.failed) {
    bodyFailed = true;
    bodyError = state.error;
    bodyErrorStepId = state.failedAtStepId;
    state.failed = false;
    state.error = undefined;
    state.failedAtStepId = undefined;
  }

  if (bodyFailed) {
    if (step.catch) {
      // catch handler runs in a fresh frame so __error__/__errorStepId__
      // don't leak past the handler.
      state.scopes.push({
        __error__: bodyError ?? '',
        __errorStepId__: bodyErrorStepId ?? '',
      });
      try {
        await runStep(step.catch, state);
      } finally {
        state.scopes.pop();
      }
      // catch may itself have failed — in which case state.failed is now
      // true and the new error replaces the body's. That's the right
      // semantics (the most recent unhandled error wins).
    } else {
      // No handler — re-raise so the failure propagates past `try`.
      state.failed = true;
      state.error = bodyError;
      state.failedAtStepId = bodyErrorStepId;
    }
  }

  // finally runs regardless. It cannot rescue an unhandled failure, but
  // a finally that itself fails wins over both body and catch errors
  // (matches JS try/finally semantics).
  if (step.finally) {
    const beforeFailed = state.failed;
    const beforeError = state.error;
    const beforeFailedAt = state.failedAtStepId;
    const beforeReturning = state.returning;
    state.failed = false;
    state.error = undefined;
    state.failedAtStepId = undefined;
    state.returning = false;
    await runStep(step.finally, state);
    if (state.failed) {
      // finally introduced a new failure — let it propagate as-is.
    } else {
      // finally ran cleanly: restore whatever the post-catch state was.
      state.failed = beforeFailed;
      state.error = beforeError;
      state.failedAtStepId = beforeFailedAt;
      state.returning = beforeReturning;
    }
  }
}

function resolveArgs(
  args: Record<string, unknown>,
  scopes: Record<string, unknown>[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = resolveValue(v, scopes);
  }
  return out;
}

function resolveValue(v: unknown, scopes: Record<string, unknown>[]): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const rec = v as Record<string, unknown>;
    if (typeof rec['$fromVar'] === 'string') {
      return readVar(scopes, rec['$fromVar']);
    }
  }
  return v;
}

/**
 * Read a variable by walking the scope stack innermost→outermost. Returns
 * `undefined` if the name is not found in any frame.
 */
function readVar(scopes: Record<string, unknown>[], name: string): unknown {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const frame = scopes[i]!;
    if (Object.prototype.hasOwnProperty.call(frame, name)) return frame[name];
  }
  return undefined;
}

/**
 * Write a variable into the topmost (innermost) frame. Outer frames are
 * never mutated — that's what makes `scope` and `call` truly isolating.
 */
function writeVar(state: ExecState, name: string, value: unknown): void {
  const top = state.scopes[state.scopes.length - 1];
  if (!top) throw new Error('writeVar: scope stack is empty');
  top[name] = value;
}

/**
 * Public expression evaluator. `vars` is treated as a single (root) frame
 * to preserve the pre-v0.7 contract; the scope-aware path is used
 * internally by the engine.
 */
export function evalCondition(expr: unknown, vars: Record<string, unknown>): boolean {
  return evalConditionScoped(expr, [vars]);
}

function evalConditionScoped(expr: unknown, scopes: Record<string, unknown>[]): boolean {
  if (expr === null || expr === undefined) return false;
  if (typeof expr === 'boolean') return expr;
  if (typeof expr === 'string' || typeof expr === 'number') return Boolean(expr);

  if (Array.isArray(expr)) return expr.length > 0;

  const rec = expr as Record<string, unknown>;
  if ('$var' in rec && typeof rec['$var'] === 'string') {
    return Boolean(readVar(scopes, rec['$var']));
  }
  if ('$equals' in rec && Array.isArray(rec['$equals']) && rec['$equals'].length === 2) {
    const [a, b] = rec['$equals'];
    return resolveValue(a, scopes) === resolveValue(b, scopes);
  }
  if ('$not' in rec) {
    return !evalConditionScoped(rec['$not'], scopes);
  }
  if ('$exists' in rec && typeof rec['$exists'] === 'string') {
    return readVar(scopes, rec['$exists']) !== undefined;
  }
  return false;
}
