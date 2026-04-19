import { describe, it, expect } from 'vitest';
import { parseInbound, encodeOutbound } from './protocol.js';

describe('parseInbound', () => {
  it('accepts a valid hello envelope', () => {
    const res = parseInbound(
      JSON.stringify({
        type: 'hello',
        deviceId: 'd-1',
        pairingCode: 'AB12CD',
        info: { deviceId: 'd-1', platform: 'macos' },
      }),
    );
    expect('error' in res).toBe(false);
    if (!('error' in res)) expect(res.type).toBe('hello');
  });
  it('rejects hello missing info', () => {
    const res = parseInbound(JSON.stringify({ type: 'hello', deviceId: 'd', pairingCode: 'C' }));
    expect('error' in res).toBe(true);
  });
  it('accepts heartbeat with optional battery', () => {
    const res = parseInbound(JSON.stringify({ type: 'heartbeat', sentAt: 123, batteryLevel: 0.8 }));
    expect('error' in res).toBe(false);
  });
  it('accepts a message envelope', () => {
    const res = parseInbound(JSON.stringify({ type: 'message', text: '안녕', clientMessageId: 'c1' }));
    expect('error' in res).toBe(false);
  });
  it('accepts an ack envelope', () => {
    const res = parseInbound(JSON.stringify({ type: 'ack', pushId: 'p1', receivedAt: 200 }));
    expect('error' in res).toBe(false);
  });
  it('rejects malformed JSON', () => {
    expect('error' in parseInbound('{not json')).toBe(true);
  });
  it('rejects unknown type', () => {
    expect('error' in parseInbound(JSON.stringify({ type: 'whatever' }))).toBe(true);
  });
});

describe('encodeOutbound', () => {
  it('round-trips a paired envelope', () => {
    const raw = encodeOutbound({ type: 'paired', deviceId: 'd', sessionToken: 't' });
    expect(JSON.parse(raw)).toEqual({ type: 'paired', deviceId: 'd', sessionToken: 't' });
  });
  it('encodes a push envelope', () => {
    const raw = encodeOutbound({
      type: 'push',
      pushId: 'p1',
      title: 'Hi',
      body: 'world',
    });
    expect(JSON.parse(raw).type).toBe('push');
  });
});
