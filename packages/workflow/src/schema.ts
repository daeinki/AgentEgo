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

export type WorkflowStep =
  | ToolCallStep
  | SetVarStep
  | SequenceStep
  | ParallelStep
  | BranchStep;

export interface Workflow {
  id: string;
  name?: string;
  version: string;
  entry: WorkflowStep;
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
    default:
      throw new Error(`${path}: unknown step kind '${String(s['kind'])}'`);
  }
}
