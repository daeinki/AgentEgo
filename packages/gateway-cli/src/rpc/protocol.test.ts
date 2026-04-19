import { describe, expect, it } from 'vitest';
import {
  encodeFrame,
  errorFrame,
  notification,
  parseInbound,
  RpcError,
  RpcErrorCode,
  successFrame,
} from './protocol.js';

describe('parseInbound', () => {
  it('rejects non-JSON input with ParseError', () => {
    const res = parseInbound('not json');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.error.code).toBe(RpcErrorCode.ParseError);
      expect(res.error.id).toBeNull();
    }
  });

  it('rejects arrays (batch not supported)', () => {
    const res = parseInbound('[]');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.error.code).toBe(RpcErrorCode.InvalidRequest);
  });

  it('rejects missing jsonrpc version', () => {
    const res = parseInbound('{"method":"x","id":1}');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.error.code).toBe(RpcErrorCode.InvalidRequest);
  });

  it('parses a well-formed request', () => {
    const res = parseInbound(
      '{"jsonrpc":"2.0","id":"abc","method":"chat.send","params":{"text":"hi"}}',
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.parsed.isNotification).toBe(false);
      expect(res.parsed.frame.method).toBe('chat.send');
      // @ts-expect-error id only on request
      expect(res.parsed.frame.id).toBe('abc');
    }
  });

  it('treats missing id as notification', () => {
    const res = parseInbound('{"jsonrpc":"2.0","method":"ping"}');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.parsed.isNotification).toBe(true);
  });

  it('flags non-string, non-number ids as invalid', () => {
    const res = parseInbound('{"jsonrpc":"2.0","id":{"nested":true},"method":"x"}');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.error.code).toBe(RpcErrorCode.InvalidRequest);
  });
});

describe('frame encoding', () => {
  it('encodes success frames', () => {
    const s = JSON.parse(encodeFrame(successFrame('id-1', { ok: true })));
    expect(s).toEqual({ jsonrpc: '2.0', id: 'id-1', result: { ok: true } });
  });

  it('encodes error frames with and without data', () => {
    const withData = JSON.parse(encodeFrame(errorFrame(1, -32000, 'fail', { cause: 'x' })));
    expect(withData.error).toEqual({ code: -32000, message: 'fail', data: { cause: 'x' } });

    const noData = JSON.parse(encodeFrame(errorFrame(null, RpcErrorCode.ParseError, 'bad')));
    expect(noData.error).toEqual({ code: RpcErrorCode.ParseError, message: 'bad' });
    expect(noData.error).not.toHaveProperty('data');
  });

  it('encodes notifications (no id)', () => {
    const n = JSON.parse(encodeFrame(notification('chat.delta', { text: 'hi' })));
    expect(n).toEqual({ jsonrpc: '2.0', method: 'chat.delta', params: { text: 'hi' } });
    expect(n).not.toHaveProperty('id');
  });
});

describe('RpcError', () => {
  it('round-trips through toPayload', () => {
    const err = new RpcError(RpcErrorCode.NotFound, 'missing', { sessionId: 's' });
    expect(err.toPayload()).toEqual({
      code: RpcErrorCode.NotFound,
      message: 'missing',
      data: { sessionId: 's' },
    });
  });

  it('omits data when undefined', () => {
    const err = new RpcError(RpcErrorCode.InvalidParams, 'bad');
    expect(err.toPayload()).toEqual({
      code: RpcErrorCode.InvalidParams,
      message: 'bad',
    });
  });
});
