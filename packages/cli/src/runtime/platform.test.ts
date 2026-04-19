import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import type {
  Contracts,
  EgoFullConfig,
  EgoThinkingResult,
} from '@agent-platform/core';
import type {
  CompletionRequest,
  ModelAdapter,
  StreamChunk,
} from '@agent-platform/agent-worker';
import { startPlatform, type PlatformHandles } from './platform.js';

class ScriptedModel implements ModelAdapter {
  constructor(private readonly script: string[]) {}
  async *stream(_req: CompletionRequest): AsyncIterable<StreamChunk> {
    for (const piece of this.script) yield { type: 'text_delta', text: piece };
    yield { type: 'usage', inputTokens: 5, outputTokens: 3, cost: 0.00005 };
    yield { type: 'done', stopReason: 'end_turn' };
  }
  getModelInfo() {
    return { provider: 'mock', model: 'mock-model' };
  }
}

class ScriptedEgoLlm implements Contracts.EgoLlmAdapter {
  constructor(private readonly response: EgoThinkingResult) {}
  async initialize(): Promise<void> {}
  async think(): Promise<EgoThinkingResult> {
    return this.response;
  }
  async healthCheck() {
    return true;
  }
  getModelInfo() {
    return { provider: 'mock', model: 'mock', isFallback: false };
  }
}

function egoConfig(dir: string): EgoFullConfig {
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
    prompts: { systemPromptFile: resolve(dir, 'sys.md'), responseFormat: 'json' },
    goals: {
      enabled: true,
      maxActiveGoals: 10,
      autoDetectCompletion: false,
      storePath: resolve(dir, 'goals.json'),
    },
    memory: {
      searchOnCognize: true,
      maxSearchResults: 5,
      searchTimeoutMs: 2000,
      onTimeout: 'empty_result',
    },
    persona: {
      enabled: true,
      storePath: resolve(dir, 'persona.json'),
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
      storePath: resolve(dir, 'audit.db'),
      retentionDays: 90,
    },
  };
}

const passthroughEgo: EgoThinkingResult = {
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
    situationSummary: 'ok',
    opportunities: [],
    risks: [],
    egoRelevance: 0.3,
  },
  judgment: { action: 'passthrough', confidence: 0.8, reason: 'routine' },
};

describe('platform e2e wiring', () => {
  let dir: string;
  let platform: PlatformHandles;

  beforeEach(async () => {
    dir = mkdtempSync(resolve(tmpdir(), 'platform-e2e-'));
    platform = await startPlatform({
      sessionsDbPath: resolve(dir, 'sessions.db'),
      palaceRoot: resolve(dir, 'memory'),
      egoConfig: egoConfig(dir),
      egoLlm: new ScriptedEgoLlm(passthroughEgo),
      modelAdapter: new ScriptedModel(['Hello ', 'from the agent.']),
      gatewayAuthTokens: ['e2e-token'],
      telemetry: { exporter: 'memory' },
    });
  });

  afterEach(async () => {
    await platform.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('GET /healthz on the gateway returns 200', async () => {
    const res = await fetch(`http://127.0.0.1:${platform.ports.gateway}/healthz`);
    expect(res.status).toBe(200);
  });

  it('HTTP POST /messages drives the full stack end-to-end', async () => {
    const res = await fetch(`http://127.0.0.1:${platform.ports.gateway}/messages`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer e2e-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        id: 'msg-1',
        traceId: 'trc-1',
        timestamp: Date.now(),
        channel: { type: 'webchat', id: 'cli', metadata: {} },
        sender: { id: 'user-a', isOwner: true },
        conversation: { type: 'dm', id: 'conv-a' },
        content: { type: 'text', text: 'hello' },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accepted: boolean; responseText: string };
    expect(body.accepted).toBe(true);
    expect(body.responseText).toBe('Hello from the agent.');

    // Metrics should reflect 1 turn + 1 EGO decision.
    const snap = platform.metrics.snapshot();
    expect(snap.turns).toBe(1);
    expect(snap.egoDecisions).toBe(1);

    // Memory should have ingested the turn.
    const hits = await platform.memory.search('agent', {
      sessionId: 's',
      agentId: 'a',
      recentTopics: [],
      maxResults: 5,
      minRelevanceScore: 0,
    });
    expect(hits.length).toBeGreaterThan(0);
  });

  it('WebChat client → platform → streamed response path works', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${platform.ports.webchat}/webchat`);
    await new Promise<void>((resolveOpen, reject) => {
      ws.on('open', () => resolveOpen());
      ws.on('error', reject);
    });

    const inbox: unknown[] = [];
    ws.on('message', (data: Buffer) => inbox.push(JSON.parse(data.toString('utf-8'))));

    ws.send(JSON.stringify({ type: 'identify', userId: 'owner-x' }));
    await waitFor(() => inbox.find((m) => (m as { type: string }).type === 'system'));

    ws.send(JSON.stringify({ type: 'say', text: 'tell me something' }));

    await waitFor(() => inbox.find((m) => (m as { type: string }).type === 'done'), 3000);

    const deltas = inbox.filter((m) => (m as { type: string }).type === 'delta') as {
      text: string;
    }[];
    expect(deltas.map((d) => d.text).join('')).toBe('Hello from the agent.');

    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });
});

async function waitFor(predicate: () => unknown, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor timed out');
}

// ─── U10 Phase 1: default tools wiring ────────────────────────────────────

class CapturingReasoner implements Contracts.Reasoner {
  readonly mode = 'react' as const;
  public captured?: Contracts.ReasoningContext;
  async *run(ctx: Contracts.ReasoningContext): AsyncIterable<Contracts.ReasoningEvent> {
    this.captured = ctx;
    yield {
      kind: 'final',
      text: 'captured',
      state: { mode: 'react', egoDecisionId: ctx.egoDecisionId, trace: [], budget: { maxSteps: 8, maxToolCalls: 16, spent: { steps: 0, toolCalls: 0 } } },
    };
    yield { kind: 'usage', inputTokens: 1, outputTokens: 1, cost: 0 };
  }
}

describe('platform defaultToolsConfig wiring', () => {
  let dir: string;
  let platform: PlatformHandles;

  afterEach(async () => {
    await platform?.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('injects fs.read/fs.write from defaultToolsConfig when tools is unset', async () => {
    dir = mkdtempSync(resolve(tmpdir(), 'platform-deftools-'));
    const reasoner = new CapturingReasoner();
    platform = await startPlatform({
      sessionsDbPath: resolve(dir, 'sessions.db'),
      palaceRoot: resolve(dir, 'memory'),
      egoConfig: egoConfig(dir),
      egoLlm: new ScriptedEgoLlm(passthroughEgo),
      modelAdapter: new ScriptedModel(['captured']),
      gatewayAuthTokens: ['dt-token'],
      telemetry: { exporter: 'memory' },
      reasoner,
      defaultToolsConfig: {
        fsRead: [dir],
        fsWrite: [resolve(dir, 'workspace')],
      },
    });

    const res = await fetch(`http://127.0.0.1:${platform.ports.gateway}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer dt-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'msg-dt',
        traceId: 'trc-dt',
        timestamp: Date.now(),
        channel: { type: 'webchat', id: 'cli', metadata: {} },
        sender: { id: 'user-a', isOwner: true },
        conversation: { type: 'dm', id: 'conv-dt' },
        content: { type: 'text', text: 'any' },
      }),
    });
    expect(res.status).toBe(200);
    expect(reasoner.captured).toBeDefined();
    const names = reasoner.captured!.availableTools.map((t) => t.name);
    expect(names).toContain('fs.read');
    expect(names).toContain('fs.write');
  });

  it('user-provided tools override defaultToolsConfig on name conflicts', async () => {
    dir = mkdtempSync(resolve(tmpdir(), 'platform-overr-'));
    const reasoner = new CapturingReasoner();
    const customFsRead = {
      name: 'fs.read',
      description: 'custom override',
      riskLevel: 'low' as const,
      permissions: [],
      inputSchema: { type: 'object' },
      execute: async () => ({
        toolName: 'fs.read',
        success: true,
        output: '',
        durationMs: 0,
      }),
    };
    platform = await startPlatform({
      sessionsDbPath: resolve(dir, 'sessions.db'),
      palaceRoot: resolve(dir, 'memory'),
      egoConfig: egoConfig(dir),
      egoLlm: new ScriptedEgoLlm(passthroughEgo),
      modelAdapter: new ScriptedModel(['captured']),
      gatewayAuthTokens: ['ov-token'],
      telemetry: { exporter: 'memory' },
      reasoner,
      defaultToolsConfig: { fsRead: [dir] },
      tools: [customFsRead],
    });

    const res = await fetch(`http://127.0.0.1:${platform.ports.gateway}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ov-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'msg-ov',
        traceId: 'trc-ov',
        timestamp: Date.now(),
        channel: { type: 'webchat', id: 'cli', metadata: {} },
        sender: { id: 'user-a', isOwner: true },
        conversation: { type: 'dm', id: 'conv-ov' },
        content: { type: 'text', text: 'any' },
      }),
    });
    expect(res.status).toBe(200);
    const tools = reasoner.captured!.availableTools;
    const fsReadEntries = tools.filter((t) => t.name === 'fs.read');
    expect(fsReadEntries).toHaveLength(1);
    expect(fsReadEntries[0]!.description).toBe('custom override');
  });
});
