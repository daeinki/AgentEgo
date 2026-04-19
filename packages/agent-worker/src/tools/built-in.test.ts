import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fsListTool, fsReadTool, fsWriteTool, webFetchTool } from './built-in.js';
import { InProcessSandbox } from './sandbox.js';
import type { AgentTool } from './types.js';
import { ownerPolicy } from '../security/capability-guard.js';

async function runDirectly<A>(tool: AgentTool<A>, args: A): Promise<ReturnType<AgentTool<A>['execute']>> {
  const controller = new AbortController();
  return tool.execute(args, {
    sessionId: 's',
    agentId: 'a',
    traceId: 't',
    signal: controller.signal,
  });
}

describe('fsReadTool / fsWriteTool', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'tools-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes and reads a file inside the allowlist', async () => {
    const write = fsWriteTool([dir]);
    const read = fsReadTool([dir]);
    const target = resolve(dir, 'notes.txt');

    const writeRes = await runDirectly(write, { path: target, content: 'hello' });
    expect(writeRes.success).toBe(true);

    const readRes = await runDirectly(read, { path: target });
    expect(readRes.success).toBe(true);
    expect(readRes.output).toBe('hello');
  });

  it('rejects paths outside the allowlist', async () => {
    const read = fsReadTool([dir]);
    const res = await runDirectly(read, { path: resolve(dir, '..', '..', 'etc', 'passwd') });
    expect(res.success).toBe(false);
    expect(res.error).toContain('outside allow-list');
  });

  it('fs.write createDirs creates missing parents', async () => {
    const write = fsWriteTool([dir]);
    const target = resolve(dir, 'deep', 'nested', 'f.txt');
    const res = await runDirectly(write, { path: target, content: 'x', createDirs: true });
    expect(res.success).toBe(true);
    expect(readFileSync(target, 'utf-8')).toBe('x');
  });

  it('fs.read truncates to maxBytes', async () => {
    const write = fsWriteTool([dir]);
    const read = fsReadTool([dir]);
    const target = resolve(dir, 'big.txt');
    await runDirectly(write, { path: target, content: 'abcdefghij' });
    const res = await runDirectly(read, { path: target, maxBytes: 5 });
    expect(res.output).toBe('abcde');
  });
});

describe('fsListTool', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'tools-list-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists immediate entries with file/dir kind prefix', async () => {
    const write = fsWriteTool([dir]);
    await runDirectly(write, { path: resolve(dir, 'a.txt'), content: '' });
    await runDirectly(write, { path: resolve(dir, 'b.txt'), content: '' });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(resolve(dir, 'sub'));

    const list = fsListTool([dir]);
    const res = await runDirectly(list, { path: dir });
    expect(res.success).toBe(true);
    expect(res.output).toContain('file  a.txt');
    expect(res.output).toContain('file  b.txt');
    expect(res.output).toContain('dir   sub'); // "dir " + 2-space separator
    expect(res.output).toMatch(/3 entries/);
  });

  it('rejects paths outside the allow-list', async () => {
    const list = fsListTool([dir]);
    const res = await runDirectly(list, { path: resolve(dir, '..') });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/outside allow-list/);
  });

  it('truncates with maxEntries and notes the remainder', async () => {
    const write = fsWriteTool([dir]);
    for (let i = 0; i < 10; i++) {
      await runDirectly(write, { path: resolve(dir, `f${i}.txt`), content: '' });
    }
    const list = fsListTool([dir]);
    const res = await runDirectly(list, { path: dir, maxEntries: 3 });
    expect(res.success).toBe(true);
    expect(res.output).toMatch(/\+7 more/);
  });
});

describe('webFetchTool', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('fetches from an allowlisted domain', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => 'body-content',
      })) as unknown as typeof fetch,
    );
    const tool = webFetchTool(['example.com']);
    const res = await runDirectly(tool, { url: 'https://example.com/foo' });
    expect(res.success).toBe(true);
    expect(res.output).toContain('body-content');
  });

  it('rejects non-allowlisted domain', async () => {
    const tool = webFetchTool(['example.com']);
    const res = await runDirectly(tool, { url: 'https://evil.test/' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('not allow-listed');
  });

  it('supports wildcard subdomain patterns', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => 'sub',
      })) as unknown as typeof fetch,
    );
    const tool = webFetchTool(['*.example.com']);
    const res = await runDirectly(tool, { url: 'https://api.example.com/v1' });
    expect(res.success).toBe(true);
  });

  it('reports error on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'oops',
      })) as unknown as typeof fetch,
    );
    const tool = webFetchTool(['example.com']);
    const res = await runDirectly(tool, { url: 'https://example.com/' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('500');
  });

  it('invalid url is rejected', async () => {
    const tool = webFetchTool(['example.com']);
    const res = await runDirectly(tool, { url: 'not-a-url' });
    expect(res.success).toBe(false);
    expect(res.error).toContain('invalid url');
  });
});

describe('InProcessSandbox', () => {
  it('acquire → execute → release roundtrip', async () => {
    const tool = fsReadTool([tmpdir()]);
    const tools = new Map([[tool.name, tool]]);
    const box = new InProcessSandbox(tools);
    const instance = await box.acquire(ownerPolicy('s'));
    expect(instance.id).toMatch(/^sandbox-/);
    const res = await box.execute(instance, 'fs.read', { path: `${tmpdir()}/nonexistent` }, 5000);
    expect(res.toolName).toBe('fs.read');
    await box.release(instance);
  });

  it('reports unknown tool', async () => {
    const box = new InProcessSandbox(new Map());
    const instance = await box.acquire(ownerPolicy('s'));
    const res = await box.execute(instance, 'mystery', {}, 1000);
    expect(res.success).toBe(false);
    expect(res.error).toContain('unknown tool');
    await box.release(instance);
  });

  it('reports error if sandbox instance was not acquired', async () => {
    const tool = fsReadTool([tmpdir()]);
    const box = new InProcessSandbox(new Map([[tool.name, tool]]));
    const res = await box.execute(
      { id: 'fake', status: 'ready', startedAt: 0, resourceUsage: { cpuSeconds: 0, memoryMb: 0, diskMb: 0 } },
      'fs.read',
      { path: '/tmp/x' },
      1000,
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain('not acquired');
  });
});
