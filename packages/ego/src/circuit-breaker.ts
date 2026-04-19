import { nowMs } from '@agent-platform/core';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  threshold: number;       // consecutive failures before tripping
  cooldownMinutes: number; // how long to stay open before probing
}

/**
 * Consecutive-failure circuit breaker for the EGO deep path (§5.7).
 *
 * - Closed (normal): all calls allowed.
 * - After `threshold` consecutive failures: transitions to Open. Calls are rejected.
 * - After `cooldownMinutes`: transitions to Half-Open. One probe is allowed.
 *   On probe success: Closed. On probe failure: Open (cooldown restarts).
 */
export class CircuitBreaker {
  private failures = 0;
  private state: CircuitState = 'closed';
  private openedAtMs = 0;
  private probeInFlight = false;

  constructor(private readonly config: CircuitBreakerConfig) {}

  snapshot(): {
    state: CircuitState;
    failures: number;
    millisUntilHalfOpen: number;
  } {
    return {
      state: this.state,
      failures: this.failures,
      millisUntilHalfOpen: this.millisUntilHalfOpen(),
    };
  }

  private millisUntilHalfOpen(): number {
    if (this.state !== 'open') return 0;
    const elapsed = nowMs() - this.openedAtMs;
    const cooldownMs = this.config.cooldownMinutes * 60_000;
    return Math.max(0, cooldownMs - elapsed);
  }

  allow(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (this.millisUntilHalfOpen() === 0) {
        this.state = 'half-open';
        this.probeInFlight = false;
      } else {
        return false;
      }
    }
    // half-open: allow exactly one probe at a time
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.probeInFlight = false;
    this.state = 'closed';
  }

  recordFailure(): void {
    if (this.state === 'half-open') {
      this.probeInFlight = false;
      this.trip();
      return;
    }
    this.failures += 1;
    if (this.failures >= this.config.threshold) this.trip();
  }

  private trip(): void {
    this.state = 'open';
    this.openedAtMs = nowMs();
  }

  reset(): void {
    this.failures = 0;
    this.state = 'closed';
    this.openedAtMs = 0;
    this.probeInFlight = false;
  }
}
