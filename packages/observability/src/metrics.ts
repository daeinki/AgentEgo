import type { AuditTag, TurnMetrics } from '@agent-platform/core';

/**
 * Minimal in-process metrics aggregator. Deliberately lightweight — the
 * intent is to provide a single API surface that later wiring can pipe into
 * OTel's metrics SDK, Prometheus, or a custom sink. Keeping it dependency-
 * free for now avoids forcing an exporter on test runs.
 */
export interface MetricsSink {
  recordTurn(metrics: TurnMetrics): void;
  recordEgoDecision(info: {
    fastExit: boolean;
    action: string;
    confidence: number;
    costUsd: number;
    pipelineMs: number;
  }): void;
  incrementAuditTag(tag: AuditTag): void;
  snapshot(): MetricsSnapshot;
}

export interface MetricsSnapshot {
  turns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  avgTurnLatencyMs: number;
  egoDecisions: number;
  egoFastExits: number;
  egoFastExitRatio: number;
  auditTagCounts: Partial<Record<AuditTag, number>>;
  egoActionCounts: Record<string, number>;
}

export class InMemoryMetricsSink implements MetricsSink {
  private turns = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCostUsd = 0;
  private totalLatencyMs = 0;

  private egoDecisions = 0;
  private egoFastExits = 0;
  private egoActionCounts: Record<string, number> = {};
  private auditTagCounts: Partial<Record<AuditTag, number>> = {};

  recordTurn(metrics: TurnMetrics): void {
    this.turns += 1;
    this.totalInputTokens += metrics.inputTokens;
    this.totalOutputTokens += metrics.outputTokens;
    this.totalCostUsd += metrics.estimatedCostUsd;
    this.totalLatencyMs += metrics.totalLatencyMs;
  }

  recordEgoDecision(info: {
    fastExit: boolean;
    action: string;
    confidence: number;
    costUsd: number;
    pipelineMs: number;
  }): void {
    this.egoDecisions += 1;
    if (info.fastExit) this.egoFastExits += 1;
    this.egoActionCounts[info.action] = (this.egoActionCounts[info.action] ?? 0) + 1;
    this.totalCostUsd += info.costUsd;
  }

  incrementAuditTag(tag: AuditTag): void {
    this.auditTagCounts[tag] = (this.auditTagCounts[tag] ?? 0) + 1;
  }

  snapshot(): MetricsSnapshot {
    return {
      turns: this.turns,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalCostUsd: this.totalCostUsd,
      avgTurnLatencyMs: this.turns === 0 ? 0 : this.totalLatencyMs / this.turns,
      egoDecisions: this.egoDecisions,
      egoFastExits: this.egoFastExits,
      egoFastExitRatio:
        this.egoDecisions === 0 ? 0 : this.egoFastExits / this.egoDecisions,
      auditTagCounts: { ...this.auditTagCounts },
      egoActionCounts: { ...this.egoActionCounts },
    };
  }
}
