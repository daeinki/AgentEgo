import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '@agent-platform/control-plane';
import { PalaceMemorySystem, HashEmbedder } from '@agent-platform/memory';
import type { Contracts, Phase, PhaseEventDetail, StandardMessage } from '@agent-platform/core';
import { generateMessageId, generateTraceId, nowMs } from '@agent-platform/core';
import { AgentRunner } from './agent-runner.js';
import type {
  CompletionRequest,
  ModelAdapter,
  StreamChunk,
} from '../model/types.js';

class ScriptedModelAdapter implements ModelAdapter {
  public lastRequest: CompletionRequest | undefined;

  constructor(private readonly script: string[]) {}

  async *stream(req: CompletionRequest): AsyncIterable<StreamChunk> {
    this.lastRequest = req;
    for (const piece of this.script) {
      yield { type: 'text_delta', text: piece };
    }
    yield { type: 'usage', inputTokens: 10, outputTokens: 5, cost: 0.0001 };
    yield { type: 'done', stopReason: 'end_turn' };
  }

  getModelInfo() {
    return { provider: 'mock', model: 'mock-1' };
  }
}

function makeMsg(
  text: string,
  metadata: Record<string, unknown> = {},
): StandardMessage {
  return {
    id: generateMessageId(),
    traceId: generateTraceId(),
    timestamp: nowMs(),
    channel: { type: 'webchat', id: 'w-1', metadata },
    sender: { id: 'user-1', isOwner: true },
    conversation: { type: 'dm', id: 'c-1' },
    content: { type: 'text', text },
  };
}

describe('AgentRunner (extended)', () => {
  let dir: string;
  let sessionStore: SessionStore;
  let memory: PalaceMemorySystem;

  beforeEach(async () => {
    dir = mkdtempSync(resolve(tmpdir(), 'agent-runner-'));
    sessionStore = new SessionStore(resolve(dir, 'sessions.db'));
    memory = new PalaceMemorySystem({
      root: resolve(dir, 'memory'),
      embedder: new HashEmbedder(128),
    });
    await memory.init();
  });

  afterEach(async () => {
    await memory.close();
    sessionStore.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs a turn, writes session events, does not ingest when no memory dep is given', async () => {
    const session = sessionStore.createSession({
      agentId: 'default',
      channelType: 'webchat',
      conversationId: 'c-1',
    });
    const model = new ScriptedModelAdapter(['hi ', 'there']);
    const runner = new AgentRunner(sessionStore, model, { agentId: 'default' });

    const result = await runner.processTurn(session.id, makeMsg('ping'));

    expect(result.responseText).toBe('hi there');
    expect(result.ingested).toBe(false);
    // ADR-010: loadHistory 기본값은 reasoning_step 을 제외한다.
    const history = sessionStore.loadHistory(session.id);
    expect(history).toHaveLength(2);
    expect(history[0]?.eventType).toBe('user_message');
    expect(history[1]?.eventType).toBe('agent_response');
    // Raw store 에는 reasoning_step 도 함께 기록됨 (관측 전용).
    const raw = sessionStore.getEvents(session.id);
    const reasoningSteps = raw.filter((e) => e.eventType === 'reasoning_step');
    expect(reasoningSteps.length).toBeGreaterThan(0);
  });

  it('ingests the turn into memory when memory dep is provided', async () => {
    const session = sessionStore.createSession({
      agentId: 'default',
      channelType: 'webchat',
      conversationId: 'c-2',
    });
    const model = new ScriptedModelAdapter([
      'TypeScript에서 배포 파이프라인을 구성하려면 GitHub Actions 와 Docker 를 쓰세요.',
    ]);
    const runner = new AgentRunner(
      sessionStore,
      model,
      { agentId: 'default' },
      { memory },
    );

    const result = await runner.processTurn(
      session.id,
      makeMsg('TypeScript 배포 파이프라인 구성해줘'),
    );

    expect(result.ingested).toBe(true);
    const counts = memory.countByWing();
    const total = counts.work + counts.knowledge + counts.personal + counts.interactions;
    expect(total).toBeGreaterThan(0);
  });

  it('surfaces memory via subsequent search after ingest', async () => {
    const session = sessionStore.createSession({
      agentId: 'default',
      channelType: 'webchat',
      conversationId: 'c-3',
    });
    const model = new ScriptedModelAdapter([
      'auth.ts의 JWT 검증에서 exp claim 체크가 빠졌습니다. 수정 필요.',
    ]);
    const runner = new AgentRunner(
      sessionStore,
      model,
      { agentId: 'default' },
      { memory },
    );
    await runner.processTurn(session.id, makeMsg('auth 모듈 리뷰 결과 알려줘'));

    const hits = await memory.search('JWT 검증', {
      sessionId: session.id,
      agentId: 'default',
      recentTopics: [],
      maxResults: 3,
      minRelevanceScore: 0,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.content.toLowerCase()).toContain('jwt');
  });

  it('reads EGO enrichment from channel.metadata and injects into system prompt', async () => {
    const session = sessionStore.createSession({
      agentId: 'default',
      channelType: 'webchat',
      conversationId: 'c-4',
    });
    const model = new ScriptedModelAdapter(['ok']);
    const runner = new AgentRunner(sessionStore, model, { agentId: 'default' });

    await runner.processTurn(
      session.id,
      makeMsg('auth PR 올려도 돼?', {
        _egoEnrichment: {
          addContext: 'prior review flagged JWT exp check missing',
          addMemories: ['auth.ts:42 JWT 검증 누락'],
          addInstructions: 'cite the JWT issue explicitly',
        },
        _egoDecisionId: 'ego-test-1',
      }),
    );

    expect(model.lastRequest).toBeDefined();
    const sysPrompt = model.lastRequest!.systemPrompt;
    expect(sysPrompt).toContain('EGO 맥락');
    expect(sysPrompt).toContain('JWT');
    expect(sysPrompt).toContain('관련 기억');
    expect(sysPrompt).toContain('EGO 지시');
  });

  it('omits enrichment section entirely when metadata has no _egoEnrichment', async () => {
    const session = sessionStore.createSession({
      agentId: 'default',
      channelType: 'webchat',
      conversationId: 'c-5',
    });
    const model = new ScriptedModelAdapter(['ok']);
    const runner = new AgentRunner(sessionStore, model, { agentId: 'default' });
    await runner.processTurn(session.id, makeMsg('ping'));
    const sysPrompt = model.lastRequest!.systemPrompt;
    expect(sysPrompt).not.toContain('EGO 맥락');
  });

  it('extracts suggestTools from enrichment and injects the EGO 추천 도구 block (U10 Phase 2)', async () => {
    const session = sessionStore.createSession({
      agentId: 'default',
      channelType: 'webchat',
      conversationId: 'c-suggest',
    });
    const model = new ScriptedModelAdapter(['ok']);
    const runner = new AgentRunner(sessionStore, model, { agentId: 'default' });

    await runner.processTurn(
      session.id,
      makeMsg('파일 하나만 읽어줘', {
        _egoEnrichment: {
          addContext: 'user wants a file summary',
          suggestTools: ['fs.read', 'web.fetch', 123 /* ignored: non-string */],
        },
      }),
    );

    const sysPrompt = model.lastRequest!.systemPrompt;
    expect(sysPrompt).toContain('## EGO 추천 도구');
    expect(sysPrompt).toContain('fs.read');
    expect(sysPrompt).toContain('web.fetch');
    // non-string entries must not leak into the prompt
    expect(sysPrompt).not.toContain('123');
  });

  it('extracts _egoPerception from channel.metadata and forwards it to the reasoner', async () => {
    const session = sessionStore.createSession({
      agentId: 'default',
      channelType: 'webchat',
      conversationId: 'c-perc',
    });

    const captured: Contracts.ReasoningContext[] = [];
    const stubReasoner: Contracts.Reasoner = {
      mode: 'react',
      async *run(ctx) {
        captured.push(ctx);
        yield { kind: 'delta', text: 'ok' };
        yield { kind: 'final', text: 'ok', state: { mode: 'react', egoDecisionId: ctx.egoDecisionId, trace: [], budget: { maxSteps: 8, maxToolCalls: 16, spent: { steps: 0, toolCalls: 0 } }, terminationReason: 'final_answer' } };
      },
    };
    const model = new ScriptedModelAdapter(['unused']);
    const runner = new AgentRunner(
      sessionStore,
      model,
      { agentId: 'default' },
      { reasoner: stubReasoner },
    );

    await runner.processTurn(
      session.id,
      makeMsg('plan it', {
        _egoPerception: {
          requestType: 'workflow_execution',
          patterns: ['multi'],
          isFollowUp: false,
          requiresToolUse: true,
          estimatedComplexity: 'high',
        },
      }),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.egoPerception?.estimatedComplexity).toBe('high');
    expect(captured[0]?.egoPerception?.requestType).toBe('workflow_execution');
  });

  it('omits egoPerception when metadata payload is malformed', async () => {
    const session = sessionStore.createSession({
      agentId: 'default',
      channelType: 'webchat',
      conversationId: 'c-bad',
    });

    const captured: Contracts.ReasoningContext[] = [];
    const stubReasoner: Contracts.Reasoner = {
      mode: 'react',
      async *run(ctx) {
        captured.push(ctx);
        yield { kind: 'final', text: '', state: { mode: 'react', egoDecisionId: null, trace: [], budget: { maxSteps: 8, maxToolCalls: 16, spent: { steps: 0, toolCalls: 0 } }, terminationReason: 'final_answer' } };
      },
    };
    const runner = new AgentRunner(
      sessionStore,
      new ScriptedModelAdapter(['unused']),
      { agentId: 'default' },
      { reasoner: stubReasoner },
    );

    await runner.processTurn(
      session.id,
      makeMsg('hi', { _egoPerception: { requestType: 'workflow_execution' } /* incomplete */ }),
    );

    expect(captured).toHaveLength(1);
    expect(captured[0]?.egoPerception).toBeUndefined();
  });

  it('ingest failure does not fail the turn', async () => {
    const session = sessionStore.createSession({
      agentId: 'default',
      channelType: 'webchat',
      conversationId: 'c-6',
    });
    const brokenMemory = {
      search: async () => [],
      ingest: async () => {
        throw new Error('disk full');
      },
      classify: async () => ({ wing: 'knowledge', confidence: 0.2 }),
      compact: async () => ({ wing: 'x', archivedChunks: 0, summaryChunkId: '' }),
    };
    const model = new ScriptedModelAdapter(['response text']);
    const runner = new AgentRunner(
      sessionStore,
      model,
      { agentId: 'default' },
      { memory: brokenMemory },
    );
    const result = await runner.processTurn(session.id, makeMsg('ping'));
    expect(result.responseText).toBe('response text');
    expect(result.ingested).toBe(false);
  });

  // ADR-010: TUI Phase Event stream integration.
  describe('phase emission (ADR-010)', () => {
    it('emits reasoning_route then streaming_response for a text-only turn', async () => {
      const session = sessionStore.createSession({
        agentId: 'default',
        channelType: 'webchat',
        conversationId: 'c-phase-1',
      });
      const model = new ScriptedModelAdapter(['hello ', 'world']);
      const runner = new AgentRunner(sessionStore, model, { agentId: 'default' });

      const emitted: Array<{ phase: Phase; detail?: PhaseEventDetail }> = [];
      await runner.processTurn(session.id, makeMsg('ping'), undefined, (phase, detail) => {
        emitted.push(detail ? { phase, detail } : { phase });
      });

      const phases = emitted.map((e) => e.phase);
      expect(phases).toContain('reasoning_route');
      expect(phases).toContain('streaming_response');
      // streaming_response must appear after reasoning_route.
      expect(phases.indexOf('streaming_response')).toBeGreaterThan(
        phases.indexOf('reasoning_route'),
      );
      // No terminal phases here — those are owned by the gateway layer.
      expect(phases).not.toContain('complete');
      expect(phases).not.toContain('error');
    });

    it('emits streaming_response at most once even with many text chunks', async () => {
      const session = sessionStore.createSession({
        agentId: 'default',
        channelType: 'webchat',
        conversationId: 'c-phase-2',
      });
      const model = new ScriptedModelAdapter(['a', 'b', 'c', 'd', 'e']);
      const runner = new AgentRunner(sessionStore, model, { agentId: 'default' });

      const emitted: Phase[] = [];
      await runner.processTurn(session.id, makeMsg('hi'), undefined, (phase) => {
        emitted.push(phase);
      });

      const streamingCount = emitted.filter((p) => p === 'streaming_response').length;
      expect(streamingCount).toBe(1);
    });

    it('reports reasoningMode on the reasoning_route phase', async () => {
      const session = sessionStore.createSession({
        agentId: 'default',
        channelType: 'webchat',
        conversationId: 'c-phase-3',
      });
      const model = new ScriptedModelAdapter(['ok']);
      const runner = new AgentRunner(sessionStore, model, { agentId: 'default' });

      const events: Array<{ phase: Phase; detail?: PhaseEventDetail }> = [];
      await runner.processTurn(session.id, makeMsg('hi'), undefined, (phase, detail) => {
        events.push(detail ? { phase, detail } : { phase });
      });

      const route = events.find((e) => e.phase === 'reasoning_route');
      expect(route?.detail?.reasoningMode).toBe('react');
    });

    it('turn completes without phases if no onPhase callback is supplied', async () => {
      const session = sessionStore.createSession({
        agentId: 'default',
        channelType: 'webchat',
        conversationId: 'c-phase-4',
      });
      const model = new ScriptedModelAdapter(['ok']);
      const runner = new AgentRunner(sessionStore, model, { agentId: 'default' });

      // No 4th argument — backwards compatibility.
      const result = await runner.processTurn(session.id, makeMsg('hi'));
      expect(result.responseText).toBe('ok');
    });
  });
});
