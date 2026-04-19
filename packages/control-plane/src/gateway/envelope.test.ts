import { describe, it, expect } from 'vitest';
import { parseInbound, encodeOutbound } from './envelope.js';
import type { StandardMessage } from '@agent-platform/core';
import { generateMessageId, generateTraceId, nowMs } from '@agent-platform/core';

function makeMessage(): StandardMessage {
  return {
    id: generateMessageId(),
    traceId: generateTraceId(),
    timestamp: nowMs(),
    channel: { type: 'webchat', id: 'w-1', metadata: {} },
    sender: { id: 'user-1', isOwner: true },
    conversation: { type: 'dm', id: 'c-1' },
    content: { type: 'text', text: 'hello' },
  };
}

describe('Gateway envelopes', () => {
  it('parses a valid submit_message envelope', () => {
    const raw = JSON.stringify({ type: 'submit_message', message: makeMessage() });
    const out = parseInbound(raw);
    expect('error' in out).toBe(false);
    if (!('error' in out)) {
      expect(out.type).toBe('submit_message');
    }
  });

  it('parses ping/close', () => {
    const pingRes = parseInbound(JSON.stringify({ type: 'ping', sentAt: 1 }));
    expect('error' in pingRes).toBe(false);
    const closeRes = parseInbound(JSON.stringify({ type: 'close' }));
    expect('error' in closeRes).toBe(false);
  });

  it('rejects malformed JSON', () => {
    const res = parseInbound('{not json');
    expect('error' in res).toBe(true);
  });

  it('rejects unknown envelope type', () => {
    const res = parseInbound(JSON.stringify({ type: 'burninate' }));
    expect('error' in res).toBe(true);
  });

  it('rejects submit_message with missing fields', () => {
    const res = parseInbound(JSON.stringify({ type: 'submit_message', message: { id: 'x' } }));
    expect('error' in res).toBe(true);
  });

  it('encodeOutbound round-trips JSON', () => {
    const env = encodeOutbound({ type: 'pong', sentAt: 1, receivedAt: 2 });
    expect(JSON.parse(env)).toEqual({ type: 'pong', sentAt: 1, receivedAt: 2 });
  });
});
