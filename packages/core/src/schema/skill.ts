import { Type, type Static } from '@sinclair/typebox';
import { Permission } from './capability.js';

export const SkillMetadata = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.String(),
  version: Type.String(),
  author: Type.String(),
  signature: Type.Optional(Type.String()),
  permissions: Type.Array(Permission),
  riskAssessment: Type.Object({
    staticAnalysis: Type.Union([
      Type.Literal('pass'),
      Type.Literal('warn'),
      Type.Literal('fail'),
    ]),
    knownVulnerabilities: Type.Array(Type.String()),
  }),
});
export type SkillMetadata = Static<typeof SkillMetadata>;

export const InstallResult = Type.Object({
  skillId: Type.String(),
  installedAt: Type.Integer({ minimum: 0 }),
  version: Type.String(),
  location: Type.String(),
});
export type InstallResult = Static<typeof InstallResult>;

export const InstalledSkill = Type.Object({
  metadata: SkillMetadata,
  installedAt: Type.Integer({ minimum: 0 }),
  location: Type.String(),
  enabled: Type.Boolean(),
});
export type InstalledSkill = Static<typeof InstalledSkill>;

export const VerificationResult = Type.Object({
  skillId: Type.String(),
  signatureValid: Type.Boolean(),
  hashMatches: Type.Boolean(),
  message: Type.Optional(Type.String()),
});
export type VerificationResult = Static<typeof VerificationResult>;
