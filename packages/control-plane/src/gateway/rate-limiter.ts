import { nowMs } from '@agent-platform/core';

export interface RateLimiterConfig {
  /**
   * Max tokens (burst size). Each request costs 1 token.
   */
  capacity: number;
  /**
   * Tokens refilled per second.
   */
  refillPerSecond: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

/**
 * Token-bucket rate limiter keyed by an arbitrary string (e.g. channel:sender).
 * In-memory only; a multi-process deployment would back this with Redis.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly config: RateLimiterConfig) {}

  /**
   * Attempt to consume one token. Returns true if allowed, false if throttled.
   */
  take(key: string): boolean {
    const now = nowMs();
    const bucket = this.buckets.get(key) ?? {
      tokens: this.config.capacity,
      lastRefillMs: now,
    };

    const elapsed = (now - bucket.lastRefillMs) / 1000;
    const refill = elapsed * this.config.refillPerSecond;
    bucket.tokens = Math.min(this.config.capacity, bucket.tokens + refill);
    bucket.lastRefillMs = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.buckets.set(key, bucket);
      return true;
    }

    this.buckets.set(key, bucket);
    return false;
  }

  /**
   * Current token count for a key. Useful for telemetry/tests.
   */
  remaining(key: string): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return this.config.capacity;
    // Apply the same refill calculation non-destructively.
    const elapsed = (nowMs() - bucket.lastRefillMs) / 1000;
    return Math.min(this.config.capacity, bucket.tokens + elapsed * this.config.refillPerSecond);
  }

  reset(key?: string): void {
    if (key === undefined) this.buckets.clear();
    else this.buckets.delete(key);
  }
}
