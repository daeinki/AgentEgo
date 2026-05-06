import { describe, expect, it } from 'vitest';
import { codeExecTool, __testing__ } from './code-exec-tool.js';

const { staticCheckSource } = __testing__;

const noopCtx = {
  sessionId: 'test',
  agentId: 'test',
  traceId: 'test',
  signal: new AbortController().signal,
};

describe('staticCheckSource (code.exec)', () => {
  it('rejects eval()', () => {
    expect(staticCheckSource('eval("1+1")').ok).toBe(false);
  });
  it('rejects new Function()', () => {
    expect(staticCheckSource('new Function("return 1")').ok).toBe(false);
  });
  it('rejects child_process import', () => {
    expect(staticCheckSource("import cp from 'node:child_process'").ok).toBe(false);
  });
  it('rejects require()', () => {
    expect(staticCheckSource("const fs = require('node:fs')").ok).toBe(false);
  });
  it('rejects dynamic import()', () => {
    expect(staticCheckSource("await import('node:fs')").ok).toBe(false);
  });
  it('rejects imports outside the allow-list', () => {
    expect(staticCheckSource("import x from 'lodash'").ok).toBe(false);
  });
  it('accepts node:* imports', () => {
    expect(staticCheckSource("import { readFileSync } from 'node:fs'").ok).toBe(true);
  });
  it('accepts @agent-platform/* imports', () => {
    expect(staticCheckSource("import {} from '@agent-platform/core'").ok).toBe(true);
  });
  it('accepts a clean module', () => {
    expect(staticCheckSource('export function createTools() { return []; }').ok).toBe(true);
  });
});

describe('code.exec — end to end', () => {
  it('runs a clean snippet and returns its value', async () => {
    const tool = codeExecTool();
    const result = await tool.execute(
      {
        sourceCode: `
        export function createTools() {
          return [{
            name: 'main',
            async execute(input) {
              return { sum: input.a + input.b };
            },
          }];
        }
        `,
        input: { a: 7, b: 35 },
      },
      noopCtx,
    );
    expect(result.success).toBe(true);
    const out = JSON.parse(result.output ?? 'null');
    expect(out).toEqual({ sum: 42 });
  }, 15_000);

  it('rejects forbidden source without spawning a worker', async () => {
    const tool = codeExecTool();
    const start = Date.now();
    const result = await tool.execute({ sourceCode: 'const x = eval("1+1");' }, noopCtx);
    const elapsed = Date.now() - start;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/static check.*eval/i);
    // No worker spawn → must be effectively instant (well under spawn cost ~50ms).
    expect(elapsed).toBeLessThan(100);
  });

  it('reports the snippet error message when main throws', async () => {
    const tool = codeExecTool();
    const result = await tool.execute(
      {
        sourceCode: `
        export function createTools() {
          return [{
            name: 'main',
            async execute() { throw new Error('user-side failure'); },
          }];
        }
        `,
      },
      noopCtx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('user-side failure');
  }, 15_000);

  it('honors the timeout cap', async () => {
    const tool = codeExecTool();
    const start = Date.now();
    const result = await tool.execute(
      {
        sourceCode: `
        export function createTools() {
          return [{
            name: 'main',
            async execute() {
              await new Promise((r) => setTimeout(r, 5000));
              return 'never';
            },
          }];
        }
        `,
        timeoutMs: 200,
      },
      noopCtx,
    );
    const elapsed = Date.now() - start;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out|exited/i);
    expect(elapsed).toBeLessThan(2500);
  }, 15_000);

  it('rejects modules that do not export createTools()', async () => {
    const tool = codeExecTool();
    const result = await tool.execute({ sourceCode: 'export const x = 1;' }, noopCtx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/createTools/i);
  }, 15_000);

  it('rejects modules whose createTools() does not include a "main" tool', async () => {
    const tool = codeExecTool();
    const result = await tool.execute(
      {
        sourceCode: `
        export function createTools() {
          return [{ name: 'other', async execute() { return 1; } }];
        }
        `,
      },
      noopCtx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/'main'.*not exported/i);
  }, 15_000);
});
