import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalSkillRegistry } from '@agent-platform/skills';
import { skillCreateTool, skillListTool, __testing__ } from './skill-tools.js';

const { staticCheckSource } = __testing__;

describe('skill-tools — static source check (U10 Phase 5.2)', () => {
  it('accepts a simple ESM skill with allow-listed imports', () => {
    const src = `
import { readFile } from 'node:fs/promises';
export function createTools() {
  return [{ name: 'ok.tool', execute: async () => ({ toolName:'ok.tool', success:true, output:'', durationMs:0 }) }];
}`;
    expect(staticCheckSource(src)).toEqual({ ok: true });
  });

  it('rejects eval()', () => {
    const src = 'export function createTools(){ eval("bad"); return []; }';
    const r = staticCheckSource(src);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/eval/);
  });

  it('rejects new Function()', () => {
    const src = 'export function createTools(){ const f = new Function("x", "return x"); return []; }';
    const r = staticCheckSource(src);
    expect(r.ok).toBe(false);
  });

  it('rejects child_process import', () => {
    const src = "import cp from 'node:child_process'; export function createTools(){ return []; }";
    const r = staticCheckSource(src);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/child_process/);
  });

  it('rejects CommonJS require()', () => {
    const src = "const x = require('node:fs'); export function createTools(){ return []; }";
    const r = staticCheckSource(src);
    expect(r.ok).toBe(false);
  });

  it('rejects dynamic import()', () => {
    const src = "export async function createTools(){ await import('./bad.js'); return []; }";
    const r = staticCheckSource(src);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/dynamic import/);
  });

  it('rejects imports outside the allow-list', () => {
    const src = "import axios from 'axios'; export function createTools(){ return []; }";
    const r = staticCheckSource(src);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/allow-list/);
  });
});

describe('skill-tools — skill.create (U10 Phase 3)', () => {
  let tmp: string;
  let registry: LocalSkillRegistry;

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'skill-tools-'));
    registry = new LocalSkillRegistry({ installRoot: tmp, searchPaths: [tmp] });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('creates a skill when source passes static check', async () => {
    const tool = skillCreateTool({ registry });
    const result = await tool.execute(
      {
        id: 'happy-skill',
        name: 'Happy',
        description: 'minimal passing skill',
        sourceCode:
          'export function createTools() { return [{ name: "happy.ping", execute: async () => ({ toolName: "happy.ping", success: true, output: "ok", durationMs: 0 }) }]; }\n',
      },
      { sessionId: 's', agentId: 'a', traceId: 't', signal: new AbortController().signal },
    );

    expect(result.success).toBe(true);
    const installed = await registry.listInstalled();
    expect(installed.map((i) => i.metadata.id)).toContain('happy-skill');
  });

  it('rejects a skill whose sourceCode fails static check', async () => {
    const tool = skillCreateTool({ registry });
    const result = await tool.execute(
      {
        id: 'evil-skill',
        name: 'Evil',
        description: 'tries to spawn a shell',
        sourceCode:
          "import cp from 'node:child_process'; export function createTools(){ cp.execSync('whoami'); return []; }",
      },
      { sessionId: 's', agentId: 'a', traceId: 't', signal: new AbortController().signal },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/static check/);
    // Install dir must not have been created.
    const installed = await registry.listInstalled();
    expect(installed.map((i) => i.metadata.id)).not.toContain('evil-skill');
  });

  it('skill.list returns installed skills and filters by query', async () => {
    const create = skillCreateTool({ registry });
    await create.execute(
      {
        id: 'alpha',
        name: 'Alpha',
        description: 'first skill',
        sourceCode: 'export function createTools(){ return []; }',
      },
      { sessionId: 's', agentId: 'a', traceId: 't', signal: new AbortController().signal },
    );
    await create.execute(
      {
        id: 'beta',
        name: 'Beta',
        description: 'second skill',
        sourceCode: 'export function createTools(){ return []; }',
      },
      { sessionId: 's', agentId: 'a', traceId: 't', signal: new AbortController().signal },
    );

    const list = skillListTool({ registry });
    const allResult = await list.execute(
      {},
      { sessionId: 's', agentId: 'a', traceId: 't', signal: new AbortController().signal },
    );
    expect(allResult.success).toBe(true);
    const allItems = JSON.parse(allResult.output ?? '[]') as Array<{ id: string }>;
    expect(allItems.map((i) => i.id).sort()).toEqual(['alpha', 'beta']);

    const filtered = await list.execute(
      { query: 'alph' },
      { sessionId: 's', agentId: 'a', traceId: 't', signal: new AbortController().signal },
    );
    const filteredItems = JSON.parse(filtered.output ?? '[]') as Array<{ id: string }>;
    expect(filteredItems.map((i) => i.id)).toEqual(['alpha']);
  });

  it('calls remount callback on successful create and reports mountedNow', async () => {
    let remountCalls = 0;
    const tool = skillCreateTool({
      registry,
      remount: () => {
        remountCalls += 1;
        return ['happy.ping'];
      },
    });
    const result = await tool.execute(
      {
        id: 'mount-test',
        name: 'Mount',
        description: 'test mount callback',
        sourceCode:
          'export function createTools() { return [{ name: "happy.ping", execute: async () => ({ toolName: "happy.ping", success: true, output: "", durationMs: 0 }) }]; }',
      },
      { sessionId: 's', agentId: 'a', traceId: 't', signal: new AbortController().signal },
    );

    expect(result.success).toBe(true);
    expect(remountCalls).toBe(1);
    const body = JSON.parse(result.output ?? '{}') as { mountedNow: boolean };
    expect(body.mountedNow).toBe(true);
  });
});
