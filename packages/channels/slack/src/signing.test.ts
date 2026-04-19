import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifySlackSignature } from './signing.js';

function sign(body: string, ts: string, secret: string): string {
  const base = `v0:${ts}:${body}`;
  const mac = createHmac('sha256', secret).update(base).digest('hex');
  return `v0=${mac}`;
}

describe('verifySlackSignature', () => {
  const secret = 'test-secret';

  it('accepts a valid signature', () => {
    const body = '{"type":"url_verification","challenge":"x"}';
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign(body, ts, secret);
    expect(
      verifySlackSignature({ signingSecret: secret, timestamp: ts, signature: sig, body }),
    ).toBe(true);
  });

  it('rejects tampered body', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign('original', ts, secret);
    expect(
      verifySlackSignature({ signingSecret: secret, timestamp: ts, signature: sig, body: 'tampered' }),
    ).toBe(false);
  });

  it('rejects old timestamps (replay)', () => {
    const nowMs = 1_700_000_000_000;
    const ts = String(Math.floor(nowMs / 1000) - 10 * 60); // 10 min ago
    const sig = sign('body', ts, secret);
    expect(
      verifySlackSignature({ signingSecret: secret, timestamp: ts, signature: sig, body: 'body', nowMs }),
    ).toBe(false);
  });

  it('rejects malformed timestamp', () => {
    expect(
      verifySlackSignature({
        signingSecret: secret,
        timestamp: 'not-a-number',
        signature: 'v0=ff',
        body: 'b',
      }),
    ).toBe(false);
  });

  it('rejects wrong secret', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign('body', ts, 'other-secret');
    expect(
      verifySlackSignature({ signingSecret: secret, timestamp: ts, signature: sig, body: 'body' }),
    ).toBe(false);
  });
});
