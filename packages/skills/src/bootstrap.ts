import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest, type SkillManifest } from './manifest.js';

/**
 * Absolute path to the directory that holds first-party builtin skills. Each
 * direct child is one skill with its own `manifest.json`.
 *
 * Resolved at module load time: this file ships as `dist/bootstrap.js`, and
 * the `builtin/` directory is a sibling of `dist/` inside the package — so
 * `../builtin` from here is correct for both compiled (dist) and type-checked
 * source-tree resolutions.
 */
export const BUILTIN_SKILLS_ROOT: string = fileURLToPath(
  new URL('../builtin', import.meta.url),
);

export interface SeedBuiltinSkillsOptions {
  /**
   * Called with human-readable progress / warning messages. Must not throw —
   * any exception is swallowed so bootstrap never blocks gateway startup.
   * Typical consumers: the platform's TraceLogger or a console.info shim.
   */
  logger?: (message: string) => void;
}

export interface SeedBuiltinSkillsResult {
  /** Skill ids that had no prior install and were copied fresh. */
  seeded: string[];
  /** Skill ids whose bundled version is newer than the installed one — overwritten. */
  upgraded: string[];
  /** Skill ids whose installed version is equal-or-newer — left untouched. */
  skipped: string[];
}

/**
 * Idempotently seed first-party builtin skills into `installRoot`. Each
 * direct child directory of `builtinRoot` that contains a valid
 * `manifest.json` is considered a candidate; it is copied to
 * `installRoot/<manifest.id>/` when either (a) the target does not exist, or
 * (b) the bundled `manifest.version` is strictly newer than what is already
 * installed. A user-maintained installation whose version ≥ bundled version
 * is preserved — bootstrap never overwrites manual upgrades.
 *
 * Errors reading a candidate's manifest are logged and the candidate is
 * skipped; they must not fail gateway startup.
 */
export async function seedBuiltinSkills(
  installRoot: string,
  builtinRoot: string,
  options: SeedBuiltinSkillsOptions = {},
): Promise<SeedBuiltinSkillsResult> {
  const log = options.logger ?? (() => {});
  const result: SeedBuiltinSkillsResult = { seeded: [], upgraded: [], skipped: [] };

  if (!existsSync(builtinRoot)) {
    log(`seedBuiltinSkills: builtinRoot does not exist: ${builtinRoot}`);
    return result;
  }

  let entries;
  try {
    entries = await readdir(builtinRoot, { withFileTypes: true });
  } catch (err) {
    log(`seedBuiltinSkills: readdir failed on ${builtinRoot}: ${(err as Error).message}`);
    return result;
  }

  await mkdir(installRoot, { recursive: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sourceDir = resolve(builtinRoot, entry.name);
    const manifestPath = resolve(sourceDir, 'manifest.json');
    if (!existsSync(manifestPath)) {
      log(`seedBuiltinSkills: ${entry.name}: missing manifest.json — skipping`);
      continue;
    }

    let bundled: SkillManifest;
    try {
      const raw = await readFile(manifestPath, 'utf-8');
      bundled = parseManifest(JSON.parse(raw));
    } catch (err) {
      log(`seedBuiltinSkills: ${entry.name}: invalid manifest (${(err as Error).message}) — skipping`);
      continue;
    }

    const targetDir = resolve(installRoot, bundled.id);
    const installedPath = resolve(targetDir, 'manifest.json');

    if (!existsSync(installedPath)) {
      try {
        await mkdir(targetDir, { recursive: true });
        await cp(sourceDir, targetDir, { recursive: true, force: true });
        result.seeded.push(bundled.id);
        log(`seedBuiltinSkills: seeded '${bundled.id}' @ ${bundled.version}`);
      } catch (err) {
        log(`seedBuiltinSkills: ${bundled.id}: copy failed (${(err as Error).message})`);
      }
      continue;
    }

    let installed: SkillManifest;
    try {
      const raw = await readFile(installedPath, 'utf-8');
      installed = parseManifest(JSON.parse(raw));
    } catch (err) {
      // Installed manifest is corrupt — safer to skip than to overwrite
      // a user-modified directory we can't identify.
      log(
        `seedBuiltinSkills: ${bundled.id}: installed manifest unreadable ` +
          `(${(err as Error).message}) — skipping, please remove ${targetDir} to reseed`,
      );
      continue;
    }

    if (compareVersions(bundled.version, installed.version) > 0) {
      try {
        await rm(targetDir, { recursive: true, force: true });
        await mkdir(targetDir, { recursive: true });
        await cp(sourceDir, targetDir, { recursive: true, force: true });
        result.upgraded.push(bundled.id);
        log(
          `seedBuiltinSkills: upgraded '${bundled.id}' ${installed.version} → ${bundled.version}`,
        );
      } catch (err) {
        log(`seedBuiltinSkills: ${bundled.id}: upgrade failed (${(err as Error).message})`);
      }
    } else {
      result.skipped.push(bundled.id);
    }
  }

  return result;
}

/**
 * Semver-ish comparison. The manifest schema enforces `^\d+\.\d+\.\d+`, so we
 * only handle that shape — pre-release / build metadata is out of scope.
 *
 * Returns  > 0  if `a` is strictly newer than `b`,
 *          < 0  if `a` is strictly older,
 *          = 0  if equal.
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

