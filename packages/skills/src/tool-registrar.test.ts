import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalSkillRegistry, buildManifest } from './local-registry.js';
import { mountInstalledSkills } from './tool-registrar.js';
import type { SkillModule, LoadedSkillTool } from './loader.js';

async function scaffoldAndInstall(
  searchDir: string,
  registry: LocalSkillRegistry,
  id: string,
  options: { exportCreateTools: boolean; toolNames: string[] },
): Promise<void> {
  const dir = resolve(searchDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'index.js'), '// placeholder\n');
  const manifest = await buildManifest(dir, {
    id,
    name: id,
    description: id,
    version: '0.1.0',
    author: 'tester',
    permissions: [],
    entryPoint: 'index.js',
  });
  writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await registry.install(id);
}

function makeFakeTool(name: string, riskLevel = 'low'): LoadedSkillTool {
  return {
    name,
    description: `fake tool ${name}`,
    riskLevel,
    permissions: [],
    inputSchema: { type: 'object' },
    async execute(_args, _ctx) {
      return { toolName: name, success: true, durationMs: 1 };
    },
  };
}

describe('mountInstalledSkills', () => {
  let tmp: string;
  let searchDir: string;
  let installDir: string;
  let reg: LocalSkillRegistry;

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'skill-mount-'));
    searchDir = resolve(tmp, 'search');
    installDir = resolve(tmp, 'installed');
    mkdirSync(searchDir, { recursive: true });
    mkdirSync(installDir, { recursive: true });
    reg = new LocalSkillRegistry({ installRoot: installDir, searchPaths: [searchDir] });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('loads tools from a valid skill via the module resolver', async () => {
    await scaffoldAndInstall(searchDir, reg, 'alpha', {
      exportCreateTools: true,
      toolNames: ['alpha.do'],
    });

    const moduleResolver = async (): Promise<SkillModule> => ({
      createTools: () => [makeFakeTool('alpha.do')],
    });

    const { tools, errors } = await mountInstalledSkills(reg, { moduleResolver });
    expect(errors).toEqual([]);
    expect(tools.size).toBe(1);
    expect(tools.has('alpha.do')).toBe(true);
    expect(tools.get('alpha.do')?.manifest.id).toBe('alpha');
  });

  it('aggregates multiple skills into a single tool map', async () => {
    await scaffoldAndInstall(searchDir, reg, 'alpha', { exportCreateTools: true, toolNames: ['a'] });
    await scaffoldAndInstall(searchDir, reg, 'beta', { exportCreateTools: true, toolNames: ['b'] });

    const moduleResolver = async (url: string): Promise<SkillModule> => {
      // Return a different factory per install dir.
      if (url.includes('alpha')) return { createTools: () => [makeFakeTool('a')] };
      return { createTools: () => [makeFakeTool('b')] };
    };

    const { tools, errors } = await mountInstalledSkills(reg, { moduleResolver });
    expect(errors).toEqual([]);
    expect([...tools.keys()].sort()).toEqual(['a', 'b']);
  });

  it('reports skills whose entry point lacks createTools', async () => {
    await scaffoldAndInstall(searchDir, reg, 'broken', { exportCreateTools: false, toolNames: [] });
    const moduleResolver = async (): Promise<SkillModule> => ({} as SkillModule);

    const { tools, errors } = await mountInstalledSkills(reg, { moduleResolver });
    expect(tools.size).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error.message).toContain('createTools');
  });

  it('rejects duplicate tool names across skills', async () => {
    await scaffoldAndInstall(searchDir, reg, 'alpha', { exportCreateTools: true, toolNames: ['x'] });
    await scaffoldAndInstall(searchDir, reg, 'beta', { exportCreateTools: true, toolNames: ['x'] });

    const moduleResolver = async (): Promise<SkillModule> => ({
      createTools: () => [makeFakeTool('x')],
    });

    const { tools, errors } = await mountInstalledSkills(reg, { moduleResolver });
    // First skill wins; second is reported as error.
    expect(tools.size).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error.message).toContain('duplicate tool name');
  });

  it('skips skills that throw at createTools time', async () => {
    await scaffoldAndInstall(searchDir, reg, 'thrower', { exportCreateTools: true, toolNames: ['t'] });
    const moduleResolver = async (): Promise<SkillModule> => ({
      createTools: () => {
        throw new Error('bad init');
      },
    });

    const { tools, errors } = await mountInstalledSkills(reg, { moduleResolver });
    expect(tools.size).toBe(0);
    expect(errors[0]?.error.message).toContain('bad init');
  });

  it('passes manifest + installDir context to createTools', async () => {
    await scaffoldAndInstall(searchDir, reg, 'ctx', { exportCreateTools: true, toolNames: ['t'] });
    let receivedId: string | undefined;
    let receivedDir: string | undefined;
    const moduleResolver = async (): Promise<SkillModule> => ({
      createTools: (ctx) => {
        receivedId = ctx.manifest.id;
        receivedDir = ctx.installDir;
        return [makeFakeTool('t')];
      },
    });
    await mountInstalledSkills(reg, { moduleResolver });
    expect(receivedId).toBe('ctx');
    expect(receivedDir).toContain('ctx');
  });

  it('returns empty tool map when no skills are installed', async () => {
    const { tools, errors } = await mountInstalledSkills(reg);
    expect(tools.size).toBe(0);
    expect(errors).toEqual([]);
  });
});
