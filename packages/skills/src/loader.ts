import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { SkillManifest } from './manifest.js';

/**
 * U10 Phase 5.1: prevent manifest.entryPoint from escaping installDir via
 * `..`, symlinks, or absolute paths. Throws with a stable error message the
 * caller can surface to audit logs.
 */
export function assertSafeEntryPoint(installDir: string, entryPoint: string): string {
  if (typeof entryPoint !== 'string' || entryPoint.length === 0) {
    throw new Error('skill entryPoint must be a non-empty string');
  }
  // Defense in depth: reject obvious absolute paths (Windows drive, POSIX root,
  // UNC, URL-like). The resolve() prefix check below is the real gate.
  if (
    entryPoint.startsWith('/') ||
    entryPoint.startsWith('\\') ||
    /^[a-zA-Z]:[\\/]/.test(entryPoint) ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(entryPoint)
  ) {
    throw new Error(`skill entryPoint must be a relative path inside installDir: ${entryPoint}`);
  }
  const installPrefix = installDir.endsWith(sep) ? installDir : installDir + sep;
  const resolved = resolve(installDir, entryPoint);
  if (resolved !== installDir && !resolved.startsWith(installPrefix)) {
    throw new Error(
      `skill entryPoint escapes installDir: ${entryPoint} -> ${resolved}`,
    );
  }
  return resolved;
}

/**
 * Each installed skill must export a `createTools` factory from its
 * `entryPoint`. The factory returns AgentTool-shaped objects; the loader
 * itself doesn't depend on the agent-worker package, so this contract is
 * expressed structurally.
 *
 * The tool's handler method is `execute(args, ctx)`. `call(args, ctx)` is
 * accepted as a legacy alias and normalized to `execute` by the loader —
 * early agent-authored skills chose the `call` name and are grandfathered in.
 */
export interface LoadedSkillTool {
  readonly name: string;
  readonly description?: string;
  readonly permissions?: unknown[];
  readonly riskLevel?: string;
  readonly inputSchema?: Record<string, unknown>;
  execute(args: unknown, ctx: unknown): Promise<unknown>;
  // DockerTool opt-in (see agent-worker).
  readonly runsInContainer?: boolean;
  dockerCommand?(args: unknown): unknown;
}

/**
 * What a skill's `createTools()` factory is allowed to return before the
 * loader normalizes it: each tool must expose either `execute` or `call` as
 * its handler.
 */
interface RawLoadedSkillTool {
  readonly name: string;
  readonly description?: string;
  readonly permissions?: unknown[];
  readonly riskLevel?: string;
  readonly inputSchema?: Record<string, unknown>;
  execute?(args: unknown, ctx: unknown): Promise<unknown>;
  call?(args: unknown, ctx: unknown): Promise<unknown>;
  readonly runsInContainer?: boolean;
  dockerCommand?(args: unknown): unknown;
}

export interface SkillModule {
  createTools(ctx: { manifest: SkillManifest; installDir: string }): RawLoadedSkillTool[];
}

export interface SkillLoaderOptions {
  /**
   * Hook for tests: replaces the dynamic import with a map. Keyed by the
   * resolved file URL.
   */
  moduleResolver?: (url: string) => Promise<SkillModule>;
}

/**
 * Load tools from an installed skill. Imports `manifest.entryPoint` and
 * invokes its `createTools()` factory. The returned tools are normalized so
 * callers can always invoke `.execute(args, ctx)` regardless of whether the
 * skill author used `execute` or the legacy `call` name.
 */
export async function loadSkillTools(
  manifest: SkillManifest,
  installDir: string,
  options: SkillLoaderOptions = {},
): Promise<LoadedSkillTool[]> {
  // Phase 5.1: traversal / absolute-path guard — must be the first thing we
  // do before any filesystem or import side effect.
  const entryPath = assertSafeEntryPoint(installDir, manifest.entryPoint);
  const moduleUrl = pathToFileURL(entryPath).href;
  const mod = options.moduleResolver
    ? await options.moduleResolver(moduleUrl)
    : ((await import(moduleUrl)) as SkillModule);

  if (typeof mod.createTools !== 'function') {
    throw new Error(
      `skill ${manifest.id}: entry point ${manifest.entryPoint} does not export createTools()`,
    );
  }
  const tools = mod.createTools({ manifest, installDir });
  if (!Array.isArray(tools)) {
    throw new Error(`skill ${manifest.id}: createTools() did not return an array`);
  }
  return tools.map((raw) => normalizeToolHandler(raw, manifest.id));
}

function normalizeToolHandler(
  raw: RawLoadedSkillTool,
  skillId: string,
): LoadedSkillTool {
  const handler = typeof raw.execute === 'function' ? raw.execute : raw.call;
  if (typeof handler !== 'function') {
    throw new Error(
      `skill ${skillId}: tool '${raw.name}' must expose an execute(args, ctx) method (or legacy call())`,
    );
  }
  if (handler === raw.execute) return raw as LoadedSkillTool;

  // Legacy call() — wrap with `execute` while preserving every other field.
  const normalized: LoadedSkillTool = {
    name: raw.name,
    execute: (args, ctx) => handler.call(raw, args, ctx),
    ...(raw.description !== undefined ? { description: raw.description } : {}),
    ...(raw.permissions !== undefined ? { permissions: raw.permissions } : {}),
    ...(raw.riskLevel !== undefined ? { riskLevel: raw.riskLevel } : {}),
    ...(raw.inputSchema !== undefined ? { inputSchema: raw.inputSchema } : {}),
    ...(raw.runsInContainer !== undefined ? { runsInContainer: raw.runsInContainer } : {}),
    ...(typeof raw.dockerCommand === 'function'
      ? { dockerCommand: (args: unknown) => raw.dockerCommand!(args) }
      : {}),
  };
  return normalized;
}
