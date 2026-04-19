import { Type, type Static } from '@sinclair/typebox';

export const Permission = Type.Union([
  Type.Object({
    type: Type.Literal('filesystem'),
    access: Type.Union([Type.Literal('read'), Type.Literal('write')]),
    paths: Type.Array(Type.String()),
  }),
  Type.Object({
    type: Type.Literal('network'),
    access: Type.Literal('outbound'),
    domains: Type.Array(Type.String()),
  }),
  Type.Object({
    type: Type.Literal('process'),
    access: Type.Literal('execute'),
    commands: Type.Array(Type.String()),
  }),
  Type.Object({
    type: Type.Literal('browser'),
    access: Type.Literal('navigate'),
    scope: Type.Union([Type.Literal('sandboxed'), Type.Literal('full')]),
  }),
  Type.Object({
    type: Type.Literal('system'),
    access: Type.Union([
      Type.Literal('notify'),
      Type.Literal('clipboard'),
      Type.Literal('camera'),
      Type.Literal('location'),
    ]),
  }),
]);
export type Permission = Static<typeof Permission>;

export const ToolCapability = Type.Object({
  tool: Type.String(),
  permissions: Type.Array(Permission),
  riskLevel: Type.Union([
    Type.Literal('low'),
    Type.Literal('medium'),
    Type.Literal('high'),
    Type.Literal('critical'),
  ]),
  sandboxRequired: Type.Boolean(),
  description: Type.String(),
});
export type ToolCapability = Static<typeof ToolCapability>;

export const SessionPolicy = Type.Object({
  sessionId: Type.String(),
  trustLevel: Type.Union([
    Type.Literal('owner'),
    Type.Literal('trusted'),
    Type.Literal('untrusted'),
  ]),
  grantedCapabilities: Type.Array(Type.String()),
  deniedCapabilities: Type.Array(Type.String()),
  sandboxMode: Type.Union([
    Type.Literal('always'),
    Type.Literal('non-owner'),
    Type.Literal('never'),
  ]),
  resourceLimits: Type.Object({
    maxCpuSeconds: Type.Number({ minimum: 0 }),
    maxMemoryMb: Type.Number({ minimum: 0 }),
    maxDiskMb: Type.Number({ minimum: 0 }),
    networkEnabled: Type.Boolean(),
  }),
});
export type SessionPolicy = Static<typeof SessionPolicy>;

export const CapabilityDecision = Type.Union([
  Type.Object({ allowed: Type.Literal(true) }),
  Type.Object({
    allowed: Type.Literal(false),
    reason: Type.String(),
    suggestEscalation: Type.Boolean(),
  }),
]);
export type CapabilityDecision = Static<typeof CapabilityDecision>;
