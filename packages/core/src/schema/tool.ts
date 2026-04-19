import { Type, type Static } from '@sinclair/typebox';

export const ToolResult = Type.Object({
  toolName: Type.String(),
  success: Type.Boolean(),
  output: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  durationMs: Type.Number({ minimum: 0 }),
  resourceUsage: Type.Optional(
    Type.Object({
      cpuSeconds: Type.Number({ minimum: 0 }),
      memoryMb: Type.Number({ minimum: 0 }),
    }),
  ),
});
export type ToolResult = Static<typeof ToolResult>;
