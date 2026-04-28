/**
 * Workflow DSL — a discriminated union of step nodes.
 *
 * We hand-write the TypeScript types here instead of deriving from TypeBox.
 * Recursive discriminated unions interact poorly with `Type.Recursive`,
 * producing `any`-leaking types that defeat exhaustiveness checks inside the
 * interpreter. Keeping the TS types authoritative plus a runtime validator
 * (below) is simpler and gives better editor diagnostics.
 */

export interface ToolCallStep {
  id: string;
  kind: 'tool_call';
  tool: string;
  /**
   * Static args. For dynamic args, use `{ $fromVar: 'name' }` — the
   * interpreter looks up `name` in the variable bag.
   */
  args: Record<string, unknown>;
  saveAs?: string;
}

export interface SetVarStep {
  id: string;
  kind: 'set_var';
  name: string;
  value: unknown;
}

export interface SequenceStep {
  id: string;
  kind: 'sequence';
  steps: WorkflowStep[];
}

export interface ParallelStep {
  id: string;
  kind: 'parallel';
  steps: WorkflowStep[];
}

export interface BranchStep {
  id: string;
  kind: 'branch';
  condition: unknown;
  whenTrue: WorkflowStep;
  whenFalse?: WorkflowStep;
}

/**
 * Invokes a named function declared in `Workflow.functions`. Each entry of
 * `args` is resolved (so `{ $fromVar: 'x' }` works) and bound as a local
 * variable in the function's fresh scope frame. The function returns either
 * via an explicit `return` step or implicitly (returnValue=undefined) when
 * its body completes. The returned value is written into the caller's scope
 * under `saveAs`, when provided.
 */
export interface CallStep {
  id: string;
  kind: 'call';
  function: string;
  args?: Record<string, unknown>;
  saveAs?: string;
}

/**
 * Sets the current call frame's return value and short-circuits the rest of
 * the function body. `value` is resolved against the current scope chain
 * (so `{ $fromVar: 'x' }` works just like in tool_call args).
 *
 * `return` outside a function call still works — it bubbles up through the
 * entry's body and ends the workflow. The return value is discarded in that
 * case (no `saveAs` available at the top level).
 */
export interface ReturnStep {
  id: string;
  kind: 'return';
  value?: unknown;
}

/**
 * try / catch / finally. The catch handler runs in a fresh scope frame that
 * exposes:
 *   - `__error__`         — the failed step's error message (string)
 *   - `__errorStepId__`   — the failed step's id (string)
 * If the body succeeds, neither `catch` nor `finally`'s recovery semantics
 * apply — `finally` still runs, but on a clean state.
 */
export interface TryStep {
  id: string;
  kind: 'try';
  body: WorkflowStep;
  catch?: WorkflowStep;
  finally?: WorkflowStep;
}

/**
 * Lexical scope. Pushes a fresh frame on entry, pops on exit. `set_var` and
 * `tool_call.saveAs` writes within `body` go to the inner frame and do NOT
 * leak to the parent. Reads chain inner→outer, so callers' variables remain
 * visible.
 */
export interface ScopeStep {
  id: string;
  kind: 'scope';
  body: WorkflowStep;
}

export type WorkflowStep =
  | ToolCallStep
  | SetVarStep
  | SequenceStep
  | ParallelStep
  | BranchStep
  | CallStep
  | ReturnStep
  | TryStep
  | ScopeStep;

export interface Workflow {
  id: string;
  name?: string;
  version: string;
  entry: WorkflowStep;
  /**
   * Named procedures callable via `call` steps. Each value is the function
   * body — typically a `sequence` or a single step. Function bodies execute
   * in a fresh scope frame containing the caller's bound `args`.
   */
  functions?: Record<string, WorkflowStep>;
}

/**
 * Lightweight structural validator. Not as exhaustive as a JSON Schema would
 * be, but catches the common errors (missing `kind`, wrong children shape).
 */
export function validateWorkflow(value: unknown): Workflow {
  if (!isObject(value)) throw new Error('workflow must be an object');
  const wf = value as Record<string, unknown>;
  if (typeof wf['id'] !== 'string') throw new Error('workflow.id must be a string');
  if (typeof wf['version'] !== 'string') throw new Error('workflow.version must be a string');
  const entry = validateStep(wf['entry'], 'entry');
  const result: Workflow = {
    id: wf['id'],
    version: wf['version'],
    entry,
  };
  if (typeof wf['name'] === 'string') result.name = wf['name'];
  if (wf['functions'] !== undefined) {
    if (!isObject(wf['functions'])) throw new Error('workflow.functions must be an object');
    const fns: Record<string, WorkflowStep> = {};
    for (const [name, body] of Object.entries(wf['functions'])) {
      fns[name] = validateStep(body, `functions.${name}`);
    }
    result.functions = fns;
  }
  return result;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validateStep(value: unknown, path: string): WorkflowStep {
  if (!isObject(value)) throw new Error(`${path}: step must be an object`);
  const s = value as Record<string, unknown>;
  if (typeof s['id'] !== 'string') throw new Error(`${path}: step.id must be a string`);
  if (typeof s['kind'] !== 'string') throw new Error(`${path}: step.kind must be a string`);

  switch (s['kind']) {
    case 'tool_call': {
      if (typeof s['tool'] !== 'string') throw new Error(`${path}: tool_call.tool required`);
      if (!isObject(s['args'])) throw new Error(`${path}: tool_call.args must be an object`);
      const step: ToolCallStep = {
        id: s['id'],
        kind: 'tool_call',
        tool: s['tool'],
        args: s['args'],
      };
      if (typeof s['saveAs'] === 'string') step.saveAs = s['saveAs'];
      return step;
    }
    case 'set_var': {
      if (typeof s['name'] !== 'string') throw new Error(`${path}: set_var.name required`);
      return { id: s['id'], kind: 'set_var', name: s['name'], value: s['value'] };
    }
    case 'sequence':
    case 'parallel': {
      if (!Array.isArray(s['steps'])) throw new Error(`${path}: ${s['kind']}.steps must be array`);
      const steps = s['steps'].map((child, i) => validateStep(child, `${path}.steps[${i}]`));
      return { id: s['id'], kind: s['kind'], steps };
    }
    case 'branch': {
      const whenTrue = validateStep(s['whenTrue'], `${path}.whenTrue`);
      const step: BranchStep = {
        id: s['id'],
        kind: 'branch',
        condition: s['condition'],
        whenTrue,
      };
      if (s['whenFalse'] !== undefined) {
        step.whenFalse = validateStep(s['whenFalse'], `${path}.whenFalse`);
      }
      return step;
    }
    case 'call': {
      if (typeof s['function'] !== 'string') throw new Error(`${path}: call.function required`);
      const step: CallStep = {
        id: s['id'],
        kind: 'call',
        function: s['function'],
      };
      if (s['args'] !== undefined) {
        if (!isObject(s['args'])) throw new Error(`${path}: call.args must be an object`);
        step.args = s['args'];
      }
      if (typeof s['saveAs'] === 'string') step.saveAs = s['saveAs'];
      return step;
    }
    case 'return': {
      const step: ReturnStep = { id: s['id'], kind: 'return' };
      if (s['value'] !== undefined) step.value = s['value'];
      return step;
    }
    case 'try': {
      const body = validateStep(s['body'], `${path}.body`);
      const step: TryStep = { id: s['id'], kind: 'try', body };
      if (s['catch'] !== undefined) step.catch = validateStep(s['catch'], `${path}.catch`);
      if (s['finally'] !== undefined) step.finally = validateStep(s['finally'], `${path}.finally`);
      return step;
    }
    case 'scope': {
      const body = validateStep(s['body'], `${path}.body`);
      return { id: s['id'], kind: 'scope', body };
    }
    default:
      throw new Error(`${path}: unknown step kind '${String(s['kind'])}'`);
  }
}
