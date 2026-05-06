import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkerSandbox, type WorkerToolSpec } from './worker-sandbox.js';
import { ownerPolicy } from '../security/capability-guard.js';

// ─── Test fixtures: real ESM modules dropped into a tmp dir ────────────────
//
// Worker spawn requires a real file URL — the runner does `await import(url)`
// inside the worker thread, which means the module must exist on disk.
// We therefore stage a handful of skill-shaped modules per test run.

let tmpRoot: string;

function writeModule(name: string, source: string): string {
  const p = join(tmpRoot, `${name}.mjs`);
  writeFileSync(p, source, 'utf-8');
  return pathToFileURL(p).href;
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'worker-sandbox-test-'));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const POLICY = ownerPolicy('test-session');

describe('WorkerSandbox', () => {
  it('spawns a worker, runs a skill tool, returns the value', async () => {
    const moduleUrl = writeModule(
      'echo',
      `
      export function createTools() {
        return [{
          name: 'echo',
          async execute(args) {
            return { echoed: args };
          },
        }];
      }
      `,
    );
    const tools = new Map<string, WorkerToolSpec>([['echo', { moduleUrl, toolName: 'echo' }]]);
    const sandbox = new WorkerSandbox(tools);

    const inst = await sandbox.acquire(POLICY);
    const result = await sandbox.execute(inst, 'echo', { hello: 'world' }, 5000);
    await sandbox.release(inst);

    expect(result.success).toBe(true);
    expect(result.toolName).toBe('echo');
    const parsed = JSON.parse(result.output ?? 'null');
    expect(parsed).toEqual({ echoed: { hello: 'world' } });
  }, 15_000);

  it('returns a wrapped ToolResult unchanged when the skill author wraps it', async () => {
    const moduleUrl = writeModule(
      'wrapped',
      `
      export function createTools() {
        return [{
          name: 'wrapped',
          async execute() {
            return {
              toolName: 'wrapped',
              success: true,
              output: 'pre-wrapped',
              durationMs: 0,
            };
          },
        }];
      }
      `,
    );
    const sandbox = new WorkerSandbox(new Map([['wrapped', { moduleUrl, toolName: 'wrapped' }]]));
    const inst = await sandbox.acquire(POLICY);
    const result = await sandbox.execute(inst, 'wrapped', {}, 5000);
    await sandbox.release(inst);

    expect(result.success).toBe(true);
    // Wrapped form must be preserved (NOT re-stringified into output).
    expect(result.output).toBe('pre-wrapped');
  }, 15_000);

  it('reports an error result when the skill throws', async () => {
    const moduleUrl = writeModule(
      'thrower',
      `
      export function createTools() {
        return [{
          name: 'thrower',
          async execute() {
            throw new Error('boom from inside worker');
          },
        }];
      }
      `,
    );
    const sandbox = new WorkerSandbox(new Map([['thrower', { moduleUrl, toolName: 'thrower' }]]));
    const inst = await sandbox.acquire(POLICY);
    const result = await sandbox.execute(inst, 'thrower', {}, 5000);
    await sandbox.release(inst);

    expect(result.success).toBe(false);
    expect(result.error).toContain('boom from inside worker');
  }, 15_000);

  it('terminates the worker on timeout and returns an error result', async () => {
    const moduleUrl = writeModule(
      'sleeper',
      `
      export function createTools() {
        return [{
          name: 'sleeper',
          async execute() {
            await new Promise((r) => setTimeout(r, 5000));
            return 'never';
          },
        }];
      }
      `,
    );
    const sandbox = new WorkerSandbox(new Map([['sleeper', { moduleUrl, toolName: 'sleeper' }]]));
    const inst = await sandbox.acquire(POLICY);
    const start = Date.now();
    const result = await sandbox.execute(inst, 'sleeper', {}, 200);
    const elapsed = Date.now() - start;
    await sandbox.release(inst);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out|exited/i);
    // Should terminate well before the 5s sleep — give 2s slack for spawn cost.
    expect(elapsed).toBeLessThan(2500);
  }, 15_000);

  it('returns error for unknown tool names without spawning a worker', async () => {
    const sandbox = new WorkerSandbox(new Map());
    const inst = await sandbox.acquire(POLICY);
    const result = await sandbox.execute(inst, 'nonexistent', {}, 1000);
    await sandbox.release(inst);

    expect(result.success).toBe(false);
    expect(result.error).toContain('unknown tool');
  });

  it('returns error when acquired sandbox id is unknown', async () => {
    const sandbox = new WorkerSandbox(new Map());
    const result = await sandbox.execute(
      {
        id: 'fake',
        status: 'ready',
        startedAt: 0,
        resourceUsage: { cpuSeconds: 0, memoryMb: 0, diskMb: 0 },
      },
      'whatever',
      {},
      1000,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('sandbox not acquired');
  });

  it('isolates state across calls — separate workers per execute()', async () => {
    // Module sets a top-level counter. If workers were reused, the second
    // call would see counter=2. Per-execute spawn must reset it to 1.
    const moduleUrl = writeModule(
      'counter',
      `
      let counter = 0;
      export function createTools() {
        return [{
          name: 'counter',
          async execute() {
            counter += 1;
            return { counter };
          },
        }];
      }
      `,
    );
    const sandbox = new WorkerSandbox(new Map([['counter', { moduleUrl, toolName: 'counter' }]]));
    const inst = await sandbox.acquire(POLICY);
    const r1 = await sandbox.execute(inst, 'counter', {}, 5000);
    const r2 = await sandbox.execute(inst, 'counter', {}, 5000);
    await sandbox.release(inst);

    expect(JSON.parse(r1.output ?? 'null').counter).toBe(1);
    expect(JSON.parse(r2.output ?? 'null').counter).toBe(1);
  }, 20_000);

  it('emits S1 trace events on acquire / execute / release', async () => {
    const moduleUrl = writeModule(
      'noop',
      `
      export function createTools() {
        return [{ name: 'noop', async execute() { return 'ok'; } }];
      }
      `,
    );
    const events: Array<{ event: string; block: string; summary?: string }> = [];
    const trace = {
      traceId: 'trace-1',
      sessionId: 'sess-1',
      agentId: 'ag-1',
      traceLogger: {
        event(e: { event: string; block: string; summary?: string }) {
          events.push({
            event: e.event,
            block: e.block,
            ...(e.summary !== undefined ? { summary: e.summary } : {}),
          });
        },
        async span<T>(_o: unknown, fn: () => Promise<T>) {
          return fn();
        },
        async close() {
          /* noop */
        },
      },
    };
    const sandbox = new WorkerSandbox(new Map([['noop', { moduleUrl, toolName: 'noop' }]]));
    const inst = await sandbox.acquire(POLICY, trace);
    await sandbox.execute(inst, 'noop', {}, 5000, trace);
    await sandbox.release(inst, trace);

    const eventNames = events.map((e) => e.event);
    expect(eventNames).toEqual(['sandbox_acquired', 'sandbox_executed', 'sandbox_released']);
    expect(events.every((e) => e.block === 'S1')).toBe(true);
    expect(events[0]!.summary).toMatch(/worker sandbox/i);
  }, 15_000);
});
