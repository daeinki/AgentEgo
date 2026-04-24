import type { Contracts } from '@agent-platform/core';

/**
 * Read-only descriptor surfaced over RPC `channels.list` / `channels.status`.
 * Structurally matches gateway-cli's `ChannelDescriptor` — kept duplicated
 * here so control-plane doesn't take a dependency on gateway-cli.
 */
export interface ChannelDescriptor {
  id: string;
  type: string;
  status: 'connected' | 'disconnected' | 'error' | 'unknown';
  lastEventAt?: number;
  error?: string;
  sessionCount?: number;
}

interface Entry {
  id: string;
  type: string;
  adapter: Contracts.ChannelAdapter;
  lastEventAt?: number;
  error?: string;
  sessionCount?: number;
  status: ChannelDescriptor['status'];
}

/**
 * Aggregates running channel adapters so RPC `channels.list` / `channels.status`
 * can report them. The platform startup layer registers each booted adapter and
 * calls `recordEvent` / `recordError` / `updateSessionCount` as the adapter
 * fires signals; `list()` is a synchronous snapshot of the cached state.
 *
 * Status derivation:
 *   - `connected`   — registered, no error recorded, not shut down
 *   - `error`       — explicit `recordError` at least once since last
 *                     `clearError` / event
 *   - `disconnected`— `deregister()` called (e.g. during shutdown)
 *   - `unknown`     — reserved for future pre-init states (not currently used)
 *
 * `refreshHealth()` optionally upgrades/downgrades status by calling the
 * adapter's `healthCheck()`. Callers can drive it periodically; it is never
 * invoked automatically so the registry remains side-effect-free.
 */
export class PlatformChannelRegistry {
  private readonly entries = new Map<string, Entry>();

  register(id: string, type: string, adapter: Contracts.ChannelAdapter): void {
    this.entries.set(id, {
      id,
      type,
      adapter,
      status: 'connected',
    });
  }

  deregister(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.status = 'disconnected';
  }

  recordEvent(id: string, at: number = Date.now()): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.lastEventAt = at;
    if (e.status === 'error') {
      e.status = 'connected';
      delete e.error;
    }
  }

  recordError(id: string, error: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.error = error;
    e.status = 'error';
  }

  clearError(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    delete e.error;
    if (e.status === 'error') e.status = 'connected';
  }

  updateSessionCount(id: string, count: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.sessionCount = count;
  }

  /**
   * Poll the adapter's `healthCheck()` and update status accordingly. A
   * non-healthy result becomes `error` with the check's `message` as the
   * error text; a healthy result clears any previous error.
   */
  async refreshHealth(id: string): Promise<void> {
    const e = this.entries.get(id);
    if (!e || e.status === 'disconnected') return;
    try {
      const h = await e.adapter.healthCheck();
      if (h.healthy) {
        e.status = 'connected';
        delete e.error;
      } else {
        e.status = 'error';
        e.error = h.message ?? 'unhealthy';
      }
    } catch (err) {
      e.status = 'error';
      e.error = err instanceof Error ? err.message : String(err);
    }
  }

  list(): readonly ChannelDescriptor[] {
    return [...this.entries.values()].map((e) => this.describe(e));
  }

  get(id: string): ChannelDescriptor | undefined {
    const e = this.entries.get(id);
    return e ? this.describe(e) : undefined;
  }

  private describe(e: Entry): ChannelDescriptor {
    const out: ChannelDescriptor = {
      id: e.id,
      type: e.type,
      status: e.status,
    };
    if (e.lastEventAt !== undefined) out.lastEventAt = e.lastEventAt;
    if (e.error !== undefined) out.error = e.error;
    if (e.sessionCount !== undefined) out.sessionCount = e.sessionCount;
    return out;
  }
}
