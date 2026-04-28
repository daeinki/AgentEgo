import type {
  Cognition,
  Contracts,
  GoalUpdate,
  Perception,
  Phase,
  PhaseEventDetail,
  SessionPolicy,
  StandardMessage,
} from '@agent-platform/core';
import { nowMs } from '@agent-platform/core';
import { SessionStore } from '@agent-platform/control-plane';
import type { ModelAdapter } from '../model/types.js';
import { PromptBuilder } from '../prompt/builder.js';
import { ReactExecutor } from '../reasoning/react-executor.js';
import type { LiveToolRegistry } from '../tools/live-registry.js';

export interface AgentConfig {
  agentId: string;
  systemPrompt?: string;
}

export interface AgentRunnerDeps {
  memory?: Contracts.MemorySystem;
  /**
   * Reasoner override. If provided, the runner does not wrap tool wiring itself
   * — the injected reasoner is expected to already own its CapabilityGuard /
   * ToolSandbox / SessionPolicy.
   */
  reasoner?: Contracts.Reasoner;
  /**
   * Tool descriptors exposed to the reasoner via ReasoningContext.availableTools.
   * When empty, the ReAct loop degenerates to a single LLM call (pre-ADR-009 behavior).
   * If `toolRegistry` is also provided it takes precedence (snapshotted per-turn).
   */
  tools?: Contracts.ToolDescriptor[];
  /**
   * U10 Phase 4: live, mutable tool registry. When present, each turn reads a
   * fresh descriptor snapshot from it so tools registered after the runner
   * was constructed (e.g. via `skill.create`) become available on the
   * following turn.
   */
  toolRegistry?: LiveToolRegistry;
  /**
   * Used by the default internal ReactExecutor when no `reasoner` is injected.
   */
  capabilityGuard?: Contracts.CapabilityGuard;
  toolSandbox?: Contracts.ToolSandbox;
  sessionPolicy?: SessionPolicy;
  /** Optional per-turn debug trace logger (pipeline block W1). */
  traceLogger?: Contracts.TraceLogger;
}

export interface TurnResult {
  responseText: string;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  latencyMs: number;
  ingested: boolean;
}

/**
 * Agent execution loop.
 *
 * Flow:
 * 1. Load recent session events
 * 2. Extract EGO enrichment (if present in channel.metadata)
 * 3. Build prompt from history + user message + enrichment
 * 4. Stream LLM response
 * 5. Save user + assistant events
 * 6. (optional) Ingest the turn into memory
 */
export class AgentRunner {
  private promptBuilder = new PromptBuilder();

  constructor(
    private sessionStore: SessionStore,
    private modelAdapter: ModelAdapter,
    private config: AgentConfig,
    private deps: AgentRunnerDeps = {},
  ) {}

  async processTurn(
    sessionId: string,
    msg: StandardMessage,
    onChunk?: (text: string) => void,
    onPhase?: (phase: Phase, detail?: PhaseEventDetail) => void,
  ): Promise<TurnResult> {
    const startTime = performance.now();
    const userText = extractText(msg);
    const enrichment = extractEgoEnrichment(msg);
    const trace = this.deps.traceLogger;

    // 1. Session resolution confirmation (ADR-010: §3.3.1 Step 1 canonical).
    //    세션 해석 자체는 상위(gateway/router) 에서 이뤄지므로 여기서는
    //    session 존재·신규여부만 재확인해 감사 로그 연속성을 유지한다.
    const existingSession = this.sessionStore.getSession(sessionId);
    trace?.event({
      traceId: msg.traceId,
      sessionId,
      agentId: this.config.agentId,
      block: 'W1',
      event: 'session_resolved',
      timestamp: Date.now(),
      summary: existingSession
        ? `session '${sessionId}' resolved (existing, status=${existingSession.status})`
        : `session '${sessionId}' resolved (new)`,
      payload: {
        isNew: existingSession === null,
        ...(existingSession ? { status: existingSession.status } : {}),
      },
    });

    // 1b. Load session history (ADR-010: loadHistory 경유 — reasoning_step 기본 제외)
    const events = this.sessionStore.loadHistory(sessionId, { limit: 50 });
    trace?.event({
      traceId: msg.traceId,
      sessionId,
      agentId: this.config.agentId,
      block: 'W1',
      event: 'history_loaded',
      timestamp: Date.now(),
      summary: `loaded ${events.length} prior session events from sessions.db`,
      payload: { eventCount: events.length },
    });

    // 2+3. Build prompt
    const { systemPrompt, messages } = this.promptBuilder.build({
      systemPrompt: this.config.systemPrompt ?? '',
      sessionEvents: events,
      userMessage: userText,
      ...(enrichment ? { egoEnrichment: enrichment } : {}),
    });

    // Prompt builder appends the current user message last; ReactExecutor re-adds
    // it from ctx.userMessage, so the history we hand over excludes it.
    const priorMessages = messages.slice(0, -1);
    trace?.event({
      traceId: msg.traceId,
      sessionId,
      agentId: this.config.agentId,
      block: 'W1',
      event: 'prompt_built',
      timestamp: Date.now(),
      summary: `built prompt with ${priorMessages.length} prior messages${enrichment ? ', EGO enrichment included' : ''}`,
      payload: {
        priorMessageCount: priorMessages.length,
        hasEnrichment: enrichment !== undefined,
      },
    });

    // 4. Delegate to Reasoner. When no reasoner is injected, we build a
    //    ReactExecutor wired with whatever tool-execution deps the runner was
    //    constructed with (guard/sandbox/policy). Missing deps degrade
    //    gracefully to a text-only single-LLM call.
    const reasoner =
      this.deps.reasoner ??
      new ReactExecutor(this.modelAdapter, {
        ...(this.deps.capabilityGuard ? { capabilityGuard: this.deps.capabilityGuard } : {}),
        ...(this.deps.toolSandbox ? { toolSandbox: this.deps.toolSandbox } : {}),
        ...(this.deps.sessionPolicy ? { sessionPolicy: this.deps.sessionPolicy } : {}),
        ...(trace ? { traceLogger: trace } : {}),
      });
    const egoDecisionId = extractEgoDecisionId(msg);
    const egoPerception = extractEgoPerception(msg);
    const egoCognition = extractEgoCognition(msg);
    const goalUpdates = extractEgoGoalUpdates(msg);

    let responseText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd: number | undefined;

    // U10 Phase 4: prefer the live registry snapshot when wired, so tools
    // registered since the previous turn (e.g. via skill.create) are visible.
    const availableTools =
      this.deps.toolRegistry?.descriptors() ?? this.deps.tools ?? [];

    const ctx: Contracts.ReasoningContext = {
      sessionId,
      agentId: this.config.agentId,
      userMessage: msg,
      systemPrompt,
      priorMessages,
      availableTools,
      egoDecisionId,
      ...(egoPerception ? { egoPerception } : {}),
      ...(egoCognition ? { egoCognition } : {}),
      ...(goalUpdates && goalUpdates.length > 0 ? { goalUpdates } : {}),
      ...(trace ? { traceLogger: trace } : {}),
    };

    const toolNames = ctx.availableTools.map((t) => t.name);
    trace?.event({
      traceId: msg.traceId,
      sessionId,
      agentId: this.config.agentId,
      block: 'W1',
      event: 'reasoner_invoked',
      timestamp: Date.now(),
      summary: `invoking ${reasoner.mode} reasoner with ${toolNames.length} tools available`,
      payload: { availableTools: toolNames },
    });

    // ADR-010: emit `reasoning_route` phase before the reasoner takes over.
    // This is the handoff point — after this, phase transitions are driven by
    // the ReasoningEvent stream below.
    onPhase?.('reasoning_route', { reasoningMode: reasoner.mode });

    // Replan attempt counter (ADR-010 §3.1.4.3 `detail.attemptNumber`).
    let replanAttempts = 0;
    // Guard so `streaming_response` fires at most once per turn.
    let streamingPhaseEmitted = false;

    for await (const ev of reasoner.run(ctx)) {
      if (ev.kind === 'delta') {
        if (!streamingPhaseEmitted) {
          onPhase?.('streaming_response');
          streamingPhaseEmitted = true;
        }
        responseText += ev.text;
        onChunk?.(ev.text);
      } else if (ev.kind === 'usage') {
        inputTokens = ev.inputTokens;
        outputTokens = ev.outputTokens;
        if (ev.cost !== undefined) costUsd = ev.cost;
      } else if (ev.kind === 'step') {
        // ADR-010: Reasoner 스텝을 session_events 에 기록. 실패는 turn 을
        //   중단시키지 않음(관측 전용 — loadHistory 기본값에서 제외됨).
        try {
          this.sessionStore.appendEvent(sessionId, {
            eventType: 'reasoning_step',
            role: 'assistant',
            content: JSON.stringify(ev.step),
            traceId: msg.traceId,
            createdAt: ev.step.at,
          });
        } catch {
          // swallow — reasoning_step append failures are non-fatal
        }

        // harness-engineering.md §3.1.4.4 — translate reasoning steps into
        // phase events. Only surface the "what kind of work" signal; argument
        // values / thought text are NEVER forwarded (§3.1.4.7).
        if (ev.step.kind === 'tool_call') {
          const toolName = readToolName(ev.step.content);
          onPhase?.('tool_call', toolName ? { toolName } : undefined);
        } else if (ev.step.kind === 'plan') {
          onPhase?.('planning');
        } else if (ev.step.kind === 'replan') {
          replanAttempts += 1;
          onPhase?.('replan', { attemptNumber: replanAttempts });
        }
      } else if (ev.kind === 'final') {
        // `ev.text` reflects the final reasoning answer; prefer it when present,
        // otherwise keep whatever we accumulated from deltas.
        if (ev.text.length > 0) responseText = ev.text;
      }
    }

    const latencyMs = performance.now() - startTime;

    trace?.event({
      traceId: msg.traceId,
      sessionId,
      agentId: this.config.agentId,
      block: 'W1',
      event: 'stream_done',
      timestamp: Date.now(),
      durationMs: Math.round(latencyMs),
      summary:
        `reasoner returned ${responseText.length} chars in ${Math.round(latencyMs)}ms ` +
        `(${inputTokens} in / ${outputTokens} out${costUsd !== undefined ? `, $${costUsd.toFixed(4)}` : ''})`,
      payload: {
        responseLen: responseText.length,
        inputTokens,
        outputTokens,
        costUsd: costUsd ?? null,
      },
    });

    // 8a/8b. Persist turn events (ADR-010: appendEvent 경유, 턴 종결 직후 한 단위로).
    //   실패 시 8b/8c/9 를 건너뛰고 감사 로그 태그 'session_append_failed' 발행 후 throw.
    const timestamp = nowMs();
    let appendedCount = 0;
    try {
      this.sessionStore.appendEvent(sessionId, {
        eventType: 'user_message',
        role: 'user',
        content: userText,
        tokenCount: inputTokens,
        traceId: msg.traceId,
        createdAt: timestamp,
      });
      appendedCount += 1;

      this.sessionStore.appendEvent(sessionId, {
        eventType: 'agent_response',
        role: 'assistant',
        content: responseText,
        tokenCount: outputTokens,
        ...(costUsd !== undefined ? { costUsd } : {}),
        traceId: msg.traceId,
        createdAt: timestamp + 1,
      });
      appendedCount += 1;
    } catch (error) {
      trace?.event({
        traceId: msg.traceId,
        sessionId,
        agentId: this.config.agentId,
        block: 'W1',
        event: 'session_append_failed',
        timestamp: Date.now(),
        summary: `failed to persist ${appendedCount} session events: ${(error instanceof Error ? error.message : String(error)).slice(0, 60)}`,
        payload: {
          appendedCount,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }

    trace?.event({
      traceId: msg.traceId,
      sessionId,
      agentId: this.config.agentId,
      block: 'W1',
      event: 'session_events_appended',
      timestamp: Date.now(),
      summary: `persisted ${appendedCount} session events (user_message + agent_response)`,
      payload: { appendedCount },
    });

    // 6. Ingest into memory (best-effort — failures shouldn't fail the turn
    //    since the session events are already persisted).
    let ingested = false;
    if (this.deps.memory && responseText.length > 0) {
      try {
        await this.deps.memory.ingest(
          {
            sessionId,
            userMessage: userText,
            agentResponse: responseText,
            timestamp,
          },
          trace
            ? {
                traceLogger: trace,
                traceId: msg.traceId,
                sessionId,
                agentId: this.config.agentId,
              }
            : undefined,
        );
        ingested = true;
      } catch {
        // swallow — memory ingest is best-effort
      }
      trace?.event({
        traceId: msg.traceId,
        sessionId,
        agentId: this.config.agentId,
        block: 'W1',
        event: 'memory_ingested',
        timestamp: Date.now(),
        summary: ingested
          ? `memory ingested user+agent turn into PalaceMemorySystem`
          : `memory ingest skipped (best-effort failure swallowed)`,
        payload: { ingested },
      });
    }

    const result: TurnResult = {
      responseText,
      inputTokens,
      outputTokens,
      latencyMs,
      ingested,
    };
    if (costUsd !== undefined) result.costUsd = costUsd;
    return result;
  }
}

/**
 * Extract the tool name from a `tool_call` ReasoningStep's `content` payload
 * for PhaseEvent reporting. Returns undefined when the content doesn't look
 * like the expected `{ id, name, argsRaw }` shape — we never throw or expose
 * the raw arguments (ADR-010 §3.1.4.7 whitelist).
 */
function readToolName(content: unknown): string | undefined {
  if (typeof content !== 'object' || content === null) return undefined;
  const rec = content as Record<string, unknown>;
  const name = rec['name'];
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

function extractText(msg: StandardMessage): string {
  if (msg.content.type === 'text') return msg.content.text;
  if (msg.content.type === 'command') return `/${msg.content.name} ${msg.content.args.join(' ')}`;
  if (msg.content.type === 'media') return msg.content.caption ?? '[media]';
  if (msg.content.type === 'reaction') return msg.content.emoji;
  return '';
}

function extractEgoDecisionId(msg: StandardMessage): string | null {
  const meta = msg.channel.metadata as Record<string, unknown> | undefined;
  const raw = meta?.['_egoDecisionId'];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Lift the EGO perception (if upstream attached one) into ReasoningContext so
 * ComplexityRouter can read `requestType` / `estimatedComplexity` directly
 * instead of falling back to text heuristics. Treats malformed payloads as
 * absent — the router degrades gracefully.
 */
function extractEgoPerception(msg: StandardMessage): Perception | undefined {
  const meta = msg.channel.metadata as Record<string, unknown> | undefined;
  const raw = meta?.['_egoPerception'];
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as Partial<Perception>;
  if (
    typeof p.requestType !== 'string' ||
    typeof p.estimatedComplexity !== 'string' ||
    typeof p.isFollowUp !== 'boolean' ||
    typeof p.requiresToolUse !== 'boolean' ||
    !Array.isArray(p.patterns)
  ) {
    return undefined;
  }
  return p as Perception;
}

/**
 * Lift the EGO `Cognition` snapshot (opportunities/risks/egoRelevance) into
 * ReasoningContext. Used by PlanExecuteExecutor to gate replan trigger #3.
 * Malformed payloads are treated as absent.
 */
function extractEgoCognition(msg: StandardMessage): Cognition | undefined {
  const meta = msg.channel.metadata as Record<string, unknown> | undefined;
  const raw = meta?.['_egoCognition'];
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Partial<Cognition>;
  if (
    typeof c.egoRelevance !== 'number' ||
    typeof c.situationSummary !== 'string' ||
    !Array.isArray(c.opportunities) ||
    !Array.isArray(c.risks) ||
    !Array.isArray(c.relevantMemoryIndices)
  ) {
    return undefined;
  }
  return c as Cognition;
}

/**
 * Lift EGO `goalUpdates[]` into ReasoningContext. Filters out malformed
 * entries; returns an empty array if the metadata is absent so callers can
 * rely on `.length` checks without null-guarding.
 */
function extractEgoGoalUpdates(msg: StandardMessage): GoalUpdate[] {
  const meta = msg.channel.metadata as Record<string, unknown> | undefined;
  const raw = meta?.['_egoGoalUpdates'];
  if (!Array.isArray(raw)) return [];
  const out: GoalUpdate[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const u = item as Partial<GoalUpdate>;
    if (typeof u.goalId !== 'string' || typeof u.progressDelta !== 'number') continue;
    out.push(u as GoalUpdate);
  }
  return out;
}

function extractEgoEnrichment(msg: StandardMessage): {
  addContext?: string;
  addInstructions?: string;
  memories?: string[];
  suggestedTools?: string[];
} | undefined {
  const meta = msg.channel.metadata as Record<string, unknown> | undefined;
  const raw = meta?.['_egoEnrichment'];
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;
  const out: {
    addContext?: string;
    addInstructions?: string;
    memories?: string[];
    suggestedTools?: string[];
  } = {};
  if (typeof rec['addContext'] === 'string') out.addContext = rec['addContext'];
  if (typeof rec['addInstructions'] === 'string') out.addInstructions = rec['addInstructions'];
  if (Array.isArray(rec['addMemories'])) {
    out.memories = rec['addMemories'].filter((m): m is string => typeof m === 'string');
  }
  if (Array.isArray(rec['suggestTools'])) {
    const tools = rec['suggestTools'].filter((t): t is string => typeof t === 'string');
    if (tools.length > 0) out.suggestedTools = tools;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
