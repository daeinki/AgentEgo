import type {
  SkillMetadata,
  InstallResult,
  InstalledSkill,
  VerificationResult,
} from '../schema/skill.js';

export interface InstallOptions {
  force?: boolean;
  skipVerification?: boolean;
}

export interface SkillRegistry {
  search(query: string): Promise<SkillMetadata[]>;
  install(skillId: string, options?: InstallOptions): Promise<InstallResult>;
  listInstalled(): Promise<InstalledSkill[]>;
  verify(skillId: string): Promise<VerificationResult>;
}
