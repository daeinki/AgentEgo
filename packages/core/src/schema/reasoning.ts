import { Type, type Static } from '@sinclair/typebox';

// ─── Enums (ADR-009 / agent-orchestration.md §3.3.1.5) ─────────────────────

export const ReasoningMode = Type.Union([
  Type.Literal('react'),
  Type.Literal('plan_execute'),
]);
export type ReasoningMode = Static<typeof ReasoningMode>;

export const ReasoningStepKind = Type.Union([
  Type.Literal('thought'),
  Type.Literal('tool_call'),
  Type.Literal('observation'),
  Type.Literal('plan'),
  Type.Literal('replan'),
  Type.Literal('final'),
]);
export type ReasoningStepKind = Static<typeof ReasoningStepKind>;

export const TerminationReason = Type.Union([
  Type.Literal('final_answer'),
  Type.Literal('max_steps'),
  Type.Literal('tool_exhaustion'),
  Type.Literal('hard_error'),
  Type.Literal('user_abort'),
  Type.Literal('plan_validation_error'),
]);
export type TerminationReason = Static<typeof TerminationReason>;

const PlanStepStatus = Type.Union([
  Type.Literal('pending'),
  Type.Literal('running'),
  Type.Literal('success'),
  Type.Literal('failed'),
  Type.Literal('skipped'),
]);
export type PlanStepStatus = Static<typeof PlanStepStatus>;

// ─── Reasoning trace ───────────────────────────────────────────────────────

export const ReasoningStep = Type.Object({
  kind: ReasoningStepKind,
  at: Type.Integer({ minimum: 0 }),
  content: Type.Unknown(),
});
export type ReasoningStep = Static<typeof ReasoningStep>;

// ─── Plan (plan_execute mode) ──────────────────────────────────────────────

export const PlanStep = Type.Object({
  id: Type.String({ minLength: 1 }),
  goal: Type.String({ minLength: 1 }),
  tool: Type.Optional(Type.String()),
  args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  dependsOn: Type.Array(Type.String()),
  status: PlanStepStatus,
  observation: Type.Optional(Type.Unknown()),
});
export type PlanStep = Static<typeof PlanStep>;

export const Plan = Type.Object({
  id: Type.String({ minLength: 1 }),
  createdAt: Type.Integer({ minimum: 0 }),
  steps: Type.Array(PlanStep),
  parentPlanId: Type.Optional(Type.String()),
  rationale: Type.String({ maxLength: 500 }),
});
export type Plan = Static<typeof Plan>;

// ─── Budget + state ────────────────────────────────────────────────────────

export const ReasoningBudget = Type.Object({
  maxSteps: Type.Integer({ minimum: 1 }),
  maxToolCalls: Type.Integer({ minimum: 0 }),
  spent: Type.Object({
    steps: Type.Integer({ minimum: 0 }),
    toolCalls: Type.Integer({ minimum: 0 }),
  }),
});
export type ReasoningBudget = Static<typeof ReasoningBudget>;

export const ReasoningState = Type.Object({
  mode: ReasoningMode,
  egoDecisionId: Type.Union([Type.String(), Type.Null()]),
  trace: Type.Array(ReasoningStep),
  plan: Type.Optional(Plan),
  budget: ReasoningBudget,
  terminationReason: Type.Optional(TerminationReason),
});
export type ReasoningState = Static<typeof ReasoningState>;

// Defaults referenced by ComplexityRouter fallbacks and AgentConfig.reasoning
// (agent-orchestration.md §6.1).
export const DEFAULT_REASONING_BUDGET: ReasoningBudget = {
  maxSteps: 8,
  maxToolCalls: 16,
  spent: { steps: 0, toolCalls: 0 },
};
