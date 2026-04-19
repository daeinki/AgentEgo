import { afterAll, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, sep, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { assertSafeEntryPoint, loadSkillTools } from './loader.js';
import type { SkillManifest } from './manifest.js';

// Use a real, platform-appropriate install dir so `resolve()` produces
// something that matches the host OS's sep. We don't actually create files
// inside — assertSafeEntryPoint only inspects path strings. Dynamic
// allocation avoids "C:\tmp" / "/tmp" existence assumptions on CI.
const INSTALL = mkdtempSync(resolve(tmpdir(), 'loader-test-install-'));

afterAll(() => {
  rmSync(INSTALL, { recursive: true, force: true });
});

describe('assertSafeEntryPoint (U10 Phase 5.1)', () => {
  it('accepts a simple relative file', () => {
    const out = assertSafeEntryPoint(INSTALL, 'index.js');
    expect(out.endsWith(`${sep}index.js`)).toBe(true);
  });

  it('accepts a nested relative path', () => {
    const out = assertSafeEntryPoint(INSTALL, 'lib/entry.js');
    expect(out.includes(`${sep}lib${sep}entry.js`)).toBe(true);
  });

  it('rejects .. traversal', () => {
    expect(() => assertSafeEntryPoint(INSTALL, '../evil.js')).toThrow(/escapes installDir/);
    expect(() => assertSafeEntryPoint(INSTALL, '../../../root/.ssh/id_rsa')).toThrow(
      /escapes installDir/,
    );
  });

  it('rejects POSIX absolute paths', () => {
    expect(() => assertSafeEntryPoint(INSTALL, '/etc/passwd')).toThrow(
      /must be a relative path/,
    );
  });

  it('rejects Windows drive-absolute paths', () => {
    expect(() => assertSafeEntryPoint(INSTALL, 'C:\\windows\\evil.js')).toThrow(
      /must be a relative path/,
    );
  });

  it('rejects url-scheme entries', () => {
    expect(() => assertSafeEntryPoint(INSTALL, 'file:///etc/passwd')).toThrow(
      /must be a relative path/,
    );
  });

  it('rejects empty / non-string entryPoint', () => {
    expect(() => assertSafeEntryPoint(INSTALL, '')).toThrow(/non-empty string/);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => assertSafeEntryPoint(INSTALL, null as any)).toThrow(/non-empty string/);
  });
});

describe('loadSkillTools — tool handler normalization', () => {
  function writeSkill(root: string, id: string, source: string): SkillManifest {
    const dir = resolve(root, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'index.js'), source, 'utf-8');
    return {
      id,
      name: id,
      description: 'test',
      version: '0.1.0',
      author: 'test',
      permissions: [],
      entryPoint: 'index.js',
      contentSha256: 'a'.repeat(64),
    };
  }

  it('accepts tools that use execute(args, ctx)', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'loader-exec-'));
    const manifest = writeSkill(
      root,
      'skill-with-execute',
      `export function createTools() {
        return [{
          name: 'demo.tool',
          async execute(args) { return { ok: true, args }; },
        }];
      }`,
    );
    const installDir = dirname(resolve(root, manifest.id, manifest.entryPoint));
    const tools = await loadSkillTools(manifest, installDir);
    expect(tools).toHaveLength(1);
    const res = (await tools[0]!.execute({ a: 1 }, {})) as { ok: boolean; args: unknown };
    expect(res.ok).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts tools that use the legacy call(args, ctx) alias', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'loader-call-'));
    const manifest = writeSkill(
      root,
      'skill-with-call',
      `export function createTools() {
        return [{
          name: 'demo.legacy',
          async call(args) { return { ok: true, legacy: true, args }; },
        }];
      }`,
    );
    const installDir = dirname(resolve(root, manifest.id, manifest.entryPoint));
    const tools = await loadSkillTools(manifest, installDir);
    expect(tools).toHaveLength(1);
    // After normalization the caller always uses .execute(), even though the
    // author wrote .call().
    const res = (await tools[0]!.execute({ a: 1 }, {})) as { legacy: boolean };
    expect(res.legacy).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('preserves other tool fields when normalizing call() → execute()', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'loader-fields-'));
    const manifest = writeSkill(
      root,
      'skill-fields',
      `export function createTools() {
        return [{
          name: 'demo.tool',
          description: 'desc',
          inputSchema: { type: 'object', properties: { x: { type: 'number' } } },
          riskLevel: 'medium',
          permissions: [{ type: 'system', access: 'read' }],
          async call() { return 'ok'; },
        }];
      }`,
    );
    const installDir = dirname(resolve(root, manifest.id, manifest.entryPoint));
    const tools = await loadSkillTools(manifest, installDir);
    const t = tools[0]!;
    expect(t.description).toBe('desc');
    expect(t.riskLevel).toBe('medium');
    expect(t.inputSchema).toEqual({ type: 'object', properties: { x: { type: 'number' } } });
    expect(t.permissions).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });

  it('rejects tools with neither execute nor call', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'loader-nohandler-'));
    const manifest = writeSkill(
      root,
      'skill-nohandler',
      `export function createTools() {
        return [{ name: 'demo.broken' }];
      }`,
    );
    const installDir = dirname(resolve(root, manifest.id, manifest.entryPoint));
    await expect(loadSkillTools(manifest, installDir)).rejects.toThrow(
      /must expose an execute\(args, ctx\) method/,
    );
    rmSync(root, { recursive: true, force: true });
  });
});
