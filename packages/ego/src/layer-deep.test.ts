import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { EgoLayer } from './layer.js';
import type {
  Contracts,
  EgoFullConfig,
  EgoThinkingResult,
  StandardMessage,
} from '@agent-platform/core';
import { generateMessageId, generateTraceId, nowMs } from '@agent-platform/core';
import { SqliteAuditLog } from './audit-log.js';

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
    prompts: {
      systemPromptFile: '/nonexistent.md',
      responseFormat: 'json',
    },
    goals: {
      enabled: false,
      maxActiveGoals: 10,
      autoDetectCompletion: false,
      storePath: '~/.agent/ego/goals.json',
    },
    memory: {
      searchOnCognize: false,
      maxSearchResults: 5,
      searchTimeoutMs: 1500,
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

class MockLlm implements Contracts.EgoLlmAdapter {
  public calls = 0;
  constructor(private readonly response: EgoThinkingResult | Error) {}
  async initialize(): Promise<void> {}
  async think(): Promise<EgoThinkingResult> {
    this.calls += 1;
    if (this.response instanceof Error) throw this.response;
    return this.response;
  }
  async healthCheck(): Promise<boolean> {
    return true;
  }
  getModelInfo() {
    return { provider: 'mock', model: 'mock', isFallback: false };
  }
}

const LONG_MSG =
  '이 프로젝트의 아키텍처를 분석하고 성능과 보안 측면에서 개선점을 찾은 뒤, ' +
  '각각에 대한 리팩토링 계획을 구체적으로 세워서 단계별로 실행 가능한 PR로 나눠줘.';

const passthroughThinking = (confidence = 0.8): EgoThinkingResult => ({
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
    situationSummary: 'routine request',
    opportunities: [],
    risks: [],
    egoRelevance: 0.3,
  },
  judgment: {
    action: 'passthrough',
    confidence,
    reason: 'nothing to enrich',
  },
});

const enrichThinking = (): EgoThinkingResult => ({
  perception: {
    requestType: 'tool_assisted',
    patterns: ['follow-up'],
    isFollowUp: true,
    requiresToolUse: true,
    estimatedComplexity: 'high',
  },
  cognition: {
    relevantMemoryIndices: [0],
    relatedGoalId: null,
    situationSummary: 'prior review context relevant',
    opportunities: ['cite prior review'],
    risks: [],
    egoRelevance: 0.8,
  },
  judgment: {
    action: 'enrich',
    confidence: 0.85,
    reason: 'follow-up benefits from prior context',
    enrichment: { addContext: 'prior review flagged JWT issue' },
  },
});

describe('EgoLayer deep path (integration)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'ego-layer-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns passthrough for complex messages when LLM is absent', async () => {
    const ego = new EgoLayer(baseConfig());
    const decision = await ego.process(make(LONG_MSG), {
      sessionId: 's1',
      agentId: 'a1',
    });
    expect(decision.action).toBe('passthrough');
  });

  it('calls the LLM for complex messages and honors passthrough judgment', async () => {
    const llm = new MockLlm(passthroughThinking());
    const ego = new EgoLayer(baseConfig(), { llm });
    const decision = await ego.process(make(LONG_MSG), {
      sessionId: 's1',
      agentId: 'a1',
    });
    expect(llm.calls).toBe(1);
    expect(decision.action).toBe('passthrough');
  });

  it('materializes enrich with enrichedMessage carrying ego metadata', async () => {
    const llm = new MockLlm(enrichThinking());
    const ego = new EgoLayer(baseConfig(), { llm });
    const decision = await ego.process(make(LONG_MSG), {
      sessionId: 's1',
      agentId: 'a1',
    });
    expect(decision.action).toBe('enrich');
    if (decision.action === 'enrich') {
      expect(decision.metadata.egoDecisionId).toMatch(/^ego-/);
      const meta = decision.enrichedMessage.channel.metadata as Record<string, unknown>;
      expect(meta._egoDecisionId).toBe(decision.metadata.egoDecisionId);
      expect(meta._egoEnrichment).toMatchObject({ addContext: expect.any(String) });
    }
  });

  it('overrides enrich to passthrough when confidence is below threshold (§5.6)', async () => {
    const llm = new MockLlm({
      ...enrichThinking(),
      judgment: {
        ...enrichThinking().judgment,
        confidence: 0.4,
      },
    });
    const ego = new EgoLayer(baseConfig(), { llm });
    const decision = await ego.process(make(LONG_MSG), {
      sessionId: 's1',
      agentId: 'a1',
    });
    expect(decision.action).toBe('passthrough');
  });

  it('state=passive never actually intervenes, even with enrich judgment', async () => {
    const llm = new MockLlm(enrichThinking());
    const ego = new EgoLayer(baseConfig({ state: 'passive' }), { llm });
    const decision = await ego.process(make(LONG_MSG), {
      sessionId: 's1',
      agentId: 'a1',
    });
    expect(decision.action).toBe('passthrough');
    expect(llm.calls).toBe(1); // still runs the deep path for metric collection
  });

  it('state=off skips the pipeline entirely', async () => {
    const llm = new MockLlm(enrichThinking());
    const ego = new EgoLayer(baseConfig({ state: 'off' }), { llm });
    const decision = await ego.process(make(LONG_MSG), {
      sessionId: 's1',
      agentId: 'a1',
    });
    expect(decision.action).toBe('passthrough');
    expect(llm.calls).toBe(0);
  });

  it('trips circuit breaker after repeated LLM failures', async () => {
    const llm = new MockLlm(new Error('boom'));
    const ego = new EgoLayer(baseConfig(), { llm });
    for (let i = 0; i < 3; i += 1) {
      await ego.process(make(LONG_MSG), { sessionId: 's1', agentId: 'a1' });
    }
    expect(ego.breakerSnapshot().state).toBe('open');
    // Subsequent message should skip deep path (circuit open)
    const llmCallsBefore = llm.calls;
    await ego.process(make(LONG_MSG), { sessionId: 's1', agentId: 'a1' });
    expect(llm.calls).toBe(llmCallsBefore);
  });

  it('E1 error trace payload carries tag + validation errors + candidate preview on schema mismatch', async () => {
    // LLM returns a candidate that is not a valid EgoThinkingResult — missing
    // `perception`. The layer's belt-and-suspenders validator should throw
    // `SchemaValidationError`, which is what operators saw on the user-
    // reported `llm_schema_mismatch` error. The trace event payload must be
    // rich enough to diagnose it.
    const llm: Contracts.EgoLlmAdapter = {
      async initialize() {},
      async healthCheck() { return true; },
      getModelInfo() { return { provider: 'mock', model: 'mock', isFallback: false }; },
      async think() {
        return {
          judgment: { action: 'passthrough', confidence: 0.5, reason: 'r' },
          // intentionally missing `perception` and `cognition`
        } as unknown as EgoThinkingResult;
      },
    };
    const events: Contracts.TraceEvent[] = [];
    const traceLogger: Contracts.TraceLogger = {
      event(ev) { events.push(ev); },
      async span(opts, fn) {
        this.event({
          traceId: opts.traceId,
          block: opts.block,
          event: opts.event ?? 'enter',
          timestamp: nowMs(),
        });
        return fn();
      },
    };
    const ego = new EgoLayer(baseConfig(), { llm, traceLogger });
    const decision = await ego.process(make(LONG_MSG), { sessionId: 's1', agentId: 'a1' });
    expect(decision.action).toBe('passthrough'); // fallbackOnError path
    const errEvent = events.find((e) => e.block === 'E1' && e.event === 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent!.error ?? '').toMatch(/llm_schema_mismatch/);
    const payload = errEvent!.payload as Record<string, unknown> | undefined;
    expect(payload).toBeDefined();
    expect(payload!['tag']).toBe('llm_schema_mismatch');
    // Validation errors are embedded, capped so the row stays small.
    expect(Array.isArray(payload!['validationErrors'])).toBe(true);
    const ves = payload!['validationErrors'] as Array<{ path: string; message: string }>;
    expect(ves.length).toBeGreaterThan(0);
    expect(ves[0]!.path).toBeTypeOf('string');
    expect(ves[0]!.message).toBeTypeOf('string');
    // The raw (invalid) candidate returned by the LLM is previewable.
    expect(payload!['candidatePreview']).toBeTypeOf('string');
    expect(payload!['candidatePreview'] as string).toContain('judgment');
  });

  it('E1 error trace payload tags pipeline timeouts as ego_timeout (not ego_runtime_error)', async () => {
    // Reproduces the "tag=ego_runtime_error error=timed out after Nms" mis-
    // classification: withTimeout throws TimeoutError, which the EgoLayer
    // must recognize and tag as `ego_timeout`. Pre-fix, the instanceof check
    // targeted the never-thrown EgoTimeoutError so every timeout fell through
    // to the generic runtime-error fallback.
    const llm: Contracts.EgoLlmAdapter = {
      async initialize() {},
      async healthCheck() { return true; },
      getModelInfo() { return { provider: 'mock', model: 'mock', isFallback: false }; },
      async think() {
        // Never resolves → withTimeout fires after maxDecisionTimeMs.
        return new Promise<EgoThinkingResult>(() => {
          /* hang */
        });
      },
    };
    const events: Contracts.TraceEvent[] = [];
    const traceLogger: Contracts.TraceLogger = {
      event(ev) { events.push(ev); },
      async span(opts, fn) {
        this.event({
          traceId: opts.traceId,
          block: opts.block,
          event: opts.event ?? 'enter',
          timestamp: nowMs(),
        });
        return fn();
      },
    };
    const ego = new EgoLayer(baseConfig({ maxDecisionTimeMs: 30 }), {
      llm,
      traceLogger,
    });
    const decision = await ego.process(make(LONG_MSG), { sessionId: 's1', agentId: 'a1' });
    expect(decision.action).toBe('passthrough'); // fallbackOnError degrades cleanly
    const errEvent = events.find((e) => e.block === 'E1' && e.event === 'error');
    expect(errEvent).toBeDefined();
    expect(errEvent!.error ?? '').toMatch(/timed out after/);
    const payload = errEvent!.payload as Record<string, unknown> | undefined;
    expect(payload).toBeDefined();
    expect(payload!['tag']).toBe('ego_timeout');
    // Timeout errors don't carry validation details or a candidate preview.
    expect(payload!['validationErrors']).toBeUndefined();
    expect(payload!['candidatePreview']).toBeUndefined();
  });

  it('audit log captures a record for each message', async () => {
    const audit = new SqliteAuditLog(resolve(dir, 'audit.db'));
    try {
      const llm = new MockLlm(passthroughThinking());
      const ego = new EgoLayer(baseConfig(), { llm, audit });
      await ego.process(make('안녕'), { sessionId: 's1', agentId: 'a1' });
      await ego.process(make(LONG_MSG), { sessionId: 's1', agentId: 'a1' });
      const rows = await audit.query({});
      expect(rows.length).toBeGreaterThanOrEqual(2);
      const actions = rows.map((r) => r.action);
      expect(actions).toContain('ego.fast_exit');
      expect(actions).toContain('ego.deep_path');
    } finally {
      await audit.close();
    }
  });
});
