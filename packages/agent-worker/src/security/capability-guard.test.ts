import { describe, it, expect } from 'vitest';
import type { Permission, SessionPolicy } from '@agent-platform/core';
import { PolicyCapabilityGuard, ownerPolicy } from './capability-guard.js';
import type { AgentTool } from '../tools/types.js';

function makeTool(
  name: string,
  riskLevel: AgentTool['riskLevel'],
  permissions: Permission[] = [],
): AgentTool {
  return {
    name,
    description: 'test',
    riskLevel,
    permissions,
    inputSchema: { type: 'object' },
    async execute() {
      return { toolName: name, success: true, durationMs: 0 };
    },
  };
}

function withPolicy(
  sessionId: string,
  overrides: Partial<SessionPolicy> = {},
): SessionPolicy {
  return {
    ...ownerPolicy(sessionId),
    ...overrides,
  };
}

describe('PolicyCapabilityGuard', () => {
  it('denies when no policy is registered for the session', async () => {
    const guard = new PolicyCapabilityGuard(new Map(), new Map());
    const decision = await guard.check('missing', 'any', {});
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain('no policy');
    }
  });

  it('denies unknown tool', async () => {
    const policies = new Map([['s1', withPolicy('s1')]]);
    const guard = new PolicyCapabilityGuard(policies, new Map());
    const decision = await guard.check('s1', 'bogus', {});
    expect(decision.allowed).toBe(false);
  });

  it('explicit denied list wins', async () => {
    const tool = makeTool('fs.read', 'low');
    const policies = new Map([['s1', withPolicy('s1', { deniedCapabilities: ['fs.read'] })]]);
    const guard = new PolicyCapabilityGuard(policies, new Map([['fs.read', tool]]));
    const decision = await guard.check('s1', 'fs.read', {});
    expect(decision.allowed).toBe(false);
  });

  it('explicit grant shortcuts all permission checks', async () => {
    const tool = makeTool('process.bash', 'critical', [
      { type: 'process', access: 'execute', commands: ['ls'] },
    ]);
    const policies = new Map([
      ['s1', withPolicy('s1', { grantedCapabilities: ['process.bash'], trustLevel: 'untrusted' })],
    ]);
    const guard = new PolicyCapabilityGuard(policies, new Map([['process.bash', tool]]));
    const decision = await guard.check('s1', 'process.bash', {});
    expect(decision.allowed).toBe(true);
  });

  it('untrusted trust level denies medium+ risk tools without grant', async () => {
    const tool = makeTool('fs.write', 'medium');
    const policies = new Map([['s1', withPolicy('s1', { trustLevel: 'untrusted' })]]);
    const guard = new PolicyCapabilityGuard(policies, new Map([['fs.write', tool]]));
    const decision = await guard.check('s1', 'fs.write', {});
    expect(decision.allowed).toBe(false);
  });

  it('network permission denies when network is disabled', async () => {
    const tool = makeTool('web.fetch', 'medium', [
      { type: 'network', access: 'outbound', domains: ['example.com'] },
    ]);
    const policies = new Map([
      [
        's1',
        withPolicy('s1', {
          resourceLimits: {
            maxCpuSeconds: 30,
            maxMemoryMb: 512,
            maxDiskMb: 256,
            networkEnabled: false,
          },
        }),
      ],
    ]);
    const guard = new PolicyCapabilityGuard(policies, new Map([['web.fetch', tool]]));
    const decision = await guard.check('s1', 'web.fetch', {});
    expect(decision.allowed).toBe(false);
  });

  it('process.execute requires owner trust', async () => {
    const tool = makeTool('bash', 'critical', [
      { type: 'process', access: 'execute', commands: ['ls'] },
    ]);
    const policies = new Map([['s1', withPolicy('s1', { trustLevel: 'trusted' })]]);
    const guard = new PolicyCapabilityGuard(policies, new Map([['bash', tool]]));
    const decision = await guard.check('s1', 'bash', {});
    expect(decision.allowed).toBe(false);
  });

  it('owner policy allows low-risk tools by default', async () => {
    const tool = makeTool('fs.read', 'low', [
      { type: 'filesystem', access: 'read', paths: ['/tmp'] },
    ]);
    const policies = new Map([['s1', withPolicy('s1')]]);
    const guard = new PolicyCapabilityGuard(policies, new Map([['fs.read', tool]]));
    const decision = await guard.check('s1', 'fs.read', {});
    expect(decision.allowed).toBe(true);
  });
});
