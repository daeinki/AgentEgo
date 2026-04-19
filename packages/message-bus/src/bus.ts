import type { StandardMessage } from '@agent-platform/core';

export interface BusEntry {
  /**
   * Monotonic identifier assigned by the bus on publish. Redis Streams uses
   * `ms-seq` (e.g. `1700000000000-0`); in-process bus uses a simple counter.
   */
  id: string;
  message: StandardMessage;
  /**
   * Subject / topic. Redis Streams maps this to a stream name; the in-process
   * bus uses it as a key in a map.
   */
  subject: string;
}

export interface SubscribeOptions {
  /**
   * Consumer group name. Required for Redis; the in-process bus uses it only
   * for telemetry/debugging.
   */
  group: string;
  /**
   * Consumer id (within the group). Redis uses this for PEL tracking.
   */
  consumer: string;
  /**
   * Time in milliseconds to block waiting for new entries. 0 = return immediately.
   */
  blockMs?: number;
  /**
   * Max entries to return in one read. Default 10.
   */
  count?: number;
}

export interface MessageBus {
  publish(subject: string, message: StandardMessage): Promise<BusEntry>;
  /**
   * Subscribe returns an async iterable that yields entries as they arrive.
   * Calling the returned `unsubscribe()` stops the loop and releases resources.
   */
  subscribe(
    subject: string,
    options: SubscribeOptions,
    handler: (entry: BusEntry) => Promise<void>,
  ): Promise<Subscription>;
  /**
   * Mark an entry as acknowledged. For Redis Streams, drops it from the PEL
   * for the given consumer group.
   */
  ack(subject: string, group: string, entryId: string): Promise<void>;
  close(): Promise<void>;
}

export interface Subscription {
  unsubscribe(): Promise<void>;
}
