import type { OutboundContent } from '@agent-platform/core';

/**
 * Browser-facing envelope. The webchat UI talks this shape; the adapter
 * translates it to/from the internal `StandardMessage`.
 */
export type BrowserInbound =
  | { type: 'say'; text: string; clientMessageId?: string }
  | { type: 'identify'; userId: string; displayName?: string }
  | { type: 'ping'; sentAt: number };

export type BrowserOutbound =
  | { type: 'accepted'; clientMessageId?: string; traceId: string }
  | { type: 'delta'; traceId: string; text: string }
  | { type: 'done'; traceId: string }
  | { type: 'error'; message: string; traceId?: string }
  | { type: 'pong'; sentAt: number; receivedAt: number }
  | { type: 'system'; text: string }
  | { type: 'out'; content: OutboundContent };

export function decodeBrowserInbound(raw: string): BrowserInbound | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'invalid JSON' };
  }
  if (!parsed || typeof parsed !== 'object') return { error: 'envelope not an object' };
  const rec = parsed as Record<string, unknown>;
  if (rec['type'] === 'say' && typeof rec['text'] === 'string') {
    const out: BrowserInbound = { type: 'say', text: rec['text'] };
    if (typeof rec['clientMessageId'] === 'string') out.clientMessageId = rec['clientMessageId'];
    return out;
  }
  if (rec['type'] === 'identify' && typeof rec['userId'] === 'string') {
    const out: BrowserInbound = { type: 'identify', userId: rec['userId'] };
    if (typeof rec['displayName'] === 'string') out.displayName = rec['displayName'];
    return out;
  }
  if (rec['type'] === 'ping' && typeof rec['sentAt'] === 'number') {
    return { type: 'ping', sentAt: rec['sentAt'] };
  }
  return { error: `unknown envelope type: ${String(rec['type'])}` };
}

export function encodeBrowserOutbound(env: BrowserOutbound): string {
  return JSON.stringify(env);
}
