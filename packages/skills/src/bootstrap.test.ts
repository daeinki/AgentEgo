import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { compareVersions, seedBuiltinSkills } from './bootstrap.js';
import type { SkillManifest } from './manifest.js';

function mkManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    id: 'sample-skill',
    name: 'Sample',
    description: 'a skill for tests',
    version: '0.1.0',
    author: 'test',
    permissions: [],
    entryPoint: 'index.js',
    contentSha256: 'a'.repeat(64),
    ...overrides,
  };
}

async function writeSkill(dir: string, manifest: SkillManifest, index: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
  await writeFile(resolve(dir, 'index.js'), index, 'utf-8');
}

describe('compareVersions', () => {
  it('orders major / minor / patch in expected direction', () => {
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.1.0', '1.0.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.1', '1.0.0')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.2.0')).toBeLessThan(0);
  });
});

describe('seedBuiltinSkills', () => {
  let tmpRoot: string;
  let installRoot: string;
  let builtinRoot: string;
  let logs: string[];
  const logger = (m: string): void => {
    logs.push(m);
  };

  beforeEach(() => {
    tmpRoot = mkdtempSync(resolve(tmpdir(), 'seed-builtin-'));
    installRoot = resolve(tmpRoot, 'installed');
    builtinRoot = resolve(tmpRoot, 'builtin');
    logs = [];
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('seeds a fresh skill when the target directory is absent', async () => {
    await writeSkill(
      resolve(builtinRoot, 'sample-skill'),
      mkManifest(),
      "export const createTools = () => [];",
    );

    const result = await seedBuiltinSkills(installRoot, builtinRoot, { logger });

    expect(result.seeded).toEqual(['sample-skill']);
    expect(result.upgraded).toEqual([]);
    expect(result.skipped).toEqual([]);
    const installed = await readFile(
      resolve(installRoot, 'sample-skill', 'manifest.json'),
      'utf-8',
    );
    expect(JSON.parse(installed).version).toBe('0.1.0');
    const entry = await readFile(resolve(installRoot, 'sample-skill', 'index.js'), 'utf-8');
    expect(entry).toContain('createTools');
  });

  it('is idempotent: a second call with the same bundled version skips', async () => {
    await writeSkill(
      resolve(builtinRoot, 'sample-skill'),
      mkManifest(),
      "export const createTools = () => [];",
    );
    await seedBuiltinSkills(installRoot, builtinRoot, { logger });
    logs = [];

    const result = await seedBuiltinSkills(installRoot, builtinRoot, { logger });

    expect(result.seeded).toEqual([]);
    expect(result.upgraded).toEqual([]);
    expect(result.skipped).toEqual(['sample-skill']);
  });

  it('upgrades when bundled version is strictly newer than installed', async () => {
    await writeSkill(
      resolve(builtinRoot, 'sample-skill'),
      mkManifest({ version: '0.1.0' }),
      "export const createTools = () => ['v1'];",
    );
    await seedBuiltinSkills(installRoot, builtinRoot);
    // Bump bundled source.
    await writeSkill(
      resolve(builtinRoot, 'sample-skill'),
      mkManifest({ version: '0.2.0' }),
      "export const createTools = () => ['v2'];",
    );
    logs = [];

    const result = await seedBuiltinSkills(installRoot, builtinRoot, { logger });

    expect(result.upgraded).toEqual(['sample-skill']);
    const entry = await readFile(resolve(installRoot, 'sample-skill', 'index.js'), 'utf-8');
    expect(entry).toContain('v2');
    const installed = JSON.parse(
      await readFile(resolve(installRoot, 'sample-skill', 'manifest.json'), 'utf-8'),
    );
    expect(installed.version).toBe('0.2.0');
  });

  it('preserves a user install that has a newer version than the bundle', async () => {
    await writeSkill(
      resolve(builtinRoot, 'sample-skill'),
      mkManifest({ version: '0.1.0' }),
      "export const createTools = () => ['bundled'];",
    );
    await seedBuiltinSkills(installRoot, builtinRoot);
    // User hand-edits the installed copy to a higher version.
    await writeSkill(
      resolve(installRoot, 'sample-skill'),
      mkManifest({ version: '0.3.0' }),
      "export const createTools = () => ['user-modified'];",
    );
    logs = [];

    const result = await seedBuiltinSkills(installRoot, builtinRoot, { logger });

    expect(result.skipped).toEqual(['sample-skill']);
    const entry = await readFile(resolve(installRoot, 'sample-skill', 'index.js'), 'utf-8');
    expect(entry).toContain('user-modified');
  });

  it('skips candidates with an invalid manifest and logs the reason', async () => {
    const skillDir = resolve(builtinRoot, 'broken');
    await mkdir(skillDir, { recursive: true });
    await writeFile(resolve(skillDir, 'manifest.json'), '{ not valid }', 'utf-8');

    const result = await seedBuiltinSkills(installRoot, builtinRoot, { logger });

    expect(result.seeded).toEqual([]);
    expect(result.upgraded).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(logs.some((m) => m.includes('invalid manifest'))).toBe(true);
    // Install root still exists but contains nothing.
    const installEntries = await readdir(installRoot);
    expect(installEntries).toEqual([]);
  });

  it('returns empty result when builtinRoot does not exist', async () => {
    const result = await seedBuiltinSkills(
      installRoot,
      resolve(tmpRoot, 'does-not-exist'),
      { logger },
    );
    expect(result.seeded).toEqual([]);
    expect(result.upgraded).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(logs.some((m) => m.includes('does not exist'))).toBe(true);
  });
});
