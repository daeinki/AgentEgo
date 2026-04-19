import { describe, it, expect } from 'vitest';
import { decodeBrowserInbound, encodeBrowserOutbound } from './envelope.js';

describe('browser envelopes', () => {
  it('decodes a valid say envelope', () => {
    const res = decodeBrowserInbound(JSON.stringify({ type: 'say', text: 'hi', clientMessageId: 'c1' }));
    expect('error' in res).toBe(false);
    if (!('error' in res)) {
      expect(res.type).toBe('say');
      if (res.type === 'say') {
        expect(res.text).toBe('hi');
        expect(res.clientMessageId).toBe('c1');
      }
    }
  });

  it('decodes identify without displayName', () => {
    const res = decodeBrowserInbound(JSON.stringify({ type: 'identify', userId: 'u-1' }));
    expect('error' in res).toBe(false);
  });

  it('decodes ping', () => {
    const res = decodeBrowserInbound(JSON.stringify({ type: 'ping', sentAt: 42 }));
    expect('error' in res).toBe(false);
  });

  it('rejects malformed JSON', () => {
    expect('error' in decodeBrowserInbound('{not json')).toBe(true);
  });

  it('rejects unknown envelope types', () => {
    expect('error' in decodeBrowserInbound(JSON.stringify({ type: 'whatever' }))).toBe(true);
  });

  it('rejects say without text', () => {
    expect('error' in decodeBrowserInbound(JSON.stringify({ type: 'say' }))).toBe(true);
  });

  it('encodes outbound envelopes as JSON', () => {
    const raw = encodeBrowserOutbound({ type: 'delta', traceId: 't-1', text: 'hello' });
    expect(JSON.parse(raw)).toEqual({ type: 'delta', traceId: 't-1', text: 'hello' });
  });
});
