import type { CapabilityDecision } from '../schema/capability.js';

export interface CapabilityGuard {
  check(sessionId: string, toolName: string, args: unknown): Promise<CapabilityDecision>;
}
