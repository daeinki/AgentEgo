/**
 * Discord Gateway v10 opcodes.
 * https://discord.com/developers/docs/topics/opcodes-and-status-codes#gateway
 */
export const GatewayOp = {
  Dispatch: 0,
  Heartbeat: 1,
  Identify: 2,
  Resume: 6,
  Reconnect: 7,
  InvalidSession: 9,
  Hello: 10,
  HeartbeatAck: 11,
} as const;

export type GatewayOp = (typeof GatewayOp)[keyof typeof GatewayOp];

export interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

export const DEFAULT_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';

/**
 * Gateway Intent bit flags. Only the handful relevant for a text bot are
 * named; see the Discord docs for the full list.
 */
export const Intent = {
  Guilds: 1 << 0,
  GuildMessages: 1 << 9,
  DirectMessages: 1 << 12,
  MessageContent: 1 << 15,
} as const;

export function combineIntents(...intents: number[]): number {
  return intents.reduce((acc, i) => acc | i, 0);
}
