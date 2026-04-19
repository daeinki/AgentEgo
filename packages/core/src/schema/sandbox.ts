import { Type, type Static } from '@sinclair/typebox';

export const SandboxInstance = Type.Object({
  id: Type.String(),
  status: Type.Union([
    Type.Literal('ready'),
    Type.Literal('running'),
    Type.Literal('terminated'),
  ]),
  startedAt: Type.Integer({ minimum: 0 }),
  resourceUsage: Type.Object({
    cpuSeconds: Type.Number({ minimum: 0 }),
    memoryMb: Type.Number({ minimum: 0 }),
    diskMb: Type.Number({ minimum: 0 }),
  }),
});
export type SandboxInstance = Static<typeof SandboxInstance>;
