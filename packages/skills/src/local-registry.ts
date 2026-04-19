import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type {
  Contracts,
  InstalledSkill,
  InstallResult,
  SkillMetadata,
  VerificationResult,
} from '@agent-platform/core';
import { generateId, nowMs } from '@agent-platform/core';
import { hashSkillDirectory } from './hash.js';
import { assertSafeEntryPoint } from './loader.js';
import { parseManifest, type SkillManifest } from './manifest.js';

type SkillRegistry = Contracts.SkillRegistry;
type InstallOptions = Contracts.InstallOptions;

function expandHome(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

export interface LocalSkillRegistryConfig {
  /**
   * Root directory where installed skills live. Defaults to `~/.agent/skills`.
   */
  installRoot?: string;
  /**
   * Directories the registry scans for installable (uninstalled) skills. Each
   * entry must be a directory containing skill folders (one manifest.json each).
   */
  searchPaths?: string[];
  /**
   * Optional signing-secret used for HMAC-SHA256 `manifest.signature`. If set,
   * `verify()` and `install()` enforce it.
   */
  signingSecret?: string;
}

interface DiscoveredSkill {
  manifest: SkillManifest;
  sourceDir: string;
}

/**
 * U10 Phase 3: input to `LocalSkillRegistry.installFromDefinition` — the
 * LLM-authoring path. The caller supplies the JS/TS ESM `sourceCode` string
 * plus structural metadata; the registry stages the bytes to disk, computes
 * the content hash, (optionally) HMAC-signs, and installs via the normal
 * verified-copy path.
 *
 * Security model (ADR-011 proposed):
 *   - Owner-trusted sessions only (enforced by CapabilityGuard on skill.create).
 *   - entryPoint fixed to `index.js` (never user-controlled).
 *   - sourceCode is treated as untrusted — static checks upstream reject
 *     obviously dangerous patterns before reaching this method.
 */
export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  version?: string;
  author?: string;
  permissions: SkillManifest['permissions'];
  /**
   * ESM source for `index.js`. Must export `createTools({ manifest, installDir })`
   * returning `LoadedSkillTool[]`. No other files are staged — skills created
   * this way are single-file by design.
   */
  sourceCode: string;
  platformMinVersion?: string;
}

/**
 * Local filesystem-backed SkillRegistry.
 *
 * - `search()` scans `searchPaths` for skills whose manifest matches the query.
 * - `install()` copies a discovered skill into `installRoot/<id>/` after
 *   verifying content hash (and optionally HMAC signature).
 * - `listInstalled()` enumerates installed skills.
 * - `verify()` re-hashes an installed skill to detect tampering.
 */
export class LocalSkillRegistry implements SkillRegistry {
  private readonly installRoot: string;
  private readonly searchPaths: string[];
  private readonly signingSecret?: string;

  constructor(config: LocalSkillRegistryConfig = {}) {
    this.installRoot = expandHome(config.installRoot ?? '~/.agent/skills');
    this.searchPaths = (config.searchPaths ?? []).map(expandHome);
    if (config.signingSecret !== undefined) this.signingSecret = config.signingSecret;
  }

  async search(query: string): Promise<SkillMetadata[]> {
    const discovered = await this.discoverAll();
    const lower = query.toLowerCase();
    return discovered
      .map((d) => d.manifest)
      .filter((m) => {
        if (!query) return true;
        return (
          m.id.toLowerCase().includes(lower) ||
          m.name.toLowerCase().includes(lower) ||
          m.description.toLowerCase().includes(lower)
        );
      })
      .map(toMetadata);
  }

  async install(skillId: string, options: InstallOptions = {}): Promise<InstallResult> {
    const discovered = await this.discoverAll();
    const match = discovered.find((d) => d.manifest.id === skillId);
    if (!match) throw new Error(`skill ${skillId} not found in search paths`);

    if (!options.skipVerification) {
      const verification = await this.verifyAt(match.sourceDir);
      if (!verification.hashMatches || !verification.signatureValid) {
        throw new Error(
          `verification failed for ${skillId}: ${verification.message ?? 'unknown'}`,
        );
      }
    }

    const dest = resolve(this.installRoot, match.manifest.id);
    if (existsSync(dest)) {
      if (!options.force) throw new Error(`skill already installed: ${skillId}`);
      await rm(dest, { recursive: true, force: true });
    }

    await mkdir(this.installRoot, { recursive: true });
    await cp(match.sourceDir, dest, { recursive: true });
    return {
      skillId: match.manifest.id,
      installedAt: nowMs(),
      version: match.manifest.version,
      location: dest,
    };
  }

  /**
   * U10 Phase 3: programmatic install from an in-memory `SkillDefinition`.
   * Stages the sourceCode + generated manifest to a tmp dir, verifies, and
   * cp-installs into `installRoot/<id>/`. Throws on:
   *   - invalid id format
   *   - existing installation (unless options.force)
   *   - verification failure
   *
   * The staging directory is always cleaned up on both success and error to
   * avoid leaking agent-authored source into tmp.
   */
  async installFromDefinition(
    def: SkillDefinition,
    options: InstallOptions = {},
  ): Promise<InstallResult> {
    if (!/^[a-z][a-z0-9-]{2,40}$/.test(def.id)) {
      throw new Error(
        `invalid skill id: ${def.id} (must match /^[a-z][a-z0-9-]{2,40}$/)`,
      );
    }

    const dest = resolve(this.installRoot, def.id);
    if (existsSync(dest) && !options.force) {
      throw new Error(`skill already installed: ${def.id}`);
    }

    const stagingDir = resolve(tmpdir(), `ap-skill-${def.id}-${generateId()}`);
    try {
      await mkdir(stagingDir, { recursive: true });
      // Single-file skill convention — entryPoint always 'index.js'.
      await writeFile(resolve(stagingDir, 'index.js'), def.sourceCode, 'utf-8');

      const manifestBase: Omit<SkillManifest, 'contentSha256' | 'signature'> = {
        id: def.id,
        name: def.name,
        description: def.description,
        version: def.version ?? '0.1.0',
        author: def.author ?? 'agent-generated',
        permissions: def.permissions,
        entryPoint: 'index.js',
        ...(def.platformMinVersion !== undefined
          ? { platformMinVersion: def.platformMinVersion }
          : {}),
      };
      const manifest = await buildManifest(stagingDir, manifestBase, this.signingSecret);
      // Paranoia: traversal guard should trivially pass for a fixed
      // 'index.js' but the runtime invariant belongs here too.
      assertSafeEntryPoint(stagingDir, manifest.entryPoint);
      await writeFile(
        resolve(stagingDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf-8',
      );

      if (!options.skipVerification) {
        const verification = await this.verifyAt(stagingDir);
        if (!verification.hashMatches || !verification.signatureValid) {
          throw new Error(
            `verification failed for ${def.id}: ${verification.message ?? 'unknown'}`,
          );
        }
      }

      if (existsSync(dest)) {
        // options.force already validated above
        await rm(dest, { recursive: true, force: true });
      }
      await mkdir(this.installRoot, { recursive: true });
      await cp(stagingDir, dest, { recursive: true });

      return {
        skillId: def.id,
        installedAt: nowMs(),
        version: manifest.version,
        location: dest,
      };
    } finally {
      await rm(stagingDir, { recursive: true, force: true });
    }
  }

  async listInstalled(): Promise<InstalledSkill[]> {
    if (!existsSync(this.installRoot)) return [];
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(this.installRoot, { withFileTypes: true });
    const out: InstalledSkill[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = resolve(this.installRoot, entry.name);
      try {
        const manifest = await readManifest(dir);
        out.push({
          metadata: toMetadata(manifest),
          installedAt: 0, // filesystem ctime could fill this in later
          location: dir,
          enabled: true,
        });
      } catch {
        // Skip entries that aren't valid skills.
      }
    }
    return out;
  }

  /**
   * U10 Phase 3: remove an installed skill from `installRoot/<id>/`. No-op
   * (returns false) if the skill is not installed.
   */
  async uninstall(skillId: string): Promise<boolean> {
    const dir = resolve(this.installRoot, skillId);
    if (!existsSync(dir)) return false;
    await rm(dir, { recursive: true, force: true });
    return true;
  }

  async verify(skillId: string): Promise<VerificationResult> {
    const dir = resolve(this.installRoot, skillId);
    if (!existsSync(dir)) {
      return { skillId, signatureValid: false, hashMatches: false, message: 'not installed' };
    }
    return this.verifyAt(dir);
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private async discoverAll(): Promise<DiscoveredSkill[]> {
    const { readdir } = await import('node:fs/promises');
    const out: DiscoveredSkill[] = [];
    for (const root of this.searchPaths) {
      if (!existsSync(root)) continue;
      const entries = await readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = resolve(root, entry.name);
        try {
          const manifest = await readManifest(dir);
          out.push({ manifest, sourceDir: dir });
        } catch {
          // ignore non-skill folders
        }
      }
    }
    return out;
  }

  private async verifyAt(dir: string): Promise<VerificationResult> {
    let manifest: SkillManifest;
    try {
      manifest = await readManifest(dir);
    } catch (err) {
      return {
        skillId: 'unknown',
        signatureValid: false,
        hashMatches: false,
        message: `manifest parse failed: ${(err as Error).message}`,
      };
    }

    const actualHash = await hashSkillDirectory(dir);
    const hashMatches = actualHash === manifest.contentSha256;

    let signatureValid = true;
    if (this.signingSecret) {
      if (!manifest.signature) {
        signatureValid = false;
      } else {
        const { createHmac, timingSafeEqual } = await import('node:crypto');
        const expected = createHmac('sha256', this.signingSecret)
          .update(manifest.contentSha256)
          .digest('hex');
        const a = Buffer.from(manifest.signature, 'utf-8');
        const b = Buffer.from(expected, 'utf-8');
        signatureValid =
          a.length === b.length && timingSafeEqual(a, b);
      }
    }

    return {
      skillId: manifest.id,
      signatureValid,
      hashMatches,
      ...(!hashMatches
        ? { message: `content hash mismatch: expected ${manifest.contentSha256}, got ${actualHash}` }
        : !signatureValid
          ? { message: 'signature missing or invalid' }
          : {}),
    };
  }
}

async function readManifest(dir: string): Promise<SkillManifest> {
  const raw = await readFile(resolve(dir, 'manifest.json'), 'utf-8');
  return parseManifest(JSON.parse(raw));
}

function toMetadata(m: SkillManifest): SkillMetadata {
  const metadata: SkillMetadata = {
    id: m.id,
    name: m.name,
    description: m.description,
    version: m.version,
    author: m.author,
    permissions: m.permissions,
    riskAssessment: {
      staticAnalysis: 'pass',
      knownVulnerabilities: [],
    },
  };
  if (m.signature !== undefined) metadata.signature = m.signature;
  return metadata;
}

/**
 * Build a well-formed `manifest.json` body for testing + tooling. Computes the
 * content hash automatically and (optionally) signs it.
 */
export async function buildManifest(
  dir: string,
  base: Omit<SkillManifest, 'contentSha256' | 'signature'>,
  signingSecret?: string,
): Promise<SkillManifest> {
  const contentSha256 = await hashSkillDirectory(dir);
  const manifest: SkillManifest = { ...base, contentSha256 };
  if (signingSecret) {
    const { createHmac } = await import('node:crypto');
    manifest.signature = createHmac('sha256', signingSecret)
      .update(contentSha256)
      .digest('hex');
  }
  return manifest;
}
