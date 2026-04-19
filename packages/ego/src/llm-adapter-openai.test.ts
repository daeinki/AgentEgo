import { describe, expect, it } from 'vitest';
import type { EgoLlmConfig } from '@agent-platform/core';
import { SchemaValidationError } from '@agent-platform/core';
import { OpenAiEgoLlmAdapter, estimateOpenAiCost } from './llm-adapter-openai.js';
import { buildUserPrompt, parseOrThrow } from './llm-adapter-shared.js';

const baseConfig: EgoLlmConfig = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  apiKey: 'sk-test',
  temperature: 0.1,
  maxTokens: 1024,
};

describe('OpenAiEgoLlmAdapter', () => {
  it('initialize() + getModelInfo() reports provider/model/isFallback:false', async () => {
    const adapter = new OpenAiEgoLlmAdapter();
    await adapter.initialize({ ...baseConfig });
    const info = adapter.getModelInfo();
    expect(info).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
      isFallback: false,
    });
  });

  it('resolveEnvVars runs on apiKey during initialize', async () => {
    process.env['_EGO_OPENAI_TEST_KEY'] = 'sk-from-env';
    try {
      const adapter = new OpenAiEgoLlmAdapter();
      await adapter.initialize({
        ...baseConfig,
        apiKey: '${_EGO_OPENAI_TEST_KEY}',
      });
      // If resolveEnvVars succeeded, initialize didn't throw — contract OK.
      expect(adapter.getModelInfo().provider).toBe('openai');
    } finally {
      delete process.env['_EGO_OPENAI_TEST_KEY'];
    }
  });

  it('initialize throws when apiKey references an unset env var', async () => {
    const adapter = new OpenAiEgoLlmAdapter();
    await expect(
      adapter.initialize({ ...baseConfig, apiKey: '${_MISSING_EGO_TEST_VAR}' }),
    ).rejects.toThrow(/_MISSING_EGO_TEST_VAR/);
  });

  // ─── GPT-5 / o1-o4 reasoning-model parameter adaptation ────────────────
  // Reasoning models require `max_completion_tokens` instead of `max_tokens`
  // and reject custom temperature / top_p. We monkey-patch
  // chat.completions.create to capture the request body sent.

  it('sends max_completion_tokens (not max_tokens) for gpt-5.x models', async () => {
    const adapter = new OpenAiEgoLlmAdapter();
    await adapter.initialize({ ...baseConfig, model: 'gpt-5.4', temperature: 0.1 });
    const captured: Record<string, unknown>[] = [];
    // Monkey-patch the private OpenAI client with a minimal stub.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      chat: {
        completions: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          create: async (req: any) => {
            captured.push(req);
            return { choices: [{ message: { content: '{"perception":{"requestType":"direct_answer","patterns":[],"isFollowUp":false,"requiresToolUse":false,"estimatedComplexity":"low"},"cognition":{"relevantMemoryIndices":[],"relatedGoalId":null,"situationSummary":"s","opportunities":[],"risks":[],"egoRelevance":0.5},"judgment":{"action":"passthrough","confidence":0.8,"reason":"r"}}' } }] };
          },
        },
      },
    };
    await adapter.think({
      systemPrompt: 'sys',
      context: { signal: { rawText: 'hi', traceId: 't', source: { channel: 'webchat', senderId: 's', timestampMs: 0 }, intent: { primary: 'conversation' }, urgency: 'normal', complexity: 'trivial', sensitivity: 'normal', entities: [] } as never, recentConversation: [], relevantMemories: [], activeGoals: [] },
      responseFormat: { type: 'json_object' },
    });
    expect(captured).toHaveLength(1);
    const body = captured[0]!;
    expect(body['max_completion_tokens']).toBe(1024);
    expect(body['max_tokens']).toBeUndefined();
    // reasoning model → temperature stripped
    expect(body['temperature']).toBeUndefined();
  });

  it('keeps max_tokens + temperature for legacy gpt-4o-mini', async () => {
    const adapter = new OpenAiEgoLlmAdapter();
    await adapter.initialize({ ...baseConfig });
    const captured: Record<string, unknown>[] = [];
    // Monkey-patch the private OpenAI client with a minimal stub.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      chat: {
        completions: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          create: async (req: any) => {
            captured.push(req);
            return { choices: [{ message: { content: '{"perception":{"requestType":"direct_answer","patterns":[],"isFollowUp":false,"requiresToolUse":false,"estimatedComplexity":"low"},"cognition":{"relevantMemoryIndices":[],"relatedGoalId":null,"situationSummary":"s","opportunities":[],"risks":[],"egoRelevance":0.5},"judgment":{"action":"passthrough","confidence":0.8,"reason":"r"}}' } }] };
          },
        },
      },
    };
    await adapter.think({
      systemPrompt: 'sys',
      context: { signal: { rawText: 'hi', traceId: 't', source: { channel: 'webchat', senderId: 's', timestampMs: 0 }, intent: { primary: 'conversation' }, urgency: 'normal', complexity: 'trivial', sensitivity: 'normal', entities: [] } as never, recentConversation: [], relevantMemories: [], activeGoals: [] },
      responseFormat: { type: 'json_object' },
    });
    const body = captured[0]!;
    expect(body['max_tokens']).toBe(1024);
    expect(body['max_completion_tokens']).toBeUndefined();
    expect(body['temperature']).toBe(0.1);
  });
});

describe('llm-adapter-shared', () => {
  it('buildUserPrompt embeds the JSON Schema + context + action rules', () => {
    const prompt = buildUserPrompt({
      systemPrompt: 'ignored',
      context: {
        signal: { traceId: 't', intent: { primary: 'chat' } },
        recentConversation: [],
        relevantMemories: [],
        activeGoals: [],
      },
      responseFormat: { type: 'json_object' },
    });
    // Schema block is present — properties of EgoThinkingResult appear.
    expect(prompt).toContain('SCHEMA');
    expect(prompt).toContain('perception');
    expect(prompt).toContain('cognition');
    expect(prompt).toContain('judgment');
    // Context block carries the caller's signal payload.
    expect(prompt).toContain('CONTEXT');
    expect(prompt).toContain('"intent"');
    // Action-contingent field rules — prevents `llm_inconsistent_action`.
    expect(prompt).toContain('action="enrich"');
    expect(prompt).toContain('action="redirect"');
    expect(prompt).toContain('action="direct_response"');
  });

  it('parseOrThrow rejects null input with tag=llm_invalid_json', () => {
    try {
      parseOrThrow(null);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaValidationError);
      expect((err as SchemaValidationError).tag).toBe('llm_invalid_json');
    }
  });

  it('parseOrThrow rejects invalid JSON with tag=llm_invalid_json', () => {
    try {
      parseOrThrow('not-json');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaValidationError);
      expect((err as SchemaValidationError).tag).toBe('llm_invalid_json');
    }
  });

  it('parseOrThrow rejects JSON missing required fields and surfaces the parsed candidate', () => {
    try {
      parseOrThrow('{"foo": 1}');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaValidationError);
      const sve = err as SchemaValidationError;
      // Classifier picks llm_schema_mismatch when no more-specific tag fits.
      expect(sve.tag).toBe('llm_schema_mismatch');
      expect(sve.candidate).toEqual({ foo: 1 });
      expect(Array.isArray(sve.validationErrors)).toBe(true);
      expect(sve.validationErrors.length).toBeGreaterThan(0);
    }
  });

  it('parseOrThrow carries the inconsistent_action tag when judgment has enrich but no enrichment', () => {
    const bad = JSON.stringify({
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
        situationSummary: '',
        opportunities: [],
        risks: [],
        egoRelevance: 0.5,
      },
      judgment: { action: 'enrich', confidence: 0.8, reason: 'x' },
    });
    try {
      parseOrThrow(bad);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as SchemaValidationError).tag).toBe('llm_inconsistent_action');
    }
  });
});

describe('estimateOpenAiCost', () => {
  it('returns a positive USD cost for a known model', () => {
    const c = estimateOpenAiCost('gpt-4o-mini', 1_000_000, 1_000_000);
    // 0.15 + 0.60 = 0.75
    expect(c).toBeCloseTo(0.75, 5);
  });

  it('returns 0 for an unknown model', () => {
    expect(estimateOpenAiCost('unknown-model', 1_000_000, 1_000_000)).toBe(0);
  });
});
