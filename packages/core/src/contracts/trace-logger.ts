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
 *   M1 — ModelAdapter (reserved; Phase B)
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
  | 'M1';

/** A single recorded event inside a traced turn. */
export interface TraceEvent {
  traceId: string;
  sessionId?: string;
  agentId?: string;
  block: TraceBlock;
  /**
   * Event name — free-form within a block. Common verbs:
   *   `enter` / `exit` — span boundaries (exit sets durationMs).
   *   `decision` — block made a judgment (EGO action, router agent, …).
   *   `tool_call`, `step_start`, `step_end`, `mode_selected`,
   *   `plan_generated`, `replan`, `downgraded_to_react`, `error`.
   */
  event: string;
  timestamp: number;
  /** Set on `exit` events or span completions. */
  durationMs?: number;
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
  payload?: Record<string, unknown>;
}

/**
 * ADR-010: agent turn 루프가 발산하는 canonical 이벤트 이름. harness-engineering.md
 * §3.3.1.6 의 관측 어휘 표와 1:1 대응. 문자열 자체를 고정해 다운스트림 로그 해석기의
 * 키 역할을 한다. 구현체는 이 이름들로 `event` 필드를 채워야 한다.
 */
export const TraceEventNames = {
  SESSION_RESOLVED: 'session_resolved',
  HISTORY_LOADED: 'history_loaded',
  MEMORY_SEARCHED: 'memory_searched',
  PROMPT_BUILT: 'prompt_built',
  REASONER_INVOKED: 'reasoner_invoked',
  REASONING_STEP: 'reasoning.step',
  REASONING_PLAN: 'reasoning.plan',
  REASONING_REPLAN: 'reasoning.replan',
  STREAM_DONE: 'stream_done',
  SESSION_EVENTS_APPENDED: 'session_events_appended',
  SESSION_APPEND_FAILED: 'session_append_failed',
  MEMORY_INGESTED: 'memory_ingested',
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
