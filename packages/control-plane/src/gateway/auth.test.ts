import { describe, it, expect } from 'vitest';
import { TokenAuth } from './auth.js';

describe('TokenAuth', () => {
  it('accepts a valid bearer token', () => {
    const auth = new TokenAuth({ tokens: ['sekrit'] });
    expect(auth.verifyBearer('Bearer sekrit').ok).toBe(true);
  });

  it('rejects a missing header', () => {
    const auth = new TokenAuth({ tokens: ['sekrit'] });
    expect(auth.verifyBearer(undefined).ok).toBe(false);
    expect(auth.verifyBearer('').ok).toBe(false);
  });

  it('rejects a malformed header', () => {
    const auth = new TokenAuth({ tokens: ['sekrit'] });
    expect(auth.verifyBearer('Basic abc').ok).toBe(false);
    expect(auth.verifyBearer('Bearer').ok).toBe(false);
  });

  it('rejects an unknown token', () => {
    const auth = new TokenAuth({ tokens: ['sekrit'] });
    expect(auth.verifyBearer('Bearer other').ok).toBe(false);
  });

  it('accepts any of multiple registered tokens', () => {
    const auth = new TokenAuth({ tokens: ['a', 'b', 'c'] });
    expect(auth.verifyBearer('Bearer a').ok).toBe(true);
    expect(auth.verifyBearer('Bearer b').ok).toBe(true);
    expect(auth.verifyBearer('Bearer c').ok).toBe(true);
    expect(auth.verifyBearer('Bearer d').ok).toBe(false);
  });

  it('requires at least one token at construction time', () => {
    expect(() => new TokenAuth({ tokens: [] })).toThrow();
  });

  it('verifyToken directly works too', () => {
    const auth = new TokenAuth({ tokens: ['x'] });
    expect(auth.verifyToken('x').ok).toBe(true);
    expect(auth.verifyToken('y').ok).toBe(false);
  });
});
