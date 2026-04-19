import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CircuitBreaker } from './circuit-breaker.js';

describe('CircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('stays closed on success', () => {
    const cb = new CircuitBreaker({ threshold: 3, cooldownMinutes: 1 });
    cb.recordSuccess();
    cb.recordSuccess();
    expect(cb.snapshot().state).toBe('closed');
    expect(cb.allow()).toBe(true);
  });

  it('trips to open after threshold consecutive failures', () => {
    const cb = new CircuitBreaker({ threshold: 3, cooldownMinutes: 1 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.snapshot().state).toBe('closed');
    cb.recordFailure();
    expect(cb.snapshot().state).toBe('open');
    expect(cb.allow()).toBe(false);
  });

  it('resets failure count on success', () => {
    const cb = new CircuitBreaker({ threshold: 3, cooldownMinutes: 1 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.snapshot().failures).toBe(0);
  });

  it('transitions open → half-open after cooldown', () => {
    const base = new Date('2026-04-17T00:00:00Z');
    vi.setSystemTime(base);
    const cb = new CircuitBreaker({ threshold: 1, cooldownMinutes: 2 });
    cb.recordFailure();
    expect(cb.allow()).toBe(false);
    vi.setSystemTime(new Date(base.getTime() + 60_000));
    expect(cb.allow()).toBe(false);
    vi.setSystemTime(new Date(base.getTime() + 3 * 60_000));
    expect(cb.allow()).toBe(true); // half-open probe
  });

  it('only permits one probe in half-open state', () => {
    const base = new Date('2026-04-17T00:00:00Z');
    vi.setSystemTime(base);
    const cb = new CircuitBreaker({ threshold: 1, cooldownMinutes: 1 });
    cb.recordFailure();
    vi.setSystemTime(new Date(base.getTime() + 2 * 60_000));
    expect(cb.allow()).toBe(true); // first probe
    expect(cb.allow()).toBe(false); // no second probe allowed
  });

  it('on probe success, closes; on probe failure, re-opens', () => {
    const base = new Date('2026-04-17T00:00:00Z');
    vi.setSystemTime(base);
    const cb = new CircuitBreaker({ threshold: 1, cooldownMinutes: 1 });
    cb.recordFailure();
    vi.setSystemTime(new Date(base.getTime() + 2 * 60_000));
    cb.allow();
    cb.recordSuccess();
    expect(cb.snapshot().state).toBe('closed');

    // Re-trip
    const cb2 = new CircuitBreaker({ threshold: 1, cooldownMinutes: 1 });
    cb2.recordFailure();
    vi.setSystemTime(new Date(base.getTime() + 10 * 60_000));
    cb2.allow();
    cb2.recordFailure();
    expect(cb2.snapshot().state).toBe('open');
  });
});
