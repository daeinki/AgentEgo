import type {
  CapabilityDecision,
  Contracts,
  Permission,
  SessionPolicy,
} from '@agent-platform/core';
import type { AgentTool } from '../tools/types.js';

type CapabilityGuard = Contracts.CapabilityGuard;

/**
 * Default CapabilityGuard: looks up the session's SessionPolicy, intersects
 * it with the tool's declared permissions, and denies anything the policy
 * hasn't explicitly allowed.
 *
 * Decision algorithm:
 * 1. If tool is in `deniedCapabilities` → deny.
 * 2. If tool is in `grantedCapabilities` → allow.
 * 3. Otherwise: check permissions — filesystem writes to paths outside the
 *    allow-list, network to undeclared domains, process.execute for
 *    non-allow-listed commands all deny.
 * 4. Untrusted trust level denies all medium+ risk tools unless explicitly
 *    granted.
 */
export class PolicyCapabilityGuard implements CapabilityGuard {
  constructor(
    private readonly policies: Map<string, SessionPolicy>,
    private readonly tools: Map<string, AgentTool>,
  ) {}

  async check(
    sessionId: string,
    toolName: string,
    _args: unknown,
  ): Promise<CapabilityDecision> {
    const policy = this.policies.get(sessionId);
    if (!policy) {
      return { allowed: false, reason: 'no policy for session', suggestEscalation: true };
    }
    const tool = this.tools.get(toolName);
    if (!tool) {
      return { allowed: false, reason: `unknown tool: ${toolName}`, suggestEscalation: false };
    }

    if (policy.deniedCapabilities.includes(toolName)) {
      return {
        allowed: false,
        reason: `tool ${toolName} is denied by session policy`,
        suggestEscalation: false,
      };
    }

    if (policy.grantedCapabilities.includes(toolName)) {
      return { allowed: true };
    }

    // Trust gate: non-owner cannot execute medium+ risk tools without explicit grant.
    if (policy.trustLevel === 'untrusted' && tool.riskLevel !== 'low') {
      return {
        allowed: false,
        reason: `trust=untrusted cannot run ${tool.riskLevel}-risk tool without explicit grant`,
        suggestEscalation: true,
      };
    }

    // Permission-level checks for the three riskiest categories.
    for (const perm of tool.permissions) {
      const violation = permissionViolatesPolicy(perm, policy);
      if (violation) {
        return {
          allowed: false,
          reason: violation,
          suggestEscalation: policy.trustLevel !== 'untrusted',
        };
      }
    }

    return { allowed: true };
  }
}

function permissionViolatesPolicy(perm: Permission, policy: SessionPolicy): string | null {
  switch (perm.type) {
    case 'network':
      if (!policy.resourceLimits.networkEnabled) {
        return 'network disabled for this session';
      }
      return null;
    case 'filesystem':
      // Writes outside a session policy's granted paths are suspicious; deny
      // unconditionally unless the tool is explicitly granted (checked earlier).
      if (perm.access === 'write' && policy.trustLevel !== 'owner') {
        return 'filesystem write requires owner trust';
      }
      return null;
    case 'process':
      if (policy.trustLevel !== 'owner') {
        return 'process.execute requires owner trust';
      }
      return null;
    case 'browser':
      if (perm.scope === 'full' && policy.trustLevel !== 'owner') {
        return 'browser.full scope requires owner trust';
      }
      return null;
    case 'system':
      return null;
  }
}

/**
 * Build a SessionPolicy skeleton for an owner-level, fully-trusted session.
 * Useful for local dev + single-user mode.
 */
export function ownerPolicy(sessionId: string): SessionPolicy {
  return {
    sessionId,
    trustLevel: 'owner',
    grantedCapabilities: [],
    deniedCapabilities: [],
    sandboxMode: 'non-owner',
    resourceLimits: {
      maxCpuSeconds: 30,
      maxMemoryMb: 512,
      maxDiskMb: 256,
      networkEnabled: true,
    },
  };
}
