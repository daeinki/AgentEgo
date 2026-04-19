import type { StandardMessage } from '@agent-platform/core';
import { nowMs } from '@agent-platform/core';
import type {
  BusEntry,
  MessageBus,
  SubscribeOptions,
  Subscription,
} from './bus.js';

interface SubjectBuffer {
  entries: BusEntry[];
  /**
   * Per-group last-delivered offset (index into entries).
   */
  offsets: Map<string, number>;
  /**
   * Pending-entries list: id → { group → consumer }.
   */
  pending: Map<string, Map<string, string>>;
}

/**
 * Single-process message bus with at-least-once semantics per consumer group.
 *
 * Not durable — entries disappear when the bus instance is garbage collected.
 * Suitable for:
 * - Local dev / CI
 * - Single-node deployments
 * - Tests
 *
 * For multi-process deployments, swap in `RedisStreamsBus`.
 */
export class InProcessBus implements MessageBus {
  private readonly subjects = new Map<string, SubjectBuffer>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private nextId = 0;
  private closed = false;

  async publish(subject: string, message: StandardMessage): Promise<BusEntry> {
    if (this.closed) throw new Error('bus closed');
    const buffer = this.buffer(subject);
    const id = `${nowMs()}-${this.nextId++}`;
    const entry: BusEntry = { id, subject, message };
    buffer.entries.push(entry);
    // Wake waiters.
    const wakers = this.waiters.get(subject);
    if (wakers) {
      for (const wake of wakers) wake();
      wakers.clear();
    }
    return entry;
  }

  async subscribe(
    subject: string,
    options: SubscribeOptions,
    handler: (entry: BusEntry) => Promise<void>,
  ): Promise<Subscription> {
    if (this.closed) throw new Error('bus closed');
    const buffer = this.buffer(subject);
    if (!buffer.offsets.has(options.group)) buffer.offsets.set(options.group, 0);

    let cancelled = false;
    const loop = async (): Promise<void> => {
      while (!cancelled && !this.closed) {
        const batch = this.nextBatch(subject, options);
        if (batch.length === 0) {
          await this.waitForPublish(subject, options.blockMs ?? 100);
          continue;
        }
        for (const entry of batch) {
          buffer.pending.get(entry.id)?.set(options.group, options.consumer) ??
            buffer.pending.set(entry.id, new Map([[options.group, options.consumer]]));
          try {
            await handler(entry);
          } catch {
            // handler error → leave in pending; user must ack or retry
          }
        }
      }
    };

    const running = loop();

    return {
      async unsubscribe() {
        cancelled = true;
        await running;
      },
    };
  }

  async ack(subject: string, group: string, entryId: string): Promise<void> {
    const buffer = this.subjects.get(subject);
    if (!buffer) return;
    const pendingForEntry = buffer.pending.get(entryId);
    if (!pendingForEntry) return;
    pendingForEntry.delete(group);
    if (pendingForEntry.size === 0) buffer.pending.delete(entryId);
  }

  async close(): Promise<void> {
    this.closed = true;
    // Wake any sleeping subscribers so they can exit their loops.
    for (const wakers of this.waiters.values()) {
      for (const w of wakers) w();
      wakers.clear();
    }
  }

  /**
   * Snapshot — useful for tests/inspection. Not part of the MessageBus contract.
   */
  peek(subject: string): { entries: number; pending: number; groupOffsets: Record<string, number> } {
    const buffer = this.subjects.get(subject);
    if (!buffer) return { entries: 0, pending: 0, groupOffsets: {} };
    return {
      entries: buffer.entries.length,
      pending: buffer.pending.size,
      groupOffsets: Object.fromEntries(buffer.offsets),
    };
  }

  private buffer(subject: string): SubjectBuffer {
    let b = this.subjects.get(subject);
    if (!b) {
      b = { entries: [], offsets: new Map(), pending: new Map() };
      this.subjects.set(subject, b);
    }
    return b;
  }

  private nextBatch(subject: string, options: SubscribeOptions): BusEntry[] {
    const buffer = this.subjects.get(subject);
    if (!buffer) return [];
    const offset = buffer.offsets.get(options.group) ?? 0;
    const max = offset + (options.count ?? 10);
    const batch = buffer.entries.slice(offset, max);
    if (batch.length > 0) {
      buffer.offsets.set(options.group, offset + batch.length);
    }
    return batch;
  }

  private waitForPublish(subject: string, timeoutMs: number): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const fire = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      let set = this.waiters.get(subject);
      if (!set) {
        set = new Set();
        this.waiters.set(subject, set);
      }
      set.add(fire);
      if (timeoutMs > 0) setTimeout(fire, timeoutMs);
    });
  }
}
