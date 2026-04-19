import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RateLimiter } from './rate-limiter.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests up to capacity', () => {
    const rl = new RateLimiter({ capacity: 3, refillPerSecond: 1 });
    expect(rl.take('k')).toBe(true);
    expect(rl.take('k')).toBe(true);
    expect(rl.take('k')).toBe(true);
    expect(rl.take('k')).toBe(false);
  });

  it('refills at refillPerSecond rate', () => {
    const rl = new RateLimiter({ capacity: 2, refillPerSecond: 2 });
    rl.take('k');
    rl.take('k');
    expect(rl.take('k')).toBe(false);
    vi.advanceTimersByTime(500); // 0.5s × 2 tok/s = 1 token
    expect(rl.take('k')).toBe(true);
  });

  it('keys are independent', () => {
    const rl = new RateLimiter({ capacity: 1, refillPerSecond: 0 });
    expect(rl.take('a')).toBe(true);
    expect(rl.take('a')).toBe(false);
    expect(rl.take('b')).toBe(true);
  });

  it('caps bucket at capacity even with long idle', () => {
    const rl = new RateLimiter({ capacity: 3, refillPerSecond: 1 });
    rl.take('k');
    rl.take('k');
    rl.take('k');
    vi.advanceTimersByTime(60_000); // plenty of idle
    expect(rl.remaining('k')).toBeLessThanOrEqual(3);
  });

  it('reset(key) clears only that key', () => {
    const rl = new RateLimiter({ capacity: 1, refillPerSecond: 0 });
    rl.take('a');
    rl.take('b');
    rl.reset('a');
    expect(rl.take('a')).toBe(true);
    expect(rl.take('b')).toBe(false);
  });
});
