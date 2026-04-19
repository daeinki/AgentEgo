import type { LocalSkillRegistry } from './local-registry.js';
import { loadSkillTools, type LoadedSkillTool, type SkillLoaderOptions } from './loader.js';
import type { SkillManifest } from './manifest.js';

export interface SkillToolMount {
  manifest: SkillManifest;
  installDir: string;
  tool: LoadedSkillTool;
}

/**
 * Resolve all installed skills into a flat tool map keyed by `tool.name`.
 * Duplicate names are rejected — the second skill that tries to register
 * the same tool name throws, so callers notice collisions at boot time
 * rather than silently shadowing.
 */
export async function mountInstalledSkills(
  registry: LocalSkillRegistry,
  options: SkillLoaderOptions = {},
): Promise<{
  tools: Map<string, SkillToolMount>;
  errors: Array<{ skillId: string; error: Error }>;
}> {
  const tools = new Map<string, SkillToolMount>();
  const errors: Array<{ skillId: string; error: Error }> = [];
  const installed = await registry.listInstalled();

  for (const entry of installed) {
    if (!entry.enabled) continue;
    try {
      // listInstalled gives us SkillMetadata, but we need the full SkillManifest
      // (for entryPoint and contentSha256). Re-read from the install dir.
      const fs = await import('node:fs/promises');
      const { resolve } = await import('node:path');
      const raw = await fs.readFile(resolve(entry.location, 'manifest.json'), 'utf-8');
      const manifest = JSON.parse(raw) as SkillManifest;

      const loaded = await loadSkillTools(manifest, entry.location, options);
      for (const tool of loaded) {
        if (tools.has(tool.name)) {
          throw new Error(
            `duplicate tool name '${tool.name}' (previously registered by ${tools.get(tool.name)!.manifest.id})`,
          );
        }
        tools.set(tool.name, { manifest, installDir: entry.location, tool });
      }
    } catch (err) {
      errors.push({ skillId: entry.metadata.id, error: err as Error });
    }
  }

  return { tools, errors };
}
