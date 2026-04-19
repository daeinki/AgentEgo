import { describe, it, expect } from 'vitest';
import { TimeoutError, withTimeout } from '../src/time.js';

describe('withTimeout', () => {
  it('resolves with the wrapped value when it settles in time', async () => {
    const v = await withTimeout(Promise.resolve(42), 100, 'test');
    expect(v).toBe(42);
  });

  it('throws a TimeoutError (not a plain Error) on budget exhaustion', async () => {
    const slow = new Promise<never>(() => {
      /* never resolves */
    });
    try {
      await withTimeout(slow, 20, 'unit-test');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError);
      expect(err).toBeInstanceOf(Error);
      const te = err as TimeoutError;
      expect(te.name).toBe('TimeoutError');
      expect(te.label).toBe('unit-test');
      expect(te.timeoutMs).toBe(20);
      expect(te.message).toBe('unit-test timed out after 20ms');
    }
  });

  it('propagates the wrapped promise rejection untouched', async () => {
    const err = new Error('boom');
    try {
      await withTimeout(Promise.reject(err), 50, 'test');
      expect.fail('should have thrown');
    } catch (thrown) {
      expect(thrown).toBe(err);
      expect(thrown).not.toBeInstanceOf(TimeoutError);
    }
  });
});
