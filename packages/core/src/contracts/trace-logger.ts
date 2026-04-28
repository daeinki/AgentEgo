/**
 * Pipeline block identifier, matching the block diagram in
 * `visualize_architecture.md`:
 *
 *   G3 — gateway-cli chat.send RPC method
 *   C1 — control-plane RuleRouter
 *   P1 — platform handler (EGO + AgentRunner orchestration)
 *   E1 — EgoLayer.processDetailed
 *   W1 — AgentRunner.processTurn
 *   R1 — HybridReasoner mode selection
 *   R2 — ReactExecutor
 *   R3 — PlanExecuteExecutor
 *   M1 — ModelAdapter (LLM stream lifecycle + token/cost telemetry)
 *   X1 — Memory (PalaceMemorySystem search/ingest)
 *   S1 — Sandbox (acquire/release/execute)
 */
export type TraceBlock =
  | 'G3'
  | 'C1'
  | 'P1'
  | 'E1'
  | 'W1'
  | 'R1'
  | 'R2'
  | 'R3'
  | 'M1'
  | 'X1'
  | 'S1';

/** A single recorded event inside a traced turn. */
export interface TraceEvent {
  traceId: string;
  sessionId?: string;
  agentId?: string;
  block: TraceBlock;
  /**
   * Event name. Prefer one of the canonical names in {@link TraceEventNames}
   * — the type widening (`TraceEventName | (string & {})`) accepts arbitrary
   * strings for forward-compat while giving IDE autocomplete + grep'ability
   * for the standard set. Common verbs:
   *   `enter` / `exit` — span boundaries (exit sets durationMs).
   *   `decision` — block made a judgment (EGO action, router agent, …).
   *   `tool_call`, `step_start`, `step_end`, `mode_selected`,
   *   `plan_generated`, `replan`, `downgraded_to_react`, `error`.
   */
  event: TraceEventName | (string & {});
  timestamp: number;
  /** Set on `exit` events or span completions. */
  durationMs?: number;
  /**
   * Optional one-line natural-language description of what just happened.
   * Recommended for every emitter — it's what `agent trace show` renders
   * as the human-readable column ("EGO judged 'enrich' (confidence=0.82)",
   * "claude-opus-4-7: 1240 out tokens, $0.031, ttft=420ms"). Keep under
   * ~120 chars; longer details belong in `payload`.
   */
  summary?: string;
  /** JSON-serializable block-specific metadata. */
  payload?: Record<string, unknown>;
  /** Error message when the block failed. */
  error?: string;
}

export interface TraceSpanOptions {
  traceId: string;
  sessionId?: string;
  agentId?: string;
  block: TraceBlock;
  /** Defaults to `'enter'`/`'exit'` when omitted; used to specialize. */
  event?: string;
  /** Optional human-readable description; mirrored onto enter+exit events. */
  summary?: string;
  payload?: Record<string, unknown>;
}

/**
 * ADR-010: agent turn 루프가 발산하는 canonical 이벤트 이름. harness-engineering.md
 * §3.3.1.6 의 관측 어휘 표와 1:1 대응. 문자열 자체를 고정해 다운스트림 로그 해석기의
 * 키 역할을 한다. 구현체는 이 이름들로 `event` 필드를 채워야 한다.
 */
export const TraceEventNames = {
  // Generic span boundaries / errors
  ENTER: 'enter',
  EXIT: 'exit',
  ERROR: 'error',
  // Decision-making blocks (G3 / C1 / E1)
  DECISION: 'decision',
  FAST_EXIT: 'fast_exit',
  DEEP_PATH_START: 'deep_path_start',
  // W1 (AgentRunner) turn lifecycle
  SESSION_RESOLVED: 'session_resolved',
  HISTORY_LOADED: 'history_loaded',
  PROMPT_BUILT: 'prompt_built',
  REASONER_INVOKED: 'reasoner_invoked',
  STREAM_DONE: 'stream_done',
  SESSION_EVENTS_APPENDED: 'session_events_appended',
  SESSION_APPEND_FAILED: 'session_append_failed',
  // R1 / R2 / R3 reasoning
  MODE_SELECTED: 'mode_selected',
  REASONING_STEP: 'reasoning.step',
  REASONING_PLAN: 'reasoning.plan',
  REASONING_REPLAN: 'reasoning.replan',
  TOOL_CALL: 'tool_call',
  PLAN_GENERATED: 'plan_generated',
  REPLAN: 'replan',
  DOWNGRADED_TO_REACT: 'downgraded_to_react',
  // M1 ModelAdapter
  STREAM_STARTED: 'stream_started',
  FIRST_TOKEN: 'first_token',
  STREAM_ERROR: 'stream_error',
  // X1 Memory
  MEMORY_SEARCHED: 'memory_searched',
  MEMORY_INGESTED: 'memory_ingested',
  // S1 Sandbox
  SANDBOX_ACQUIRED: 'sandbox_acquired',
  SANDBOX_RELEASED: 'sandbox_released',
  SANDBOX_EXECUTED: 'sandbox_executed',
  // P1 platform supplementary
  SKILL_SEED: 'skill_seed',
  SKILL_SEED_SUMMARY: 'skill_seed_summary',
  SKILL_MOUNT_ERROR: 'skill_mount_error',
} as const;
export type TraceEventName = (typeof TraceEventNames)[keyof typeof TraceEventNames];

/**
 * Structured per-turn trace logger. Injected alongside OTel `withSpan` —
 * both can fire for the same block boundary (OTel for live observability,
 * trace logger for CLI-queryable history).
 *
 * Implementations must never throw from `event()` / `span()` non-wrapped
 * failure modes — trace logging is best-effort and must not break the
 * pipeline.
 */
export interface TraceLogger {
  event(entry: TraceEvent): void;
  span<T>(opts: TraceSpanOptions, fn: () => Promise<T>): Promise<T>;
  close?(): Promise<void>;
}

/**
 * Per-call trace context handed to subsystems (memory, sandbox, model
 * adapter, …) that don't naturally hold a `TraceLogger` reference but want
 * to surface their internals in `agent trace show`. Always optional —
 * subsystems must work silently when omitted.
 *
 * Subtypes (e.g. `ModelTraceContext` in agent-worker) extend this with a
 * `role` field; here we keep the shape minimal so it's safe to import from
 * any package without circular deps.
 */
export interface TraceCallContext {
  traceLogger: TraceLogger;
  traceId: string;
  sessionId?: string;
  agentId?: string;
}

/**
 * No-op trace logger. Used when `AGENT_TRACE=0` or when a caller opts out.
 */
export class NoopTraceLogger implements TraceLogger {
  event(): void {
    /* no-op */
  }
  async span<T>(_opts: TraceSpanOptions, fn: () => Promise<T>): Promise<T> {
    return fn();
  }
  async close(): Promise<void> {
    /* no-op */
  }
}
