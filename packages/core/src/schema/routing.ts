import { Type, type Static } from '@sinclair/typebox';
import { ChannelType } from '../types/message.js';

export const RouteDecision = Type.Object({
  agentId: Type.String(),
  sessionId: Type.String(),
  workerId: Type.Optional(Type.String()),
  priority: Type.Integer({ minimum: 0 }),
  capabilities: Type.Array(Type.String()),
});
export type RouteDecision = Static<typeof RouteDecision>;

export const RoutingRule = Type.Object({
  id: Type.String(),
  conditions: Type.Object({
    channelType: Type.Optional(Type.Array(ChannelType)),
    senderIds: Type.Optional(Type.Array(Type.String())),
    conversationIds: Type.Optional(Type.Array(Type.String())),
    contentPattern: Type.Optional(Type.String()),
  }),
  target: Type.Object({
    agentId: Type.String(),
    workspaceId: Type.Optional(Type.String()),
  }),
  priority: Type.Integer(),
});
export type RoutingRule = Static<typeof RoutingRule>;
