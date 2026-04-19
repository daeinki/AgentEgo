import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import type { Contracts, EgoFullConfig, EgoThinkingResult } from '@agent-platform/core';
import type { CompletionRequest, ModelAdapter, StreamChunk } from '@agent-platform/agent-worker';
import { mountRpcOnGateway } from '@agent-platform/gateway-cli';
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
    state: 'off',
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
      enabled: false,
      maxActiveGoals: 10,
      autoDetectCompletion: false,
      storePath: resolve(dir, 'goals.json'),
    },
    memory: {
      searchOnCognize: false,
      maxSearchResults: 5,
      searchTimeoutMs: 2000,
      onTimeout: 'empty_result',
    },
    persona: {
      enabled: false,
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
      enabled: false,
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

describe('RpcServer mounted on ApiGateway', () => {
  let dir: string;
  let platform: PlatformHandles;
  let shutdown: () => Promise<void>;
  let port: number;

  beforeEach(async () => {
    dir = mkdtempSync(resolve(tmpdir(), 'rpc-e2e-'));
    platform = await startPlatform({
      sessionsDbPath: resolve(dir, 'sessions.db'),
      palaceRoot: resolve(dir, 'memory'),
      egoConfig: egoConfig(dir),
      egoLlm: new ScriptedEgoLlm(passthroughEgo),
      modelAdapter: new ScriptedModel(['Hello ', 'from ', 'RPC.']),
      gatewayAuthTokens: ['rpc-token'],
      telemetry: { exporter: 'memory' },
    });
    const mounted = mountRpcOnGateway({
      gateway: platform.gateway,
      deps: {
        gateway: platform.gateway,
        sessions: platform.sessions,
        router: platform.router,
        handler: platform.handler,
        version: 'test',
        ports: platform.ports,
      },
      onShutdown: () => platform.shutdown(),
      installSignalHandlers: false,
    });
    shutdown = mounted.stop;
    port = platform.ports.gateway;
  });

  afterEach(async () => {
    await shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects unauthenticated upgrades', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
    const code = await new Promise<number>((resolveResult) => {
      ws.on('unexpected-response', (_req, res) => resolveResult(res.statusCode ?? 0));
      ws.on('error', () => resolveResult(-1));
    });
    expect(code).toBe(401);
  });

  it('handles gateway.health', async () => {
    const result = await rpc(port, 'gateway.health', {});
    expect(result).toMatchObject({ ok: true, version: 'test' });
    expect(result).toHaveProperty('uptimeMs');
  });

  it('streams chat.delta notifications and returns a final result', async () => {
    const { deltas, result } = await chatSend(port, '1+1?');
    expect(deltas.join('')).toBe('Hello from RPC.');
    expect(result.usage).toMatchObject({ inputTokens: 5, outputTokens: 3 });
    expect(result.sessionId).toMatch(/\w+/);
  });

  // ADR-010: `chat.phase` notifications must bracket the turn with `received`
  // first and `complete` last, with monotonically increasing `seq`.
  it('pumps chat.phase notifications from received → complete', async () => {
    const { phases } = await chatSend(port, 'hello');
    const names = phases.map((p) => p.phase);

    expect(names[0]).toBe('received');
    expect(names[names.length - 1]).toBe('complete');
    expect(names).toContain('reasoning_route');
    expect(names).toContain('streaming_response');
    expect(names).toContain('finalizing');

    // seq must be strictly monotonic.
    for (let i = 1; i < phases.length; i++) {
      expect(phases[i]!.seq).toBeGreaterThan(phases[i - 1]!.seq);
    }

    // elapsedMs must be non-decreasing.
    for (let i = 1; i < phases.length; i++) {
      expect(phases[i]!.elapsedMs).toBeGreaterThanOrEqual(phases[i - 1]!.elapsedMs);
    }

    // No phase after `complete`.
    const completeIdx = names.indexOf('complete');
    expect(completeIdx).toBe(names.length - 1);

    // Privacy whitelist: PhaseEvent must never leak user text or raw errors.
    for (const p of phases) {
      expect(JSON.stringify(p)).not.toContain('hello');
    }
  });

  it('returns NotFound for an unknown session on chat.history', async () => {
    await expect(rpc(port, 'chat.history', { sessionId: 'does-not-exist' })).rejects.toThrow(
      /not found/i,
    );
  });

  it('returns MethodNotFound for an unregistered method', async () => {
    await expect(rpc(port, 'bogus.method', {})).rejects.toThrow(/method not found/i);
  });

  it('lists sessions after a turn', async () => {
    await chatSend(port, 'first');
    const result = (await rpc(port, 'sessions.list', {})) as {
      sessions: { id: string; agentId: string }[];
    };
    expect(result.sessions.length).toBeGreaterThanOrEqual(1);
    expect(result.sessions[0]?.agentId).toBe('default');
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────────

async function rpc(
  port: number,
  method: string,
  params: unknown,
  timeoutMs = 5000,
): Promise<unknown> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, {
    headers: { Authorization: 'Bearer rpc-token' },
  });
  const id = `t-${Date.now()}-${Math.random()}`;
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      ws.close();
      rejectPromise(new Error(`rpc ${method} timed out`));
    }, timeoutMs);
    ws.on('open', () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString('utf-8')) as {
        id?: unknown;
        result?: unknown;
        error?: { code: number; message: string };
      };
      if (frame.id !== id) return;
      clearTimeout(timer);
      ws.close();
      if (frame.error) rejectPromise(new Error(frame.error.message));
      else resolvePromise(frame.result);
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
  });
}

interface CollectedPhase {
  phase: string;
  seq: number;
  elapsedMs: number;
  detail?: Record<string, unknown>;
}

async function chatSend(
  port: number,
  text: string,
  timeoutMs = 10_000,
): Promise<{
  deltas: string[];
  phases: CollectedPhase[];
  result: { sessionId: string; usage: Record<string, number> };
}> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc`, {
    headers: { Authorization: 'Bearer rpc-token' },
  });
  const id = `chat-${Date.now()}`;
  const deltas: string[] = [];
  const phases: CollectedPhase[] = [];
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      ws.close();
      rejectPromise(new Error('chat.send timed out'));
    }, timeoutMs);
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'chat.send',
          params: { text, conversationId: `conv-${Math.random()}` },
        }),
      );
    });
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString('utf-8')) as {
        id?: unknown;
        method?: string;
        params?: {
          text?: string;
          phase?: string;
          seq?: number;
          elapsedMs?: number;
          detail?: Record<string, unknown>;
        };
        result?: { sessionId: string; usage: Record<string, number> };
        error?: { message: string };
      };
      if (frame.method === 'chat.delta' && typeof frame.params?.text === 'string') {
        deltas.push(frame.params.text);
      } else if (
        frame.method === 'chat.phase' &&
        typeof frame.params?.phase === 'string' &&
        typeof frame.params?.seq === 'number' &&
        typeof frame.params?.elapsedMs === 'number'
      ) {
        const collected: CollectedPhase = {
          phase: frame.params.phase,
          seq: frame.params.seq,
          elapsedMs: frame.params.elapsedMs,
        };
        if (frame.params.detail) collected.detail = frame.params.detail;
        phases.push(collected);
      } else if (frame.id === id) {
        clearTimeout(timer);
        ws.close();
        if (frame.error) {
          rejectPromise(new Error(frame.error.message));
        } else if (frame.result) {
          resolvePromise({ deltas, phases, result: frame.result });
        }
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
  });
}
