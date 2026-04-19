import { Type, type Static } from '@sinclair/typebox';
import { ReasoningMode } from './reasoning.js';

// ─── Phase event (ADR-010 / harness-engineering.md §3.1.4) ─────────────────
//
// PhaseEvent is the UI-facing, phase-only stream that the gateway pumps via
// the JSON-RPC 2.0 `chat.phase` notification. Unlike OTel spans or audit logs,
// it is ephemeral (not persisted) and carries no rationale/thought text —
// only the "surface" of the agent's current work.

export const Phase = Type.Union([
  Type.Literal('received'),
  Type.Literal('ego_judging'),
  Type.Literal('reasoning_route'),
  Type.Literal('planning'),
  Type.Literal('executing_step'),
  Type.Literal('tool_call'),
  Type.Literal('waiting_tool'),
  Type.Literal('replan'),
  Type.Literal('streaming_response'),
  Type.Literal('finalizing'),
  Type.Literal('complete'),
  Type.Literal('aborted'),
  Type.Literal('error'),
]);
export type Phase = Static<typeof Phase>;

export const PhaseEventDetail = Type.Object({
  toolName: Type.Optional(Type.String()),
  stepIndex: Type.Optional(Type.Integer({ minimum: 1 })),
  totalSteps: Type.Optional(Type.Integer({ minimum: 1 })),
  egoDecisionId: Type.Optional(Type.String()),
  reasoningMode: Type.Optional(ReasoningMode),
  attemptNumber: Type.Optional(Type.Integer({ minimum: 1 })),
  errorCode: Type.Optional(Type.String()),
});
export type PhaseEventDetail = Static<typeof PhaseEventDetail>;

export const PhaseEvent = Type.Object({
  turnId: Type.String({ minLength: 1 }),
  sessionId: Type.String({ minLength: 1 }),
  seq: Type.Integer({ minimum: 0 }),
  at: Type.Integer({ minimum: 0 }),
  phase: Phase,
  elapsedMs: Type.Integer({ minimum: 0 }),
  detail: Type.Optional(PhaseEventDetail),
});
export type PhaseEvent = Static<typeof PhaseEvent>;

// Terminal phases — after one of these fires, no further PhaseEvent for the turn.
export const TERMINAL_PHASES: readonly Phase[] = Object.freeze([
  'complete',
  'aborted',
  'error',
]);

export function isTerminalPhase(phase: Phase): boolean {
  return TERMINAL_PHASES.includes(phase);
}
