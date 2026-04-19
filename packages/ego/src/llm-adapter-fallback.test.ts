import { describe, expect, it } from 'vitest';
import type { Contracts, EgoThinkingResult } from '@agent-platform/core';
import { FallbackEgoLlmAdapter } from './llm-adapter-fallback.js';

const sampleResult: EgoThinkingResult = {
  perception: {
    requestType: 'direct_answer',
    patterns: [],
    isFollowUp: false,
    requiresToolUse: false,
    estimatedComplexity: 'low',
  },
  cognition: {
    relevantMemoryIndices: [],
    relatedGoalId: null,
    situationSummary: 'test',
    opportunities: [],
    risks: [],
    egoRelevance: 0.2,
  },
  judgment: {
    action: 'passthrough',
    confidence: 0.9,
    reason: 'test',
  },
};

type EgoLlmAdapter = Contracts.EgoLlmAdapter;

class StubAdapter implements EgoLlmAdapter {
  public calls = 0;
  constructor(
    private readonly label: string,
    private readonly behavior: EgoThinkingResult | Error,
    private readonly healthy = true,
  ) {}
  async initialize(): Promise<void> {}
  async think(): Promise<EgoThinkingResult> {
    this.calls += 1;
    if (this.behavior instanceof Error) throw this.behavior;
    return this.behavior;
  }
  async healthCheck(): Promise<boolean> {
    return this.healthy;
  }
  getModelInfo() {
    return { provider: this.label, model: `${this.label}-model`, isFallback: false };
  }
}

describe('FallbackEgoLlmAdapter', () => {
  it('routes think() to the primary when primary succeeds', async () => {
    const primary = new StubAdapter('openai', sampleResult);
    const fallback = new StubAdapter('anthropic', sampleResult);
    const fb = new FallbackEgoLlmAdapter(primary, fallback);

    const r = await fb.think({
      systemPrompt: 's',
      context: { signal: {}, recentConversation: [], relevantMemories: [], activeGoals: [] },
      responseFormat: { type: 'json_object' },
    });

    expect(r).toEqual(sampleResult);
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(0);
    expect(fb.getModelInfo()).toEqual({
      provider: 'openai',
      model: 'openai-model',
      isFallback: false,
    });
  });

  it('falls back to secondary when primary throws, and flips isFallback:true', async () => {
    const primary = new StubAdapter('openai', new Error('boom'));
    const fallback = new StubAdapter('anthropic', sampleResult);
    const fb = new FallbackEgoLlmAdapter(primary, fallback);

    const r = await fb.think({
      systemPrompt: 's',
      context: { signal: {}, recentConversation: [], relevantMemories: [], activeGoals: [] },
      responseFormat: { type: 'json_object' },
    });

    expect(r).toEqual(sampleResult);
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(1);
    expect(fb.getModelInfo()).toEqual({
      provider: 'anthropic',
      model: 'anthropic-model',
      isFallback: true,
    });
  });

  it('recovers isFallback:false on the next successful primary call', async () => {
    const primary = new StubAdapter('openai', sampleResult);
    const fallback = new StubAdapter('anthropic', sampleResult);
    const fb = new FallbackEgoLlmAdapter(primary, fallback);

    // Force the first call to go through fallback by swapping primary behavior
    // via a thin wrapper.
    let primaryShouldFail = true;
    const flaky: EgoLlmAdapter = {
      initialize: async () => {},
      think: async () => {
        if (primaryShouldFail) throw new Error('flaky');
        return sampleResult;
      },
      healthCheck: async () => true,
      getModelInfo: () => ({ provider: 'openai', model: 'openai-model', isFallback: false }),
    };
    const fb2 = new FallbackEgoLlmAdapter(flaky, fallback);

    await fb2.think({
      systemPrompt: 's',
      context: { signal: {}, recentConversation: [], relevantMemories: [], activeGoals: [] },
      responseFormat: { type: 'json_object' },
    });
    expect(fb2.getModelInfo().isFallback).toBe(true);

    primaryShouldFail = false;
    await fb2.think({
      systemPrompt: 's',
      context: { signal: {}, recentConversation: [], relevantMemories: [], activeGoals: [] },
      responseFormat: { type: 'json_object' },
    });
    expect(fb2.getModelInfo().isFallback).toBe(false);
    // The stub's call count isn't changed by reusing the primary path here;
    // the key assertion is that isFallback recovered.
  });

  it('healthCheck reports healthy when either adapter is healthy', async () => {
    const sickPrimary = new StubAdapter('openai', sampleResult, false);
    const healthyFallback = new StubAdapter('anthropic', sampleResult, true);
    const fb = new FallbackEgoLlmAdapter(sickPrimary, healthyFallback);
    expect(await fb.healthCheck()).toBe(true);
  });

  it('healthCheck reports unhealthy only when both adapters are unhealthy', async () => {
    const sick1 = new StubAdapter('openai', sampleResult, false);
    const sick2 = new StubAdapter('anthropic', sampleResult, false);
    const fb = new FallbackEgoLlmAdapter(sick1, sick2);
    expect(await fb.healthCheck()).toBe(false);
  });

  it('both adapters throwing propagates the fallback error', async () => {
    const primary = new StubAdapter('openai', new Error('primary boom'));
    const fallback = new StubAdapter('anthropic', new Error('fallback boom'));
    const fb = new FallbackEgoLlmAdapter(primary, fallback);

    await expect(
      fb.think({
        systemPrompt: 's',
        context: { signal: {}, recentConversation: [], relevantMemories: [], activeGoals: [] },
        responseFormat: { type: 'json_object' },
      }),
    ).rejects.toThrow('fallback boom');
  });
});
