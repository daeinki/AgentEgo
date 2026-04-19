import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalSkillRegistry, buildManifest } from './local-registry.js';
import { hashSkillDirectory } from './hash.js';

/** Scaffold a searchable skill dir under `root/<id>/`. Returns manifest path. */
async function scaffoldSkill(
  root: string,
  id: string,
  extras: { name?: string; description?: string; signingSecret?: string; withTamper?: boolean } = {},
): Promise<string> {
  const dir = resolve(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'index.js'), `export function run(){ return '${id}'; }\n`);
  writeFileSync(resolve(dir, 'README.md'), `# ${id}\n`);
  const manifest = await buildManifest(
    dir,
    {
      id,
      name: extras.name ?? id,
      description: extras.description ?? `skill ${id}`,
      version: '0.1.0',
      author: 'tester',
      permissions: [{ type: 'system', access: 'notify' }],
      entryPoint: 'index.js',
    },
    extras.signingSecret,
  );
  writeFileSync(resolve(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  if (extras.withTamper) {
    writeFileSync(resolve(dir, 'index.js'), 'tampered\n');
  }
  return resolve(dir, 'manifest.json');
}

describe('LocalSkillRegistry', () => {
  let tmp: string;
  let searchDir: string;
  let installDir: string;
  let reg: LocalSkillRegistry;

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), 'skills-'));
    searchDir = resolve(tmp, 'search');
    installDir = resolve(tmp, 'installed');
    mkdirSync(searchDir, { recursive: true });
    mkdirSync(installDir, { recursive: true });
    reg = new LocalSkillRegistry({ installRoot: installDir, searchPaths: [searchDir] });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('search() finds skills by id, name, or description', async () => {
    await scaffoldSkill(searchDir, 'deploy-helper', { description: 'helps with PR deploys' });
    await scaffoldSkill(searchDir, 'code-review', { description: 'reviews TypeScript' });

    expect((await reg.search('deploy')).map((s) => s.id)).toEqual(['deploy-helper']);
    expect((await reg.search('TypeScript')).map((s) => s.id)).toEqual(['code-review']);
    expect((await reg.search('')).length).toBe(2);
  });

  it('install() copies the skill into installRoot and verifies hash', async () => {
    await scaffoldSkill(searchDir, 'alpha');
    const result = await reg.install('alpha');
    expect(result.skillId).toBe('alpha');
    expect(result.location.endsWith('alpha')).toBe(true);

    const installed = await reg.listInstalled();
    expect(installed).toHaveLength(1);
    expect(installed[0]?.metadata.id).toBe('alpha');
  });

  it('install() refuses when hash does not match (tampered bundle)', async () => {
    await scaffoldSkill(searchDir, 'bad', { withTamper: true });
    await expect(reg.install('bad')).rejects.toThrow(/verification failed/);
  });

  it('install() skipVerification bypasses the check', async () => {
    await scaffoldSkill(searchDir, 'bad', { withTamper: true });
    const result = await reg.install('bad', { skipVerification: true });
    expect(result.skillId).toBe('bad');
  });

  it('install() rejects already-installed skill unless force=true', async () => {
    await scaffoldSkill(searchDir, 'alpha');
    await reg.install('alpha');
    await expect(reg.install('alpha')).rejects.toThrow(/already installed/);
    const res = await reg.install('alpha', { force: true });
    expect(res.skillId).toBe('alpha');
  });

  it('verify() detects post-install tampering', async () => {
    await scaffoldSkill(searchDir, 'honest');
    const result = await reg.install('honest');
    // Tamper with the installed copy.
    writeFileSync(resolve(result.location, 'index.js'), 'EVIL\n');
    const verification = await reg.verify('honest');
    expect(verification.hashMatches).toBe(false);
    expect(verification.message).toContain('content hash mismatch');
  });

  it('verify() reports not-installed cleanly', async () => {
    const res = await reg.verify('never-heard-of-this');
    expect(res.hashMatches).toBe(false);
    expect(res.message).toContain('not installed');
  });

  it('signingSecret enforces HMAC signature on manifest', async () => {
    const secret = 'sign-me';
    const signedReg = new LocalSkillRegistry({
      installRoot: installDir,
      searchPaths: [searchDir],
      signingSecret: secret,
    });
    await scaffoldSkill(searchDir, 'signed', { signingSecret: secret });
    const result = await signedReg.install('signed');
    expect(result.skillId).toBe('signed');

    // Now verify from a freshly constructed registry using the same secret.
    const verif = await signedReg.verify('signed');
    expect(verif.signatureValid).toBe(true);
  });

  it('signingSecret rejects unsigned skills', async () => {
    const secret = 'sign-me';
    const signedReg = new LocalSkillRegistry({
      installRoot: installDir,
      searchPaths: [searchDir],
      signingSecret: secret,
    });
    await scaffoldSkill(searchDir, 'unsigned'); // no signingSecret passed → no signature
    await expect(signedReg.install('unsigned')).rejects.toThrow(/verification failed/);
  });

  it('listInstalled() ignores non-skill directories', async () => {
    mkdirSync(resolve(installDir, 'junk'));
    writeFileSync(resolve(installDir, 'junk', 'random.txt'), 'nothing');
    const installed = await reg.listInstalled();
    expect(installed).toEqual([]);
  });

  it('hashSkillDirectory is order-stable', async () => {
    await scaffoldSkill(searchDir, 'alpha');
    const h1 = await hashSkillDirectory(resolve(searchDir, 'alpha'));
    const h2 = await hashSkillDirectory(resolve(searchDir, 'alpha'));
    expect(h1).toBe(h2);
  });

  // ─── U10 Phase 3: installFromDefinition ────────────────────────────────

  it('installFromDefinition stages source, signs, and installs a valid ESM skill', async () => {
    const result = await reg.installFromDefinition({
      id: 'time-now',
      name: 'Time Now',
      description: 'Returns current ISO timestamp.',
      permissions: [],
      sourceCode:
        'export function createTools() { return [{ name: "time.now", execute: async () => ({ toolName: "time.now", success: true, output: new Date().toISOString(), durationMs: 0 }) }]; }\n',
    });
    expect(result.skillId).toBe('time-now');
    expect(result.location).toBe(resolve(installDir, 'time-now'));

    const installed = await reg.listInstalled();
    expect(installed.map((i) => i.metadata.id)).toContain('time-now');

    // manifest.json should exist and have the content hash populated.
    const manifestRaw = readFileSync(resolve(installDir, 'time-now', 'manifest.json'), 'utf-8');
    const manifest = JSON.parse(manifestRaw) as { contentSha256: string; entryPoint: string };
    expect(manifest.entryPoint).toBe('index.js');
    expect(manifest.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('installFromDefinition rejects invalid id patterns', async () => {
    await expect(
      reg.installFromDefinition({
        id: 'UPPER-CASE',
        name: 'bad',
        description: 'xx',
        permissions: [],
        sourceCode: 'export function createTools(){ return []; }',
      }),
    ).rejects.toThrow(/invalid skill id/);

    await expect(
      reg.installFromDefinition({
        id: 'ab', // too short
        name: 'bad',
        description: 'xx',
        permissions: [],
        sourceCode: 'export function createTools(){ return []; }',
      }),
    ).rejects.toThrow(/invalid skill id/);
  });

  it('installFromDefinition rejects duplicate id without force', async () => {
    const def = {
      id: 'dup-skill',
      name: 'dup',
      description: 'dup test',
      permissions: [],
      sourceCode: 'export function createTools(){ return []; }\n',
    };
    await reg.installFromDefinition(def);
    await expect(reg.installFromDefinition(def)).rejects.toThrow(/already installed/);
  });

  it('uninstall removes an installed skill and returns true', async () => {
    await reg.installFromDefinition({
      id: 'to-remove',
      name: 'rm',
      description: 'removable',
      permissions: [],
      sourceCode: 'export function createTools(){ return []; }\n',
    });
    const removed = await reg.uninstall('to-remove');
    expect(removed).toBe(true);
    const again = await reg.uninstall('to-remove');
    expect(again).toBe(false);
  });

  it('buildManifest produces a hash that matches the skill directory', async () => {
    const manifestPath = await scaffoldSkill(searchDir, 'beta');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { contentSha256: string };
    const recomputed = await hashSkillDirectory(resolve(searchDir, 'beta'));
    expect(manifest.contentSha256).toBe(recomputed);
  });
});
