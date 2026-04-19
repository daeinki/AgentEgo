import { createHmac, randomBytes } from 'node:crypto';

/**
 * Device pairing codes + session tokens.
 *
 * A pairing code is short (6 chars, base32), shown once by the device UI and
 * the platform. They must match for pairing to succeed. After success, the
 * platform issues a long-lived session token that the device stores and
 * presents on future reconnects.
 *
 * Tokens are HMAC-SHA256 of `<deviceId>:<issuedAtSec>` using the platform's
 * shared secret. Stateless, so server restart doesn't invalidate them.
 */

export interface TokenMint {
  mint(deviceId: string, issuedAtSec?: number): string;
  verify(deviceId: string, token: string): boolean;
}

const BASE32_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // omits 0/O/1/I/L/U

export function generatePairingCode(): string {
  const bytes = randomBytes(6);
  let out = '';
  for (const b of bytes) {
    out += BASE32_ALPHABET[b % BASE32_ALPHABET.length] ?? '?';
  }
  return out;
}

export function createTokenMint(secret: string): TokenMint {
  return {
    mint(deviceId: string, issuedAtSec = Math.floor(Date.now() / 1000)): string {
      const mac = createHmac('sha256', secret).update(`${deviceId}:${issuedAtSec}`).digest('hex');
      return `${issuedAtSec}.${mac}`;
    },
    verify(deviceId: string, token: string): boolean {
      const dot = token.indexOf('.');
      if (dot < 0) return false;
      const issuedAt = Number(token.slice(0, dot));
      const macPart = token.slice(dot + 1);
      if (!Number.isFinite(issuedAt)) return false;
      const expected = createHmac('sha256', secret)
        .update(`${deviceId}:${issuedAt}`)
        .digest('hex');
      return expected === macPart;
    },
  };
}
