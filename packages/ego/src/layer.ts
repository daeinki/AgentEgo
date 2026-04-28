import type {
  Contracts,
  EgoDecision,
  EgoFullConfig,
  EgoMetadata,
  EgoThinkingResult,
  MessageSummary,
  StandardMessage,
} from '@agent-platform/core';
import {
  DailyCostCapExceeded,
  downgradeState,
  EgoTimeoutError,
  generateEgoDecisionId,
  isIntervening,
  isOperational,
  nowMs,
  SchemaValidationError,
  TimeoutError,
  validateEgoThinking,
  withTimeout,
} from '@agent-platform/core';
import { CircuitBreaker } from './circuit-breaker.js';
import type { EgoGatheredContext } from './context-gatherer.js';
import { gatherContext } from './context-gatherer.js';
import type { NormalizedSignal } from './normalize.js';
import { normalize, shouldFastExit } from './normalize.js';
import { intake } from './signal.js';
import { buildSystemPrompt, loadSystemPrompt } from './system-prompt.js';
import { performRedirect } from './redirect.js';

type EgoLlmAdapter = Contracts.EgoLlmAdapter;
type MemorySystem = Contracts.MemorySystem;
type GoalStore = Contracts.GoalStore;
type PersonaManager = Contracts.PersonaManager;
type AuditLog = Contracts.AuditLog;
type SessionManager = Contracts.SessionManager;

export interface EgoLayerDependencies {
  llm?: EgoLlmAdapter;
  memory?: MemorySystem;
  goals?: GoalStore;
  persona?: PersonaManager;
  audit?: AuditLog;
  sessions?: SessionManager;
  /** Optional per-turn debug trace logger (pipeline block E1). */
  traceLogger?: Contracts.TraceLogger;
}

export interface EgoProcessParams {
  sessionId: string;
  agentId: string;
  recentHistory?: MessageSummary[];
}

export interface ProcessRecord {
  decision: EgoDecision;
  normalized: NormalizedSignal;
  fastExit: boolean;
  thinking?: EgoThinkingResult;
  metadata?: EgoMetadata;
  costUsd: number;
  pipelineMs: number;
}

/**
 * Max serialized length of the candidate preview we embed in the E1 error
 * trace. Must stay well below the SQLite row cap but large enough to see the
 * first `judgment` / top-level keys that the LLM actually returned.
 */
const E1_ERROR_CANDIDATE_PREVIEW_CHARS = 800;

/**
 * Max number of TypeBox validation errors we embed per E1 error event.
 * A handful is enough to spot the root field that disagreed; more just
 * inflates the payload.
 */
const E1_ERROR_MAX_VALIDATION_ERRORS = 5;

/**
 * Build the structured payload written to the E1 error trace. Keeps the tag
 * from `SchemaValidationError`, a few validation errors (path + message),
 * and a truncated JSON preview of the invalid candidate so operators can
 * diagnose `llm_schema_mismatch` / `llm_inconsistent_action` etc. without
 * re-running the turn. Any error other than `SchemaValidationError` still
 * records the tag so this payload is always present on E1 failures.
 */
function buildErrorPayload(err: unknown, tag: string): Record<string, unknown> {
  const payload: Record<string, unknown> = { tag };
  if (err instanceof SchemaValidationError) {
    const rawErrors = err.validationErrors;
    if (Array.isArray(rawErrors) && rawErrors.length > 0) {
      payload['validationErrorCount'] = rawErrors.length;
      payload['validationErrors'] = rawErrors
        .slice(0, E1_ERROR_MAX_VALIDATION_ERRORS)
        .map((e) => {
          const ve = e as { path?: unknown; message?: unknown };
          return {
            path: typeof ve.path === 'string' ? ve.path : String(ve.path ?? ''),
            message:
              typeof ve.message === 'string' ? ve.message : String(ve.message ?? ''),
          };
        });
    }
    if (err.candidate !== undefined) {
      try {
        const json = JSON.stringify(err.candidate);
        payload['candidatePreview'] =
          json.length > E1_ERROR_CANDIDATE_PREVIEW_CHARS
            ? json.slice(0, E1_ERROR_CANDIDATE_PREVIEW_CHARS) + '…'
            : json;
      } catch {
        payload['candidatePreview'] = '<unserializable>';
      }
    }
  }
  return payload;
}

/**
 * Track cumulative daily cost (UTC day). Coarse enough for the daily cap.
 */
class DailyCostLedger {
  private day = '';
  private costUsd = 0;

  add(usd: number): number {
    const today = new Date().toISOString().slice(0, 10);
    if (this.day !== today) {
      this.day = today;
      this.costUsd = 0;
    }
    this.costUsd += usd;
    return this.costUsd;
  }

  get current(): number {
    return this.costUsd;
  }
}

export class EgoLayer {
  private config: EgoFullConfig;
  private readonly deps: EgoLayerDependencies;
  private systemPromptBase: string | null = null;
  private readonly breaker: CircuitBreaker;
  private readonly ledger = new DailyCostLedger();
  private readonly memoryCache = new Map<string, unknown>();

  constructor(config: EgoFullConfig, deps: EgoLayerDependencies = {}) {
    this.config = config;
    this.deps = deps;
    this.breaker = new CircuitBreaker({
      threshold: config.errorHandling.onConsecutiveFailures.threshold,
      cooldownMinutes: config.errorHandling.onConsecutiveFailures.cooldownMinutes,
    });
  }

  getConfig(): EgoFullConfig {
    return this.config;
  }

  setConfig(next: EgoFullConfig): void {
    this.config = next;
  }

  /**
   * Returns the current breaker state for observation.
   */
  breakerSnapshot(): ReturnType<CircuitBreaker['snapshot']> {
    return this.breaker.snapshot();
  }

  async processDetailed(
    msg: StandardMessage,
    params: EgoProcessParams,
  ): Promise<ProcessRecord> {
    const pipelineStart = nowMs();
    const signal = intake(msg);
    const normalized = normalize(signal);

    // state=off means this layer should never be invoked; guard anyway.
    if (!isOperational(this.config.state)) {
      this.deps.traceLogger?.event({
        traceId: msg.traceId,
        sessionId: params.sessionId,
        agentId: params.agentId,
        block: 'E1',
        event: 'fast_exit',
        timestamp: nowMs(),
        summary: `EGO fast-exit: state=off, passing through unchanged`,
        payload: { reason: 'state_off' },
      });
      return {
        decision: { action: 'passthrough' },
        normalized,
        fastExit: true,
        costUsd: 0,
        pipelineMs: nowMs() - pipelineStart,
      };
    }

    // Fast path (gated by fastPath.enabled — undefined/true 면 기존 동작 유지,
    //   false 면 모든 신호가 deep path 로 진입. EGO_FORCE_DEEP=1 런타임 오버라이드도 동일 경로.)
    const fastPathEnabled = this.config.fastPath.enabled !== false;
    if (fastPathEnabled && shouldFastExit(normalized, this.config)) {
      await this.auditDecision({
        decision: { action: 'passthrough' },
        normalized,
        fastExit: true,
        params,
        pipelineMs: nowMs() - pipelineStart,
      });
      this.deps.traceLogger?.event({
        traceId: msg.traceId,
        sessionId: params.sessionId,
        agentId: params.agentId,
        block: 'E1',
        event: 'fast_exit',
        timestamp: nowMs(),
        summary: `EGO fast-exit (rules ~16ms): intent=${normalized.intent.primary}, complexity=${normalized.complexity} → passthrough`,
        payload: {
          reason: 'fast_path',
          intent: normalized.intent.primary,
          complexity: normalized.complexity,
        },
      });
      return {
        decision: { action: 'passthrough' },
        normalized,
        fastExit: true,
        costUsd: 0,
        pipelineMs: nowMs() - pipelineStart,
      };
    }

    // Deep path requires an LLM and a healthy circuit.
    if (!this.deps.llm || !this.breaker.allow()) {
      const tag = !this.deps.llm ? 'llm_provider_error' : 'ego_circuit_open';
      await this.deps.audit?.record({
        timestamp: nowMs(),
        traceId: signal.traceId,
        tag,
        actor: 'ego',
        action: 'ego.deep_path_skipped',
        result: 'passthrough',
        riskLevel: 'low',
        sessionId: params.sessionId,
        agentId: params.agentId,
      });
      return {
        decision: { action: 'passthrough' },
        normalized,
        fastExit: false,
        costUsd: 0,
        pipelineMs: nowMs() - pipelineStart,
      };
    }

    const overallBudget = this.config.maxDecisionTimeMs;
    this.deps.traceLogger?.event({
      traceId: msg.traceId,
      sessionId: params.sessionId,
      agentId: params.agentId,
      block: 'E1',
      event: 'deep_path_start',
      timestamp: nowMs(),
      summary: `EGO deep path entered: intent=${normalized.intent.primary}, complexity=${normalized.complexity}, urgency=${normalized.urgency}`,
      payload: {
        intent: normalized.intent.primary,
        complexity: normalized.complexity,
        urgency: normalized.urgency,
      },
    });
    try {
      const record = await withTimeout(
        this.runDeepPath(msg, signal, normalized, params),
        overallBudget,
        'ego.pipeline',
      );
      record.pipelineMs = nowMs() - pipelineStart;
      const conf = record.metadata?.confidenceScore;
      this.deps.traceLogger?.event({
        traceId: msg.traceId,
        sessionId: params.sessionId,
        agentId: params.agentId,
        block: 'E1',
        event: 'decision',
        timestamp: nowMs(),
        durationMs: record.pipelineMs,
        summary:
          `EGO → ${record.decision.action}` +
          (typeof conf === 'number' ? ` (conf=${conf.toFixed(2)})` : '') +
          (record.costUsd > 0 ? `, $${record.costUsd.toFixed(4)}` : '') +
          ` in ${record.pipelineMs}ms`,
        payload: {
          action: record.decision.action,
          confidence: record.metadata?.confidenceScore ?? null,
          costUsd: record.costUsd,
          egoDecisionId: record.metadata?.egoDecisionId ?? null,
        },
      });
      return record;
    } catch (err) {
      // `withTimeout` throws `TimeoutError` when the pipeline budget is
      // exhausted; `EgoTimeoutError` is kept in the check for any bespoke
      // caller that constructs it directly. Previously only the latter was
      // recognized, so every pipeline timeout was mis-tagged as
      // `ego_runtime_error` in audit + trace — invisible until the recent
      // E1 payload work surfaced the tag.
      const isTimeout = err instanceof TimeoutError || err instanceof EgoTimeoutError;
      const fallbackTag = isTimeout ? 'ego_timeout' : 'ego_runtime_error';
      const tag = (err instanceof SchemaValidationError
        ? err.tag
        : fallbackTag) as import('@agent-platform/core').AuditTag;
      this.deps.traceLogger?.event({
        traceId: msg.traceId,
        sessionId: params.sessionId,
        agentId: params.agentId,
        block: 'E1',
        event: 'error',
        timestamp: nowMs(),
        durationMs: nowMs() - pipelineStart,
        summary: `EGO deep path failed (tag=${tag}): ${(err as Error).message.slice(0, 60)}`,
        error: (err as Error).message,
        payload: buildErrorPayload(err, tag),
      });
      this.breaker.recordFailure();
      await this.deps.audit?.record({
        timestamp: nowMs(),
        traceId: signal.traceId,
        tag,
        actor: 'ego',
        action: 'ego.deep_path',
        result: 'error',
        riskLevel: 'medium',
        sessionId: params.sessionId,
        agentId: params.agentId,
        parameters: { error: (err as Error).message },
      });
      if (!this.config.fallbackOnError) throw err;
      return {
        decision: { action: 'passthrough' },
        normalized,
        fastExit: false,
        costUsd: 0,
        pipelineMs: nowMs() - pipelineStart,
      };
    }
  }

  async process(msg: StandardMessage, params: EgoProcessParams): Promise<EgoDecision> {
    const record = await this.processDetailed(msg, params);
    return record.decision;
  }

  // ─── Deep path ────────────────────────────────────────────────────────────

  private async runDeepPath(
    msg: StandardMessage,
    signal: ReturnType<typeof intake>,
    normalized: NormalizedSignal,
    params: EgoProcessParams,
  ): Promise<ProcessRecord> {
    const gathered: EgoGatheredContext = await gatherContext({
      signal: normalized,
      sessionId: params.sessionId,
      agentId: params.agentId,
      config: this.config,
      ...(this.deps.memory ? { memory: this.deps.memory } : {}),
      ...(this.deps.goals ? { goals: this.deps.goals } : {}),
      ...(params.recentHistory ? { recentHistory: params.recentHistory } : {}),
      memoryCache: this.memoryCache as Map<string, never>,
      ...(this.deps.audit ? { audit: this.deps.audit } : {}),
      ...(this.deps.traceLogger ? { traceLogger: this.deps.traceLogger } : {}),
      traceId: signal.traceId,
    });

    const personaSnapshot = this.deps.persona
      ? await this.deps.persona.snapshot({
          rawText: normalized.rawText,
          entities: normalized.entities.map((e) => ({ type: e.type, value: e.value })),
        })
      : undefined;

    if (!this.systemPromptBase) {
      this.systemPromptBase = await loadSystemPrompt(this.config.prompts.systemPromptFile);
    }
    const systemPrompt = buildSystemPrompt(this.systemPromptBase, personaSnapshot);

    const llmStart = nowMs();
    const raw: unknown = await this.deps.llm!.think({
      systemPrompt,
      context: {
        signal: normalized,
        recentConversation: gathered.recentHistory,
        relevantMemories: gathered.memories.map((m) => m.content),
        activeGoals: gathered.activeGoals,
      },
      responseFormat: { type: 'json_object' },
    });
    const llmLatencyMs = nowMs() - llmStart;

    // Validate even though the adapter already parses — belt-and-suspenders.
    const outcome = validateEgoThinking(raw);
    if (!outcome.ok || !outcome.value) {
      throw new SchemaValidationError(
        `EGO LLM schema violation (${outcome.tag ?? 'unknown'})`,
        outcome.errors ?? [],
        {
          ...(outcome.tag ? { tag: outcome.tag } : {}),
          candidate: raw,
        },
      );
    }
    const thinking = outcome.value;
    this.breaker.recordSuccess();

    // Cost model — estimate based on tokens used.
    // Best-effort: raw doesn't expose token counts here; downstream callers can
    // pass in observed cost via the adapter if they need it. Placeholder 0.
    const costUsd = 0;
    const totalCostUsd = this.ledger.add(costUsd);

    // Enforce daily cost cap.
    if (totalCostUsd > this.config.thresholds.maxCostUsdPerDay) {
      const downgraded = downgradeState(this.config.state);
      this.config = { ...this.config, state: downgraded };
      await this.deps.audit?.record({
        timestamp: nowMs(),
        traceId: signal.traceId,
        tag: 'daily_cost_cap_hit',
        actor: 'ego',
        action: 'ego.auto_downgrade',
        result: 'success',
        riskLevel: 'high',
        sessionId: params.sessionId,
        agentId: params.agentId,
        parameters: { from: 'active', to: downgraded, totalCostUsd },
      });
      throw new DailyCostCapExceeded(
        this.config.thresholds.maxCostUsdPerDay,
        totalCostUsd,
      );
    }

    // Apply confidence threshold override (§5.6)
    const mutableJudgment: typeof thinking.judgment = { ...thinking.judgment };
    if (mutableJudgment.confidence < this.config.thresholds.minConfidenceToAct) {
      mutableJudgment.action = 'passthrough';
      mutableJudgment.reason += ' [overridden: below threshold]';
    }

    // In passive state, never actually intervene — record the judgment but passthrough.
    const effectiveAction = isIntervening(this.config.state)
      ? mutableJudgment.action
      : 'passthrough';

    const decisionId = generateEgoDecisionId();
    const metadata: EgoMetadata = {
      egoDecisionId: decisionId,
      decisionReason: mutableJudgment.reason,
      confidenceScore: mutableJudgment.confidence,
      decisionTimeMs: llmLatencyMs,
      ...(costUsd > 0 ? { llmCostUsd: costUsd } : {}),
    };

    const decision = await this.materializeDecision(
      effectiveAction,
      thinking,
      msg,
      metadata,
      params,
      gathered.recentHistory,
    );

    await this.auditDecision({
      decision,
      normalized,
      fastExit: false,
      params,
      pipelineMs: llmLatencyMs,
      thinking,
      decisionId,
    });

    return {
      decision,
      normalized,
      fastExit: false,
      thinking,
      metadata,
      costUsd,
      pipelineMs: llmLatencyMs,
    };
  }

  private async materializeDecision(
    effectiveAction: 'passthrough' | 'enrich' | 'redirect' | 'direct_response',
    thinking: EgoThinkingResult,
    originalMessage: StandardMessage,
    metadata: EgoMetadata,
    params: EgoProcessParams,
    recentHistory: MessageSummary[],
  ): Promise<EgoDecision> {
    switch (effectiveAction) {
      case 'passthrough':
        return { action: 'passthrough' };

      case 'enrich': {
        const enrichment = thinking.judgment.enrichment ?? {};
        // Stash enrichment hints in the channel metadata so downstream can read them.
        const enriched: StandardMessage = {
          ...originalMessage,
          channel: {
            ...originalMessage.channel,
            metadata: {
              ...originalMessage.channel.metadata,
              _egoEnrichment: enrichment,
              _egoDecisionId: metadata.egoDecisionId,
            },
          },
        };
        return { action: 'enrich', enrichedMessage: enriched, metadata };
      }

      case 'redirect': {
        const redirect = thinking.judgment.redirect;
        if (!redirect) return { action: 'passthrough' };

        if (this.deps.sessions) {
          await performRedirect({
            egoDecisionId: metadata.egoDecisionId as never,
            traceId: originalMessage.traceId,
            originalSessionId: params.sessionId,
            originalMessage,
            targetAgentId: redirect.targetAgentId,
            targetSessionId: redirect.targetSessionId,
            reason: redirect.reason,
            recentHistory,
            sessions: this.deps.sessions,
            ...(this.deps.audit ? { audit: this.deps.audit } : {}),
          });
        }

        return {
          action: 'redirect',
          targetAgentId: redirect.targetAgentId,
          targetSessionId: redirect.targetSessionId,
          reason: redirect.reason,
        };
      }

      case 'direct_response': {
        const dr = thinking.judgment.directResponse;
        if (!dr) return { action: 'passthrough' };
        return {
          action: 'direct_response',
          content: { type: 'text', text: dr.text },
          reason: thinking.judgment.reason,
        };
      }
    }
  }

  private async auditDecision(args: {
    decision: EgoDecision;
    normalized: NormalizedSignal;
    fastExit: boolean;
    params: EgoProcessParams;
    pipelineMs: number;
    thinking?: EgoThinkingResult;
    decisionId?: string;
  }): Promise<void> {
    if (!this.deps.audit || !this.config.audit.enabled) return;
    await this.deps.audit.record({
      timestamp: nowMs(),
      traceId: args.normalized.traceId,
      tag: 'ego_decision',
      actor: 'ego',
      action: args.fastExit ? 'ego.fast_exit' : 'ego.deep_path',
      result: 'success',
      riskLevel: 'low',
      sessionId: args.params.sessionId,
      agentId: args.params.agentId,
      ...(args.decisionId ? { egoDecisionId: args.decisionId } : {}),
      parameters: {
        action: args.decision.action,
        intent: args.normalized.intent.primary,
        complexity: args.normalized.complexity,
        pipelineMs: args.pipelineMs,
        ...(args.thinking
          ? {
              confidence: args.thinking.judgment.confidence,
              egoRelevance: args.thinking.cognition.egoRelevance,
            }
          : {}),
      },
    });
  }
}
