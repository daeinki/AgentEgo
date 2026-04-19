import { describe, it, expect } from 'vitest';
import { InMemoryMetricsSink } from './metrics.js';
import type { TurnMetrics } from '@agent-platform/core';

function turnMetrics(overrides: Partial<TurnMetrics> = {}): TurnMetrics {
  return {
    traceId: 't',
    sessionId: 's',
    agentId: 'a',
    channelType: 'webchat',
    model: 'claude',
    inputTokens: 100,
    outputTokens: 50,
    estimatedCostUsd: 0.0003,
    firstTokenLatencyMs: 200,
    totalLatencyMs: 1200,
    toolCallCount: 0,
    toolCallLatencyMs: [],
    retryCount: 0,
    failoverTriggered: false,
    compactionTriggered: false,
    ...overrides,
  };
}

describe('InMemoryMetricsSink', () => {
  it('records turn totals', () => {
    const sink = new InMemoryMetricsSink();
    sink.recordTurn(turnMetrics({ inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.01, totalLatencyMs: 1000 }));
    sink.recordTurn(turnMetrics({ inputTokens: 20, outputTokens: 10, estimatedCostUsd: 0.02, totalLatencyMs: 500 }));
    const snap = sink.snapshot();
    expect(snap.turns).toBe(2);
    expect(snap.totalInputTokens).toBe(30);
    expect(snap.totalOutputTokens).toBe(15);
    expect(snap.totalCostUsd).toBeCloseTo(0.03);
    expect(snap.avgTurnLatencyMs).toBe(750);
  });

  it('records EGO decisions with fast-exit ratio', () => {
    const sink = new InMemoryMetricsSink();
    for (let i = 0; i < 3; i += 1) {
      sink.recordEgoDecision({ fastExit: true, action: 'passthrough', confidence: 1, costUsd: 0, pipelineMs: 10 });
    }
    sink.recordEgoDecision({ fastExit: false, action: 'enrich', confidence: 0.8, costUsd: 0.002, pipelineMs: 1500 });
    const snap = sink.snapshot();
    expect(snap.egoDecisions).toBe(4);
    expect(snap.egoFastExits).toBe(3);
    expect(snap.egoFastExitRatio).toBeCloseTo(0.75);
    expect(snap.egoActionCounts.enrich).toBe(1);
    expect(snap.egoActionCounts.passthrough).toBe(3);
  });

  it('tallies audit tags', () => {
    const sink = new InMemoryMetricsSink();
    sink.incrementAuditTag('ego_decision');
    sink.incrementAuditTag('ego_decision');
    sink.incrementAuditTag('memory_timeout');
    const snap = sink.snapshot();
    expect(snap.auditTagCounts.ego_decision).toBe(2);
    expect(snap.auditTagCounts.memory_timeout).toBe(1);
  });

  it('empty snapshot is safe', () => {
    const snap = new InMemoryMetricsSink().snapshot();
    expect(snap.turns).toBe(0);
    expect(snap.egoFastExitRatio).toBe(0);
  });
});
