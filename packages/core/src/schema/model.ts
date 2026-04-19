import { Type, type Static } from '@sinclair/typebox';

export const StreamChunk = Type.Union([
  Type.Object({
    type: Type.Literal('text_delta'),
    text: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('tool_call_start'),
    id: Type.String(),
    name: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('tool_call_delta'),
    id: Type.String(),
    args: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('tool_call_end'),
    id: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('usage'),
    inputTokens: Type.Integer({ minimum: 0 }),
    outputTokens: Type.Integer({ minimum: 0 }),
    cost: Type.Optional(Type.Number({ minimum: 0 })),
  }),
  Type.Object({
    type: Type.Literal('done'),
    stopReason: Type.String(),
  }),
]);
export type StreamChunk = Static<typeof StreamChunk>;

export const ModelInfo = Type.Object({
  provider: Type.String(),
  model: Type.String(),
  contextWindow: Type.Integer({ minimum: 1 }),
  maxOutputTokens: Type.Integer({ minimum: 1 }),
  pricing: Type.Optional(
    Type.Object({
      inputPerMillion: Type.Number({ minimum: 0 }),
      outputPerMillion: Type.Number({ minimum: 0 }),
    }),
  ),
});
export type ModelInfo = Static<typeof ModelInfo>;

export const ProviderHealth = Type.Object({
  healthy: Type.Boolean(),
  latencyMs: Type.Optional(Type.Number({ minimum: 0 })),
  lastCheckedAt: Type.Integer({ minimum: 0 }),
  message: Type.Optional(Type.String()),
});
export type ProviderHealth = Static<typeof ProviderHealth>;
