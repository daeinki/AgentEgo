import { describe, it, expect } from 'vitest';
import type {
  ChannelAdapter,
  SessionManager,
  Router,
  EgoLayer,
  EgoLlmAdapter,
  MemorySystem,
  PromptBuilder,
  ModelAdapter,
  CapabilityGuard,
  ToolSandbox,
  SkillRegistry,
  GoalStore,
  PersonaManager,
  AuditLog,
} from '../src/contracts/index.js';

/**
 * Compile-time contract tests. If these assignments compile, the contract
 * interfaces are stable. The assertions are just tripwires — the type
 * checker is the real test here.
 */
describe('Contract interfaces compile', () => {
  it('ChannelAdapter', () => {
    const shape: Pick<ChannelAdapter, 'initialize'> = {
      initialize: async () => {},
    };
    expect(typeof shape.initialize).toBe('function');
  });

  it('SessionManager', () => {
    const shape: Pick<SessionManager, 'getSession'> = {
      getSession: async () => null,
    };
    expect(typeof shape.getSession).toBe('function');
  });

  it('Router', () => {
    const shape: Pick<Router, 'addRule'> = { addRule: () => {} };
    expect(typeof shape.addRule).toBe('function');
  });

  it('EgoLayer', () => {
    const shape: Pick<EgoLayer, 'process'> = {
      process: async () => ({ action: 'passthrough' }),
    };
    expect(typeof shape.process).toBe('function');
  });

  it('EgoLlmAdapter', () => {
    const shape: Pick<EgoLlmAdapter, 'healthCheck'> = {
      healthCheck: async () => true,
    };
    expect(typeof shape.healthCheck).toBe('function');
  });

  it('MemorySystem', () => {
    const shape: Pick<MemorySystem, 'search'> = {
      search: async () => [],
    };
    expect(typeof shape.search).toBe('function');
  });

  it('PromptBuilder, ModelAdapter, CapabilityGuard, ToolSandbox, SkillRegistry, GoalStore, PersonaManager, AuditLog', () => {
    type AllContracts = [
      PromptBuilder,
      ModelAdapter,
      CapabilityGuard,
      ToolSandbox,
      SkillRegistry,
      GoalStore,
      PersonaManager,
      AuditLog,
    ];
    // Presence of the tuple type in the compiled output is enough.
    const _: AllContracts | undefined = undefined;
    expect(_).toBeUndefined();
  });
});
