import { Type, type Static } from '@sinclair/typebox';

export const SystemLayer = Type.Object({
  name: Type.String(),
  priority: Type.Integer(),
  content: Type.String(),
  source: Type.Union([
    Type.Literal('builtin'),
    Type.Literal('workspace'),
    Type.Literal('skill'),
    Type.Literal('memory'),
  ]),
});
export type SystemLayer = Static<typeof SystemLayer>;

export const ToolDefinition = Type.Object({
  name: Type.String(),
  description: Type.String(),
  inputSchema: Type.Record(Type.String(), Type.Unknown()),
});
export type ToolDefinition = Static<typeof ToolDefinition>;

export const BuiltPrompt = Type.Object({
  systemLayers: Type.Array(SystemLayer),
  conversationHistory: Type.Array(
    Type.Object({
      role: Type.String(),
      content: Type.String(),
    }),
  ),
  userMessage: Type.Object({
    role: Type.String(),
    content: Type.String(),
  }),
  toolDefinitions: Type.Array(ToolDefinition),
  metadata: Type.Object({
    estimatedTokens: Type.Integer({ minimum: 0 }),
    contextBudget: Type.Integer({ minimum: 0 }),
    truncationApplied: Type.Boolean(),
  }),
});
export type BuiltPrompt = Static<typeof BuiltPrompt>;
