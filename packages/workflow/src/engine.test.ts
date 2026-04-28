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

describe('executeWorkflow — functions (call / return)', () => {
  it('calls a function and stores its return value in the caller scope via saveAs', async () => {
    const tools = new RecordingTools(() => ({ success: true, output: 'ok' }));
    const wf: Workflow = {
      id: 'wf',
      version: '1.0',
      entry: {
        id: 'main',
        kind: 'sequence',
        steps: [
          { id: 'c', kind: 'call', function: 'double', args: { n: 4 }, saveAs: 'r' },
        ],
      },
      functions: {
        double: {
          id: 'd-body',
          kind: 'sequence',
          steps: [
            // The function reads `n` from its local frame (the bound arg)
            // and returns n * 2. Since the engine has no math primitives,
            // we hard-code the expected value via a return step driven by
            // the bound input — emulate "doubling" by returning a literal
            // computed via a tool. Simpler: just return a literal here and
            // assert the binding works via a separate test.
            { id: 'r', kind: 'return', value: 'doubled' },
          ],
        },
      },
    };
    const result = await executeWorkflow(wf, { tools });
    expect(result.completed).toBe(true);
    expect(result.vars.r).toBe('doubled');
  });

  it('binds args as local variables visible inside the function body', async () => {
    const tools = new RecordingTools((_name, args) => ({
      success: true,
      output: JSON.stringify(args),
    }));
    const wf: Workflow = {
      id: 'wf',
      version: '1.0',
      entry: {
        id: 'main',
        kind: 'sequence',
        steps: [
          { id: 'set', kind: 'set_var', name: 'callerVar', value: 'caller-side' },
          {
            id: 'c',
            kind: 'call',
            function: 'logName',
            args: { who: { $fromVar: 'callerVar' } },
          },
        ],
      },
      functions: {
        logName: {
          id: 'fn',
          kind: 'tool_call',
          tool: 'log',
          args: { msg: { $fromVar: 'who' } },
        },
      },
    };
    await executeWorkflow(wf, { tools });
    // The function's tool_call resolved `who` from its local frame, which was
    // bound from the caller's `callerVar` — so the tool sees 'caller-side'.
    expect(tools.calls[0]?.args).toEqual({ msg: 'caller-side' });
  });

  it('function-local set_var does NOT leak into caller scope', async () => {
    const tools = new RecordingTools(() => ({ success: true, output: 'ok' }));
    const wf: Workflow = {
      id: 'wf',
      version: '1.0',
      entry: {
        id: 'main',
        kind: 'sequence',
        steps: [
          { id: 'before', kind: 'set_var', name: 'shared', value: 'caller' },
          { id: 'c', kind: 'call', function: 'fn' },
        ],
      },
      functions: {
        fn: {
          id: 'fn-body',
          kind: 'set_var',
          name: 'shared',
          value: 'callee',
        },
      },
    };
    const result = await executeWorkflow(wf, { tools });
    // Caller's `shared` survives unchanged because the callee's set_var
    // wrote to its own frame (the call boundary).
    expect(result.vars.shared).toBe('caller');
  });

  it('return inside a function does NOT short-circuit the caller', async () => {
    const tools = new RecordingTools((name) => ({ success: true, output: name }));
    const wf: Workflow = {
      id: 'wf',
      version: '1.0',
      entry: {
        id: 'main',
        kind: 'sequence',
        steps: [
          { id: 'c', kind: 'call', function: 'earlyReturn' },
          // This step MUST run even though the function returned early.
          { id: 'after', kind: 'tool_call', tool: 'after', args: {} },
        ],
      },
      functions: {
        earlyReturn: {
          id: 'er-body',
          kind: 'sequence',
          steps: [
            { id: 'r', kind: 'return', value: 'short' },
            // Should NOT execute (skipped after return).
            { id: 'never', kind: 'tool_call', tool: 'never', args: {} },
          ],
        },
      },
    };
    await executeWorkflow(wf, { tools });
    const names = tools.calls.map((c) => c.name);
    expect(names).toEqual(['after']);
  });

  it('supports recursion (function calling itself)', async () => {
    const tools = new RecordingTools(() => ({ success: true, output: 'ok' }));
    const wf: Workflow = {
      id: 'wf',
      version: '1.0',
      entry: { id: 'main', kind: 'call', function: 'rec', args: { depth: 3 }, saveAs: 'out' },
      functions: {
        rec: {
          id: 'rec-body',
          kind: 'branch',
          condition: { $equals: [{ $fromVar: 'depth' }, 0] },
          whenTrue: { id: 'base', kind: 'return', value: 'done' },
          whenFalse: {
            // depth > 0 — we just call recursively with the same arg to
            // exercise the stack push/pop. Decrementing would need a math
            // primitive we don't have; instead we count by tracking calls.
            id: 'rec-step',
            kind: 'sequence',
            steps: [
              { id: 'set', kind: 'set_var', name: 'depth', value: 0 },
              { id: 'self', kind: 'call', function: 'rec', args: { depth: 0 }, saveAs: 'inner' },
              { id: 'r', kind: 'return', value: { $fromVar: 'inner' } },
            ],
          },
        },
      },
    };
    const result = await executeWorkflow(wf, { tools });
    expect(result.completed).toBe(true);
    expect(result.vars.out).toBe('done');
  });

  it('enforces maxCallDepth to prevent infinite recursion', async () => {
    const tools = new RecordingTools(() => ({ success: true, output: 'ok' }));
    const wf: Workflow = {
      id: 'wf',
      version: '1.0',
      entry: { id: 'main', kind: 'call', function: 'loop' },
      functions: {
        // Unconditionally calls itself — should hit the depth cap and abort.
        loop: { id: 'l', kind: 'call', function: 'loop' },
      },
    };
    const result = await executeWorkflow(wf, { tools, maxCallDepth: 5 });
    expect(result.completed).toBe(false);
    expect(result.error).toMatch(/depth limit/);
  });

  it('rejects calls to undefined functions', async () => {
    const tools = new RecordingTools(() => ({ success: true, output: 'ok' }));
    const wf: Workflow = {
      id: 'wf',
      version: '1.0',
      entry: { id: 'main', kind: 'call', function: 'missing' },
    };
    const result = await executeWorkflow(wf, { tools });
    expect(result.completed).toBe(false);
    expect(result.error).toMatch(/'missing'.*not defined/);
  });
});

describe('executeWorkflow — try / catch / finally', () => {
  it('catch handles a body failure and the workflow continues', async () => {
    const tools = new RecordingTools((name) => {
      if (name === 'boom') return { success: false, error: 'kaboom' };
      return { success: true, output: name };
    });
    const wf: Workflow = {
      id: 'wf',
      version: '1.0',
      entry: {
        id: 'main',
        kind: 'sequence',
        steps: [
          {
            id: 't',
            kind: 'try',
            body: { id: 'b', kind: 'tool_call', tool: 'boom', args: {} },
            catch: { id: 'h', kind: 'tool_call', tool: 'recover', args: {} },
          },
          { id: 'after', kind: 'tool_call', tool: 'after', args: {} },
        ],
      },
    };
    const result = await executeWorkflow(wf, { tools });
    expect(result.completed).toBe(true);
    expect(tools.calls.map((c) => c.name)).toEqual(['boom', 'recover', 'after']);
  });

  it('exposes __error__ and __errorStepId__ inside the catch handler', async () => {
    const tools = new RecordingTools((name, args) => {
      if (name === 'boom') return { success: false, error: 'specific reason' };
      return { success: true, output: JSON.stringify(args) };
    });
    const wf: Workflow = {
      id: 'wf',
      version: '1.0',
      entry: {
        id: 't',
        kind: 'try',
        body: { id: 'failing-step', kind: 'tool_call', tool: 'boom', args: {} },
        catch: {
          id: 'h',
          kind: 'tool_call',
          tool: 'log',
          args: {
            msg: { $fromVar: '__error__' },
            at: { $fromVar: '__errorStepId__' },
          },
        },
      },
    };
    await executeWorkflow(wf, { tools });
    expect(tools.calls[1]?.args).toEqual({
      msg: 'specific reason',
      at: 'failing-step',
    });
  });

  it('__error__ is NOT visible after the catch block', async () => {
    const tools = new RecordingTools((name) => {
      if (name === 'boom') return { success: false, error: 'x' };
      return { success: true, output: 'ok' };
    });
    const wf: Workflow = {
      id: 'wf',
      version: '1.0',
      entry: {
        id: 'main',
        kind: 'sequence',
        steps: [
          {
            id: 't',
            kind: 'try',
            body: { id: 'b', kind: 'tool_call', tool: 'boom', args: {} },
            catch: { id: 'h', kind: 'tool_call', tool: 'recover', args: {} },
          },
          {
            id: 'check',
            kind: 'branch',
            condition: { $exists: '__error__' },
            whenTrue: { id: 'leak', kind: 'tool_call', tool: 'leaked', args: {} },
          },
        ],
      },
    };
    await executeWorkflow(wf, { tools });
    const names = tools.calls.map((c) => c.name);
    // 'leaked' must NOT appear because __error__ was popped with the catch frame.
    expect(names).not.toContain('leaked');
  });

  it('try with no catch lets the failure propagate past it', async () => {
    const tools = new RecordingTools((name) => {
      if (name === 'boom') return { success: false, error: 'x' };
      return { success: true, output: 'ok' };
    });
    const wf: Workflow = {
      id: 'wf',
      version: '1.0',
      entry: {
        id: 'main',
        kind: 'sequence',
        steps: [
          {
            id: 't',
            kind: 'try',
            body: { id: 'b', kind: 'tool_call', tool: 'boom', args: {} },
          },
          // Should NOT run — no catch absorbed the failure.
          { id: 'after', kind: 'tool_call', tool: 'after', args: {} },
        ],
      },
    };
    const result = await executeWorkflow(wf, { tools });
    expect(result.completed).toBe(false);
    expect(result.error).toBe('x');
    expect(tools.calls.map((c) => c.name)).toEqual(['boom']);
  });

  it('finally runs even when the body succeeded', async () => {
    const tools = new RecordingTools(() => ({ success: true, output: 'ok' }));
    const wf: Workflow = {
      id: 'wf',
      version: '1.0',
      entry: {
        id: 't',
        kind: 'try',
        body: { id: 'b', kind: 'tool_call', tool: 'b', args: {} },
        finally: { id: 'f', kind: 'tool_call', tool: 'cleanup', args: {} },
      },
    };
    await executeWorkflow(wf, { tools });
    expect(tools.calls.map((c) => c.name)).toEqual(['b', 'cleanup']);
  });

  it('finally runs even when the body failed and there was no catch', async () => {
    const tools = new RecordingTools((name) => {
      if (name === 'boom') return { success: false, error: 'x' };
      return { success: true, output: 'ok' };
    });
    const wf: Workflow = {
      id: 'wf',
      version: '1.0',
      entry: {
        id: 't',
        kind: 'try',
        body: { id: 'b', kind: 'tool_call', tool: 'boom', args: {} },
        finally: { id: 'f', kind: 'tool_call', tool: 'cleanup', args: {} },
      },
    };
    const result = await executeWorkflow(wf, { tools });
    // finally ran (cleanup observed) but original failure was preserved.
    expect(tools.calls.map((c) => c.name)).toEqual(['boom', 'cleanup']);
    expect(result.completed).toBe(false);
    expect(result.error).toBe('x');
  });

  it('a failure inside finally overrides a body or catch error', async () => {
    const tools = new RecordingTools((name) => {
      if (name === 'boom') return { success: false, error: 'body-failed' };
      if (name === 'cleanup-bad') return { success: false, error: 'finally-failed' };
      return { success: true, output: 'ok' };
    });
    const wf: Workflow = {
      id: 'wf',
      version: '1.0',
      entry: {
        id: 't',
        kind: 'try',
        body: { id: 'b', kind: 'tool_call', tool: 'boom', args: {} },
        finally: { id: 'f', kind: 'tool_call', tool: 'cleanup-bad', args: {} },
      },
    };
    const result = await executeWorkflow(wf, { tools });
    expect(result.completed).toBe(false);
    expect(result.error).toBe('finally-failed');
  });
});

describe('executeWorkflow — scope step', () => {
  it('set_var inside a scope does NOT leak to the parent', async () => {
    const tools = new RecordingTools(() => ({ success: true, output: 'ok' }));
    const wf: Workflow = {
      id: 'wf',
      version: '1.0',
      entry: {
        id: 'main',
        kind: 'sequence',
        steps: [
          { id: 'init', kind: 'set_var', name: 'a', value: 'outer' },
          {
            id: 's',
            kind: 'scope',
            body: {
              id: 'inner',
              kind: 'sequence',
              steps: [
                { id: 'shadow', kind: 'set_var', name: 'a', value: 'inner-shadow' },
                { id: 'newvar', kind: 'set_var', name: 'b', value: 'inner-only' },
              ],
            },
          },
        ],
      },
    };
    const result = await executeWorkflow(wf, { tools });
    expect(result.vars.a).toBe('outer');
    expect(result.vars.b).toBeUndefined();
  });

  it('reads inside a scope still see outer variables (chain lookup)', async () => {
    const tools = new RecordingTools((_name, args) => ({
      success: true,
      output: JSON.stringify(args),
    }));
    const wf: Workflow = {
      id: 'wf',
      version: '1.0',
      entry: {
        id: 'main',
        kind: 'sequence',
        steps: [
          { id: 'init', kind: 'set_var', name: 'outer', value: 'visible' },
          {
            id: 's',
            kind: 'scope',
            body: {
              id: 'use-outer',
              kind: 'tool_call',
              tool: 'log',
              args: { x: { $fromVar: 'outer' } },
            },
          },
        ],
      },
    };
    await executeWorkflow(wf, { tools });
    expect(tools.calls[0]?.args).toEqual({ x: 'visible' });
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
