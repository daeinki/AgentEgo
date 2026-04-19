import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Slack's signed request verification (https://api.slack.com/authentication/verifying-requests-from-slack).
 *
 *   v0:{timestamp}:{raw body}
 *   HMAC-SHA256(signingSecret, basestring) → "v0={hex}"
 *
 * Reject if timestamp is older than 5 minutes (replay protection).
 */
export interface VerifyArgs {
  signingSecret: string;
  timestamp: string;
  signature: string;
  body: string;
  /**
   * Override for `Date.now()` — tests inject a fixed clock.
   */
  nowMs?: number;
}

export function verifySlackSignature(args: VerifyArgs): boolean {
  const ts = Number(args.timestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSec = Math.floor((args.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSec - ts) > 60 * 5) return false;

  const basestring = `v0:${args.timestamp}:${args.body}`;
  const mac = createHmac('sha256', args.signingSecret).update(basestring).digest('hex');
  const expected = Buffer.from(`v0=${mac}`, 'utf-8');
  const actual = Buffer.from(args.signature, 'utf-8');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
