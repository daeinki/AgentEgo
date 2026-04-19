import { Type, type Static } from '@sinclair/typebox';

export const TraceContext = Type.Object({
  traceId: Type.String(),
  spanId: Type.String(),
  parentSpanId: Type.Optional(Type.String()),
});
export type TraceContext = Static<typeof TraceContext>;

export const TurnMetrics = Type.Object({
  traceId: Type.String(),
  sessionId: Type.String(),
  agentId: Type.String(),
  channelType: Type.String(),
  model: Type.String(),
  inputTokens: Type.Integer({ minimum: 0 }),
  outputTokens: Type.Integer({ minimum: 0 }),
  estimatedCostUsd: Type.Number({ minimum: 0 }),
  firstTokenLatencyMs: Type.Number({ minimum: 0 }),
  totalLatencyMs: Type.Number({ minimum: 0 }),
  toolCallCount: Type.Integer({ minimum: 0 }),
  toolCallLatencyMs: Type.Array(Type.Number({ minimum: 0 })),
  retryCount: Type.Integer({ minimum: 0 }),
  failoverTriggered: Type.Boolean(),
  compactionTriggered: Type.Boolean(),
});
export type TurnMetrics = Static<typeof TurnMetrics>;

export const AuditTag = Type.Union([
  Type.Literal('ego_runtime_error'),
  Type.Literal('ego_timeout'),
  Type.Literal('llm_invalid_json'),
  Type.Literal('llm_schema_mismatch'),
  Type.Literal('llm_out_of_range'),
  Type.Literal('llm_inconsistent_action'),
  Type.Literal('llm_invalid_target'),
  Type.Literal('llm_timeout'),
  Type.Literal('llm_provider_error'),
  Type.Literal('ego_circuit_open'),
  Type.Literal('daily_cost_cap_hit'),
  Type.Literal('ego_state_transition'),
  Type.Literal('ego_redirect'),
  Type.Literal('memory_timeout'),
  Type.Literal('persona_snapshot_truncated'),
  Type.Literal('persona_field_saturated'),
  Type.Literal('ego_decision'),
]);
export type AuditTag = Static<typeof AuditTag>;

export const AuditEntry = Type.Object({
  timestamp: Type.Integer({ minimum: 0 }),
  traceId: Type.String(),
  tag: AuditTag,
  actor: Type.Union([Type.Literal('user'), Type.Literal('agent'), Type.Literal('system'), Type.Literal('ego')]),
  action: Type.String(),
  target: Type.Optional(Type.String()),
  parameters: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  result: Type.Union([
    Type.Literal('success'),
    Type.Literal('denied'),
    Type.Literal('error'),
    Type.Literal('passthrough'),
  ]),
  riskLevel: Type.Union([
    Type.Literal('low'),
    Type.Literal('medium'),
    Type.Literal('high'),
    Type.Literal('critical'),
  ]),
  sessionId: Type.Optional(Type.String()),
  agentId: Type.Optional(Type.String()),
  egoDecisionId: Type.Optional(Type.String()),
});
export type AuditEntry = Static<typeof AuditEntry>;
