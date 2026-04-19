import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PalaceMemorySystem, HashEmbedder } from '@agent-platform/memory';
import type {
  Contracts,
  EgoFullConfig,
  EgoThinkingResult,
  StandardMessage,
} from '@agent-platform/core';
import { generateMessageId, generateTraceId, nowMs } from '@agent-platform/core';
import { EgoLayer } from './layer.js';
import { gatherContext } from './context-gatherer.js';
import { intake } from './signal.js';
import { normalize } from './normalize.js';

function baseConfig(overrides: Partial<EgoFullConfig> = {}): EgoFullConfig {
  return {
    schemaVersion: '1.1.0',
    state: 'active',
    fallbackOnError: true,
    maxDecisionTimeMs: 5000,
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
      passthroughPatterns: ['^/(reset|status)'],
      maxComplexityForPassthrough: 'simple',
      targetRatio: 0.75,
      measurementWindowDays: 7,
    },
    prompts: { systemPromptFile: '/nonexistent.md', responseFormat: 'json' },
    goals: { enabled: false, maxActiveGoals: 10, autoDetectCompletion: false, storePath: '~/.agent/ego/goals.json' },
    memory: {
      searchOnCognize: true,
      maxSearchResults: 5,
      searchTimeoutMs: 2000,
      onTimeout: 'empty_result',
    },
    persona: {
      enabled: false,
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
      onConsecutiveFailures: { threshold: 3, action: 'disable_llm_path', cooldownMinutes: 10 },
    },
    audit: {
      enabled: true,
      logLevel: 'decisions',
      storePath: '~/.agent/ego/audit.db',
      retentionDays: 90,
    },
    ...overrides,
  };
}

function make(text: string): StandardMessage {
  return {
    id: generateMessageId(),
    traceId: generateTraceId(),
    timestamp: nowMs(),
    channel: { type: 'webchat', id: 'w-1', metadata: {} },
    sender: { id: 'user-1', isOwner: true },
    conversation: { type: 'dm', id: 'c-1' },
    content: { type: 'text', text },
  };
}

/**
 * Mock LLM that inspects relevantMemories in its context and returns an
 * enrich decision *only* if prior memory was surfaced. This lets us verify
 * the whole chain from ingest → search → context-gather → LLM input.
 */
class MemoryAwareMockLlm implements Contracts.EgoLlmAdapter {
  public lastMemoriesSeen: string[] = [];
  async initialize(): Promise<void> {}
  async think(req: Contracts.EgoThinkingRequest): Promise<EgoThinkingResult> {
    const memories = req.context.relevantMemories;
    this.lastMemoriesSeen = memories;
    if (memories.length === 0) {
      return passthrough();
    }
    return enrich(memories[0]!);
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
  getModelInfo() {
    return { provider: 'mock', model: 'mock', isFallback: false };
  }
}

function passthrough(): EgoThinkingResult {
  return {
    perception: {
      requestType: 'direct_answer',
      patterns: [],
      isFollowUp: false,
      requiresToolUse: false,
      estimatedComplexity: 'medium',
    },
    cognition: {
      relevantMemoryIndices: [],
      relatedGoalId: null,
      situationSummary: 'no prior context',
      opportunities: [],
      risks: [],
      egoRelevance: 0.2,
    },
    judgment: {
      action: 'passthrough',
      confidence: 0.7,
      reason: 'no memory found',
    },
  };
}

function enrich(memorySnippet: string): EgoThinkingResult {
  return {
    perception: {
      requestType: 'direct_answer',
      patterns: ['follow-up'],
      isFollowUp: true,
      requiresToolUse: false,
      estimatedComplexity: 'medium',
    },
    cognition: {
      relevantMemoryIndices: [0],
      relatedGoalId: null,
      situationSummary: 'prior memory surfaced',
      opportunities: ['cite prior'],
      risks: [],
      egoRelevance: 0.85,
    },
    judgment: {
      action: 'enrich',
      confidence: 0.85,
      reason: 'inject memory context',
      enrichment: {
        addContext: `Prior memory: ${memorySnippet.slice(0, 80)}`,
      },
    },
  };
}

describe('EGO ↔ Memory integration', () => {
  let dir: string;
  let memory: PalaceMemorySystem;

  beforeEach(async () => {
    dir = mkdtempSync(resolve(tmpdir(), 'ego-mem-'));
    memory = new PalaceMemorySystem({ root: dir, embedder: new HashEmbedder(128) });
    await memory.init();
  });

  afterEach(async () => {
    await memory.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('gatherContext pulls memory results when searchOnCognize is true', async () => {
    await memory.ingest({
      sessionId: 'sess-1',
      userMessage: 'auth 모듈 리뷰 부탁해',
      agentResponse: 'JWT 검증 누락(auth.ts:42)을 발견했어요. 수정 필요.',
      timestamp: Date.now(),
    });

    const signal = normalize(intake(make('auth 모듈 PR 올려도 돼?')));
    const ctx = await gatherContext({
      signal,
      sessionId: 'sess-next',
      agentId: 'agent-1',
      config: baseConfig(),
      memory,
      traceId: 'trc-x',
    });

    expect(ctx.memoryTimedOut).toBe(false);
    expect(ctx.memories.length).toBeGreaterThan(0);
    expect(ctx.memories[0]?.content.toLowerCase()).toContain('auth');
  });

  it('end-to-end: ingested memory reaches the EGO LLM as relevantMemories and drives enrich', async () => {
    await memory.ingest({
      sessionId: 'sess-1',
      userMessage: 'auth 모듈 리뷰 부탁해',
      agentResponse: 'JWT 검증 누락(auth.ts:42)을 지적함. 수정 후 테스트 추가 필요.',
      timestamp: Date.now(),
    });

    const llm = new MemoryAwareMockLlm();
    const ego = new EgoLayer(baseConfig(), { llm, memory });

    const decision = await ego.process(
      make(
        '어제 리뷰한 auth 모듈 관련해서, 지적받은 JWT 검증 이슈가 해결됐는지 ' +
          '확인하고 PR 올려도 되는지 판단해줘. 관련 테스트도 추가가 필요한지 봐줘.',
      ),
      {
        sessionId: 'sess-next',
        agentId: 'agent-1',
      },
    );

    expect(llm.lastMemoriesSeen.length).toBeGreaterThan(0);
    expect(decision.action).toBe('enrich');
    if (decision.action === 'enrich') {
      const meta = decision.enrichedMessage.channel.metadata as Record<string, unknown>;
      const enrichment = meta._egoEnrichment as { addContext?: string };
      expect(enrichment.addContext).toContain('auth');
    }
  });

  it('with empty memory, EGO falls back to passthrough', async () => {
    const llm = new MemoryAwareMockLlm();
    const ego = new EgoLayer(baseConfig(), { llm, memory });

    const decision = await ego.process(
      make(
        '아직 ingest 된 기억이 없는 상태에서, 이 프로젝트 전반의 auth 모듈 ' +
          'PR 상태와 관련 이슈를 분석하고 우선순위를 세워줘.',
      ),
      {
        sessionId: 'sess-next',
        agentId: 'agent-1',
      },
    );

    expect(llm.lastMemoriesSeen).toEqual([]);
    expect(decision.action).toBe('passthrough');
  });

  it('respects memory.searchOnCognize=false (skips memory lookup entirely)', async () => {
    await memory.ingest({
      sessionId: 'sess-1',
      userMessage: 'auth',
      agentResponse: 'auth context 존재',
      timestamp: Date.now(),
    });

    const config = baseConfig({
      memory: {
        searchOnCognize: false,
        maxSearchResults: 5,
        searchTimeoutMs: 2000,
        onTimeout: 'empty_result',
      },
    });

    const llm = new MemoryAwareMockLlm();
    const ego = new EgoLayer(config, { llm, memory });

    await ego.process(make('이 프로젝트 아키텍처 분석하고 개선점 찾아줘 상세하게 각 단계별로'), {
      sessionId: 'sess-next',
      agentId: 'agent-1',
    });

    expect(llm.lastMemoriesSeen).toEqual([]);
  });
});
