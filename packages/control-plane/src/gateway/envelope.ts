import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { Schemas } from '@agent-platform/core';

const { StandardMessage } = Schemas.MessageSchema;

/**
 * Inbound WebSocket envelope — a request from a channel adapter or CLI to the
 * control plane.
 */
export const InboundEnvelope = Type.Union([
  Type.Object({
    type: Type.Literal('submit_message'),
    message: StandardMessage,
  }),
  Type.Object({
    type: Type.Literal('ping'),
    sentAt: Type.Number(),
  }),
  Type.Object({
    type: Type.Literal('close'),
  }),
]);
export type InboundEnvelope = Static<typeof InboundEnvelope>;

/**
 * Outbound WebSocket envelope — events the control plane emits to a connected
 * client.
 */
export const OutboundEnvelope = Type.Union([
  Type.Object({
    type: Type.Literal('accepted'),
    messageId: Type.String(),
    traceId: Type.String(),
    routedTo: Type.Object({
      agentId: Type.String(),
      sessionId: Type.String(),
    }),
  }),
  Type.Object({
    type: Type.Literal('response_delta'),
    traceId: Type.String(),
    text: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('response_done'),
    traceId: Type.String(),
    inputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    outputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    costUsd: Type.Optional(Type.Number({ minimum: 0 })),
  }),
  Type.Object({
    type: Type.Literal('error'),
    traceId: Type.Optional(Type.String()),
    code: Type.String(),
    message: Type.String(),
  }),
  Type.Object({
    type: Type.Literal('pong'),
    sentAt: Type.Number(),
    receivedAt: Type.Number(),
  }),
]);
export type OutboundEnvelope = Static<typeof OutboundEnvelope>;

export function parseInbound(raw: string): InboundEnvelope | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'invalid JSON' };
  }
  if (!Value.Check(InboundEnvelope, parsed)) {
    const errors = [...Value.Errors(InboundEnvelope, parsed)].slice(0, 3);
    return {
      error: `envelope schema mismatch: ${errors.map((e) => `${e.path}:${e.message}`).join('; ')}`,
    };
  }
  return parsed;
}

export function encodeOutbound(env: OutboundEnvelope): string {
  return JSON.stringify(env);
}
