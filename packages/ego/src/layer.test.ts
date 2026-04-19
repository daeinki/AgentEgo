import { describe, it, expect } from 'vitest';
import { EgoLayer } from '../src/layer.js';
import type { StandardMessage, EgoFullConfig } from '@agent-platform/core';
import { generateId, generateTraceId, nowMs } from '@agent-platform/core';

function makeMessage(text: string): StandardMessage {
  return {
    id: generateId(),
    traceId: generateTraceId(),
    timestamp: nowMs(),
    channel: { type: 'webchat', id: 'test', metadata: {} },
    sender: { id: 'user-1', isOwner: true },
    conversation: { type: 'dm', id: 'conv-1' },
    content: { type: 'text', text },
  };
}

const testConfig: EgoFullConfig = {
  schemaVersion: '1.1.0',
  state: 'active',
  fallbackOnError: true,
  maxDecisionTimeMs: 3000,
  llm: null,
  thresholds: {
    minConfidenceToAct: 0.6,
    minRelevanceToEnrich: 0.3,
    minRelevanceToRedirect: 0.5,
    minRelevanceToDirectRespond: 0.8,
    maxCostUsdPerDecision: 0.05,
    maxCostUsdPerDay: 5.0,
  },
  fastPath: {
    passthroughIntents: ['greeting', 'command', 'reaction'],
    passthroughPatterns: ['^/(reset|status|new|compact)', '^(hi|hello|hey|안녕|ㅎㅇ)'],
    maxComplexityForPassthrough: 'simple',
    targetRatio: 0.75,
    measurementWindowDays: 7,
  },
  prompts: { systemPromptFile: '~/.agent/ego/system-prompt.md', responseFormat: 'json' },
  goals: {
    enabled: true,
    maxActiveGoals: 10,
    autoDetectCompletion: true,
    storePath: '~/.agent/ego/goals.json',
  },
  memory: {
    searchOnCognize: true,
    maxSearchResults: 5,
    searchTimeoutMs: 1500,
    onTimeout: 'empty_result',
  },
  persona: {
    enabled: true,
    storePath: '~/.agent/ego/persona.json',
    snapshot: {
      maxTokens: 250,
      topRelevantBehaviors: 3,
      topRelevantExpertise: 3,
      includeRelationshipContext: true,
    },
  },
  errorHandling: {
    onLlmInvalidJson: 'passthrough',
    onLlmTimeout: 'passthrough',
    onLlmOutOfRange: 'passthrough',
    onConsecutiveFailures: {
      threshold: 5,
      action: 'disable_llm_path',
      cooldownMinutes: 15,
    },
  },
  audit: {
    enabled: true,
    logLevel: 'decisions',
    storePath: '~/.agent/ego/audit.db',
    retentionDays: 90,
  },
};

const procParams = { sessionId: 'sess-test', agentId: 'agent-test' } as const;

describe('EgoLayer fast-path', () => {
  it('passes through greeting messages', async () => {
    const ego = new EgoLayer(testConfig);
    const decision = await ego.process(makeMessage('안녕'), procParams);
    expect(decision.action).toBe('passthrough');
  });

  it('passes through command messages', async () => {
    const ego = new EgoLayer(testConfig);
    const msg = makeMessage('/status');
    const decision = await ego.process(msg, procParams);
    expect(decision.action).toBe('passthrough');
  });

  it('passes through simple messages', async () => {
    const ego = new EgoLayer(testConfig);
    const decision = await ego.process(makeMessage('고마워'), procParams);
    expect(decision.action).toBe('passthrough');
  });

  it('passes through when no LLM is wired up, even for complex messages', async () => {
    const ego = new EgoLayer(testConfig);
    const decision = await ego.process(
      makeMessage('이 프로젝트의 아키텍처를 분석하고 개선점을 찾아줘. 특히 성능과 보안 측면에서 검토해줘.'),
      procParams,
    );
    expect(decision.action).toBe('passthrough');
  });

  // ─── ADR-010 후속: fastPath.enabled 게이트 ──────────────────────────────

  it('fastPath.enabled=false forces deep path even for greeting (no-LLM → deep_path_skipped)', async () => {
    const events: { event: string; payload?: unknown }[] = [];
    const traceLogger = {
      event: (e: { event: string; payload?: unknown }) => events.push({ event: e.event, payload: e.payload }),
      span: async <T>(_o: unknown, fn: () => Promise<T>) => fn(),
    };
    const configDeepOnly: EgoFullConfig = {
      ...testConfig,
      fastPath: { ...testConfig.fastPath, enabled: false },
    };
    const ego = new EgoLayer(configDeepOnly, { traceLogger });
    const decision = await ego.process(makeMessage('안녕'), procParams);

    // Greeting 은 원래 fast path 로 passthrough 됐겠지만 enabled=false 로 막힘.
    // LLM 미주입 상태라 deep_path_skipped → passthrough 로 내려가되,
    // 핵심은 'fast_exit' event 가 발행되지 않았다는 것.
    expect(decision.action).toBe('passthrough');
    const fastExitEvents = events.filter((e) => e.event === 'fast_exit');
    expect(fastExitEvents).toHaveLength(0);
  });

  it('EGO_FORCE_DEEP=1 env var overrides fastPath.enabled via applyEnvOverrides', async () => {
    const { applyEnvOverrides } = await import('./config.js');
    const configWithEnabled: EgoFullConfig = {
      ...testConfig,
      fastPath: { ...testConfig.fastPath, enabled: true },
    };
    const prev = process.env['EGO_FORCE_DEEP'];
    process.env['EGO_FORCE_DEEP'] = '1';
    try {
      const overridden = applyEnvOverrides(configWithEnabled);
      expect(overridden.fastPath.enabled).toBe(false);
    } finally {
      if (prev === undefined) delete process.env['EGO_FORCE_DEEP'];
      else process.env['EGO_FORCE_DEEP'] = prev;
    }
  });
});
