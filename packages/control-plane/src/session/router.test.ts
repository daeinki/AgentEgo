import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from './store.js';
import { RuleRouter } from './router.js';
import type { RoutingRule, StandardMessage } from '@agent-platform/core';
import { generateMessageId, generateTraceId, nowMs } from '@agent-platform/core';

function make(overrides: Partial<StandardMessage> = {}): StandardMessage {
  return {
    id: generateMessageId(),
    traceId: generateTraceId(),
    timestamp: nowMs(),
    channel: { type: 'webchat', id: 'w-1', metadata: {} },
    sender: { id: 'user-1', isOwner: true },
    conversation: { type: 'dm', id: 'c-1' },
    content: { type: 'text', text: 'hello' },
    ...overrides,
  };
}

describe('RuleRouter', () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'cp-router-'));
    store = new SessionStore(resolve(dir, 'sessions.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to defaultAgentId when no rules match', async () => {
    const router = new RuleRouter(store, { defaultAgentId: 'default' });
    const decision = await router.route(make());
    expect(decision.agentId).toBe('default');
    expect(decision.sessionId).toBeTruthy();
    expect(decision.priority).toBe(0);
  });

  it('matches a rule by channelType', async () => {
    const rule: RoutingRule = {
      id: 'r-ws',
      conditions: { channelType: ['webchat'] },
      target: { agentId: 'webchat-agent' },
      priority: 10,
    };
    const router = new RuleRouter(store, { defaultAgentId: 'default', rules: [rule] });
    const decision = await router.route(make());
    expect(decision.agentId).toBe('webchat-agent');
    expect(decision.priority).toBe(10);
  });

  it('matches by senderId', async () => {
    const rule: RoutingRule = {
      id: 'r-owner',
      conditions: { senderIds: ['user-1'] },
      target: { agentId: 'vip-agent' },
      priority: 5,
    };
    const router = new RuleRouter(store, { defaultAgentId: 'default', rules: [rule] });
    const decision = await router.route(make({ sender: { id: 'user-1', isOwner: true } }));
    expect(decision.agentId).toBe('vip-agent');
  });

  it('matches by regex content pattern against text', async () => {
    const rule: RoutingRule = {
      id: 'r-deploy',
      conditions: { contentPattern: '^/deploy' },
      target: { agentId: 'devops-agent' },
      priority: 8,
    };
    const router = new RuleRouter(store, { defaultAgentId: 'default', rules: [rule] });
    const decision = await router.route(
      make({ content: { type: 'command', name: 'deploy', args: ['prod'] } }),
    );
    expect(decision.agentId).toBe('devops-agent');
  });

  it('higher priority rules win', async () => {
    const low: RoutingRule = {
      id: 'low',
      conditions: { channelType: ['webchat'] },
      target: { agentId: 'low-agent' },
      priority: 1,
    };
    const high: RoutingRule = {
      id: 'high',
      conditions: { channelType: ['webchat'] },
      target: { agentId: 'high-agent' },
      priority: 10,
    };
    const router = new RuleRouter(store, { defaultAgentId: 'default', rules: [low, high] });
    const decision = await router.route(make());
    expect(decision.agentId).toBe('high-agent');
  });

  it('rules can be added and removed at runtime', async () => {
    const router = new RuleRouter(store, { defaultAgentId: 'default' });
    const rule: RoutingRule = {
      id: 'transient',
      conditions: { senderIds: ['user-1'] },
      target: { agentId: 'temp-agent' },
      priority: 5,
    };
    router.addRule(rule);
    expect((await router.route(make())).agentId).toBe('temp-agent');
    router.removeRule('transient');
    expect((await router.route(make())).agentId).toBe('default');
  });

  it('malformed regex does not crash the router', async () => {
    const rule: RoutingRule = {
      id: 'bad',
      conditions: { contentPattern: '[' },
      target: { agentId: 'shouldnt-match' },
      priority: 10,
    };
    const router = new RuleRouter(store, { defaultAgentId: 'default', rules: [rule] });
    const decision = await router.route(make());
    expect(decision.agentId).toBe('default');
  });

  it('rule with same id replaces previous (no duplicates)', async () => {
    const router = new RuleRouter(store, { defaultAgentId: 'default' });
    router.addRule({
      id: 'same',
      conditions: {},
      target: { agentId: 'v1' },
      priority: 5,
    });
    router.addRule({
      id: 'same',
      conditions: {},
      target: { agentId: 'v2' },
      priority: 5,
    });
    expect(router.listRules()).toHaveLength(1);
    expect((await router.route(make())).agentId).toBe('v2');
  });
});
