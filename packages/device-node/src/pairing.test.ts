import { describe, it, expect } from 'vitest';
import { createTokenMint, generatePairingCode } from './pairing.js';

describe('generatePairingCode', () => {
  it('returns a 6-char base32 string', () => {
    const code = generatePairingCode();
    expect(code).toHaveLength(6);
    expect(code).toMatch(/^[A-Z2-9]+$/);
  });
  it('is reasonably random across many calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) seen.add(generatePairingCode());
    expect(seen.size).toBeGreaterThan(80);
  });
});

describe('createTokenMint', () => {
  it('mints a token and verifies it', () => {
    const mint = createTokenMint('secret-1');
    const token = mint.mint('dev-1', 1700000000);
    expect(mint.verify('dev-1', token)).toBe(true);
  });
  it('rejects wrong device id', () => {
    const mint = createTokenMint('secret-1');
    const token = mint.mint('dev-1', 1700000000);
    expect(mint.verify('dev-2', token)).toBe(false);
  });
  it('rejects wrong secret', () => {
    const a = createTokenMint('secret-1');
    const b = createTokenMint('secret-2');
    const token = a.mint('dev-1', 1700000000);
    expect(b.verify('dev-1', token)).toBe(false);
  });
  it('rejects malformed tokens', () => {
    const mint = createTokenMint('secret-1');
    expect(mint.verify('dev', 'not-a-token')).toBe(false);
    expect(mint.verify('dev', '')).toBe(false);
  });
});
