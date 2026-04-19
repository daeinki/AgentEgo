import type { StandardMessage } from '@agent-platform/core';
import type {
  BusEntry,
  MessageBus,
  SubscribeOptions,
  Subscription,
} from './bus.js';

/**
 * Minimal ioredis-like client surface we depend on. Keeping this narrow
 * means callers can inject a mock for tests without stubbing the full ioredis API.
 */
export interface RedisLike {
  xadd(key: string, id: '*' | string, ...fieldsAndValues: string[]): Promise<string>;
  xgroup(
    subcommand: 'CREATE',
    key: string,
    group: string,
    id: string,
    mkstream: 'MKSTREAM',
  ): Promise<string | null>;
  xreadgroup(
    ...args: Array<string | number>
  ): Promise<Array<[string, Array<[string, string[]]>]> | null>;
  xack(key: string, group: string, id: string): Promise<number>;
  quit(): Promise<unknown>;
}

export interface RedisStreamsBusOptions {
  client: RedisLike;
  /**
   * Prefix added to subjects when composing Redis stream keys. Default
   * `agent:` — so subject `inbound` maps to stream `agent:inbound`.
   */
  keyPrefix?: string;
}

/**
 * Redis Streams-backed MessageBus (ADR-002).
 *
 * Durable, multi-process message bus. Entries are persisted to Redis and
 * survive process restarts; consumer groups track delivery state via the PEL
 * so ack-less consumers can resume without reprocessing.
 *
 * ioredis (and any API-compatible client — node-redis, IORedis variants) is
 * injected via the `client` option — we never import it directly, so callers
 * don't pay for ioredis unless they opt in.
 */
export class RedisStreamsBus implements MessageBus {
  private readonly client: RedisLike;
  private readonly keyPrefix: string;
  private readonly knownGroups = new Set<string>();
  private closed = false;

  constructor(options: RedisStreamsBusOptions) {
    this.client = options.client;
    this.keyPrefix = options.keyPrefix ?? 'agent:';
  }

  async publish(subject: string, message: StandardMessage): Promise<BusEntry> {
    if (this.closed) throw new Error('bus closed');
    const serialized = JSON.stringify(message);
    const id = await this.client.xadd(this.streamKey(subject), '*', 'msg', serialized);
    return { id, subject, message };
  }

  async subscribe(
    subject: string,
    options: SubscribeOptions,
    handler: (entry: BusEntry) => Promise<void>,
  ): Promise<Subscription> {
    if (this.closed) throw new Error('bus closed');
    const streamKey = this.streamKey(subject);
    await this.ensureGroup(streamKey, options.group);

    let cancelled = false;
    const loop = async (): Promise<void> => {
      while (!cancelled && !this.closed) {
        const block = options.blockMs ?? 2000;
        const count = options.count ?? 10;
        let response: Array<[string, Array<[string, string[]]>]> | null = null;
        try {
          response = await this.client.xreadgroup(
            'GROUP',
            options.group,
            options.consumer,
            'COUNT',
            count,
            'BLOCK',
            block,
            'STREAMS',
            streamKey,
            '>',
          );
        } catch (err) {
          if (cancelled || this.closed) return;
          // Transient Redis failure — brief backoff before retrying.
          await sleep(250);
          void err;
          continue;
        }

        if (!response) {
          // Null response means BLOCK timeout (no new messages). Yield briefly
          // so that `cancelled` can propagate and tests don't spin.
          await sleep(5);
          continue;
        }
        for (const [, entries] of response) {
          for (const [entryId, fields] of entries) {
            const entry = this.parseEntry(subject, entryId, fields);
            if (!entry) continue;
            try {
              await handler(entry);
            } catch {
              // Leave in PEL for later retry or manual xclaim.
            }
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
    await this.client.xack(this.streamKey(subject), group, entryId);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.client.quit();
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private streamKey(subject: string): string {
    return `${this.keyPrefix}${subject}`;
  }

  private async ensureGroup(streamKey: string, group: string): Promise<void> {
    const cacheKey = `${streamKey}::${group}`;
    if (this.knownGroups.has(cacheKey)) return;
    try {
      await this.client.xgroup('CREATE', streamKey, group, '$', 'MKSTREAM');
    } catch (err) {
      // BUSYGROUP means the group already exists — that's fine.
      if (!String((err as Error).message).includes('BUSYGROUP')) throw err;
    }
    this.knownGroups.add(cacheKey);
  }

  private parseEntry(subject: string, entryId: string, fields: string[]): BusEntry | null {
    for (let i = 0; i < fields.length - 1; i += 2) {
      if (fields[i] === 'msg') {
        try {
          const msg = JSON.parse(fields[i + 1]!) as StandardMessage;
          return { id: entryId, subject, message: msg };
        } catch {
          return null;
        }
      }
    }
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
