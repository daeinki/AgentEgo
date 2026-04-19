import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { Schemas } from '@agent-platform/core';

/**
 * Per-skill manifest written as `manifest.json` in the skill's package dir.
 * Fields mirror `SkillMetadata` with two installation-time additions: a
 * content hash and a declared entry point.
 */
export const SkillManifest = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  description: Type.String(),
  version: Type.String({ pattern: '^\\d+\\.\\d+\\.\\d+' }),
  author: Type.String(),
  signature: Type.Optional(Type.String()),
  permissions: Type.Array(Schemas.CapabilitySchema.Permission),
  /**
   * Entry point — relative path inside the skill directory. Loaded lazily
   * when the skill is first invoked.
   */
  entryPoint: Type.String(),
  /**
   * SHA-256 hex of the skill's bundle. The registry verifies the on-disk
   * bytes against this before loading.
   */
  contentSha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
  /**
   * Minimum agent-platform major version this skill targets.
   */
  platformMinVersion: Type.Optional(Type.String()),
});
export type SkillManifest = Static<typeof SkillManifest>;

export function parseManifest(raw: unknown): SkillManifest {
  if (Value.Check(SkillManifest, raw)) return raw as SkillManifest;
  const errors = [...Value.Errors(SkillManifest, raw)].slice(0, 3).map((e) => `${e.path} ${e.message}`);
  throw new Error(`invalid skill manifest: ${errors.join('; ')}`);
}
