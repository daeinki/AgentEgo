import { describe, it, expect } from 'vitest';
import { executeWorkflow, evalCondition, type WorkflowToolAdapter } from './engine.js';
import type { Workflow } from './schema.js';

class RecordingTools implements WorkflowToolAdapter {
  public calls: Array<{ name: string; args: unknown }> = [];
  constructor(
    private readonly response: (name: string, args: unknown) => {
      success: boolean;
      output?: string;
      error?: string;
    },
  ) {}
  async execute(
    name: string,
    args: unknown,
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    this.calls.push({ name, args });
    return this.response(name, args);
  }
}

describe('executeWorkflow', () => {
  it('runs a simple tool_call and saves its output', async () => {
    const tools = new RecordingTools(() => ({ success: true, output: 'result-1' }));
    const wf: Workflow = {
      id: 'wf',
      version: '1.0',
      entry: {
        id: 's1',
        kind: 'tool_call',
        tool: 'search',
        args: { q: 'hello' },
        saveAs: 'search_result',
      },
    };
    const result = await executeWorkflow(wf, { tools });
    expect(result.completed).toBe(true);
    expect(result.vars.search_result).toBe('result-1');
    expect(tools.calls).toHaveLength(1);
  });

  it('resolves $fromVar args from the variable bag', async () => {
    const tools = new RecordingTools(() => ({ success: true, output: 'ok' }));
    const wf: Workflow = {
      id: 'wf',
      version: '1.0',
      entry: {
        id: 'seq',
        kind: 'sequence',
        steps: [
          { id: 'v', kind: 'set_var', name: 'query', value: 'hello' },
          {
            id: 'call',
            kind: 'tool_call',
            tool: 'search',
            args: { q: { $fromVar: 'query' } },
          },
        ],
      },
    };
    await executeWorkflow(wf, { tools });
    expect(tools.calls[0]?.args).toEqual({ q: 'hello' });
  });

  it('sequence stops on tool failure in strict mode', async () => {
    const tools = new RecordingTools((name) => {
      if (name === 'failing') return { success: false, error: 'boom' };
      return { success: true, output: 'ok' };
    });
    const wf: Workflow = {
      id: 'wf',
      version: '1.0',
      entry: {
        id: 'seq',
        kind: 'sequence',
        steps: [
          { id: 't1', kind: 'tool_call', tool: 'first', args: {} },
          { id: 't2', kind: 'tool_call', tool: 'failing', args: {} },
          { id: 't3', kind: 'tool_call', tool: 'never', args: {} },
        ],
      },
    };
    const result = await executeWorkflow(wf, { tools });
    expect(result.completed).toBe(false);
    expect(result.error).toContain('boom');
    const names = tools.calls.map((c) => c.name);
    expect(names).toEqual(['first', 'failing']);
  });

  it('abortOnToolError=false keeps running past failures', async () => {
    const tools = new RecordingTools((name) => {
      if (name === 'b') return { success: false, error: 'x' };
      return { success: true, output: 'ok' };
    });
    const wf: Workflow = {
      id: 'wf',
      version: '1.0',
      entry: {
        id: 'seq',
        kind: 'sequence',
        steps: [
          { id: '1', kind: 'tool_call', tool: 'a', args: {} },
          { id: '2', kind: 'tool_call', tool: 'b', args: {} },
          { id: '3', kind: 'tool_call', tool: 'c', args: {} },
        ],
      },
    };
    const result = await executeWorkflow(wf, { tools, abortOnToolError: false });
    expect(result.completed).toBe(true);
    expect(tools.calls.map((c) => c.name)).toEqual(['a', 'b', 'c']);
  });

  it('parallel runs children concurrently and waits for all', async () => {
    let order: string[] = [];
    const tools = new RecordingTools((name) => {
      order.push(name);
      return { success: true, output: name };
    });
    const wf: Workflow = {
      id: 'wf',
      version: '1.0',
      entry: {
        id: 'par',
        kind: 'parallel',
        steps: [
          { id: 't1', kind: 'tool_call', tool: 'a', args: {} },
          { id: 't2', kind: 'tool_call', tool: 'b', args: {} },
          { id: 't3', kind: 'tool_call', tool: 'c', args: {} },
        ],
      },
    };
    const result = await executeWorkflow(wf, { tools });
    expect(result.completed).toBe(true);
    expect(order.sort()).toEqual(['a', 'b', 'c']);
  });

  it('branch takes whenTrue when condition is true', async () => {
    const tools = new RecordingTools(() => ({ success: true, output: 'ok' }));
    const wf: Workflow = {
      id: 'wf',
      version: '1.0',
      entry: {
        id: 'seq',
        kind: 'sequence',
        steps: [
          { id: 'v', kind: 'set_var', name: 'flag', value: true },
          {
            id: 'br',
            kind: 'branch',
            condition: { $var: 'flag' },
            whenTrue: { id: 'yes', kind: 'tool_call', tool: 'yes', args: {} },
            whenFalse: { id: 'no', kind: 'tool_call', tool: 'no', args: {} },
          },
        ],
      },
    };
    await executeWorkflow(wf, { tools });
    expect(tools.calls.map((c) => c.name)).toEqual(['yes']);
  });

  it('branch takes whenFalse (or skips) when condition is false', async () => {
    const tools = new RecordingTools(() => ({ success: true, output: 'ok' }));
    const wf: Workflow = {
      id: 'wf',
      version: '1.0',
      entry: {
        id: 'br',
        kind: 'branch',
        condition: false,
        whenTrue: { id: 'yes', kind: 'tool_call', tool: 'yes', args: {} },
      },
    };
    await executeWorkflow(wf, { tools });
    expect(tools.calls).toEqual([]);
  });

  it('onStep callback fires start + end for every step', async () => {
    const tools = new RecordingTools(() => ({ success: true, output: 'ok' }));
    const events: string[] = [];
    const wf: Workflow = {
      id: 'wf',
      version: '1.0',
      entry: {
        id: 'seq',
        kind: 'sequence',
        steps: [
          { id: 'a', kind: 'set_var', name: 'x', value: 1 },
          { id: 'b', kind: 'tool_call', tool: 't', args: {} },
        ],
      },
    };
    await executeWorkflow(wf, {
      tools,
      onStep: (e) => events.push(`${e.type}:${e.stepId}`),
    });
    expect(events).toContain('start:seq');
    expect(events).toContain('end:seq');
    expect(events).toContain('start:a');
    expect(events).toContain('start:b');
  });

  it('stepsExecuted counts every node, including composites', async () => {
    const tools = new RecordingTools(() => ({ success: true, output: 'ok' }));
    const wf: Workflow = {
      id: 'wf',
      version: '1.0',
      entry: {
        id: 'root',
        kind: 'sequence',
        steps: [
          { id: 'a', kind: 'set_var', name: 'x', value: 1 },
          { id: 'b', kind: 'tool_call', tool: 't', args: {} },
        ],
      },
    };
    const result = await executeWorkflow(wf, { tools });
    expect(result.stepsExecuted).toBe(3); // sequence + set_var + tool_call
  });
});

describe('evalCondition', () => {
  it('$var reads from the bag', () => {
    expect(evalCondition({ $var: 'x' }, { x: true })).toBe(true);
    expect(evalCondition({ $var: 'x' }, { x: false })).toBe(false);
    expect(evalCondition({ $var: 'missing' }, {})).toBe(false);
  });
  it('$equals compares resolved values', () => {
    expect(evalCondition({ $equals: [1, 1] }, {})).toBe(true);
    expect(evalCondition({ $equals: [{ $fromVar: 'a' }, 2] }, { a: 2 })).toBe(true);
    expect(evalCondition({ $equals: [1, 2] }, {})).toBe(false);
  });
  it('$not inverts', () => {
    expect(evalCondition({ $not: { $var: 'x' } }, { x: true })).toBe(false);
    expect(evalCondition({ $not: { $var: 'x' } }, { x: false })).toBe(true);
  });
  it('$exists checks presence', () => {
    expect(evalCondition({ $exists: 'a' }, { a: 0 })).toBe(true);
    expect(evalCondition({ $exists: 'a' }, {})).toBe(false);
  });
  it('raw literals coerce', () => {
    expect(evalCondition(true, {})).toBe(true);
    expect(evalCondition(false, {})).toBe(false);
    expect(evalCondition('x', {})).toBe(true);
    expect(evalCondition(0, {})).toBe(false);
  });
});
