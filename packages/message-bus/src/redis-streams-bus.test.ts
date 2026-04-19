import { describe, it, expect, beforeEach } from 'vitest';
import type { StandardMessage } from '@agent-platform/core';
import { generateMessageId, generateTraceId, nowMs } from '@agent-platform/core';
import { RedisStreamsBus } from './redis-streams-bus.js';
import type { RedisLike } from './redis-streams-bus.js';

function makeMsg(text: string): StandardMessage {
  return {
    id: generateMessageId(),
    traceId: generateTraceId(),
    timestamp: nowMs(),
    channel: { type: 'webchat', id: 'w', metadata: {} },
    sender: { id: 'u', isOwner: true },
    conversation: { type: 'dm', id: 'c' },
    content: { type: 'text', text },
  };
}

class MockRedis implements RedisLike {
  public streams: Map<string, Array<[string, string[]]>> = new Map();
  public groups: Map<string, Set<string>> = new Map(); // streamKey → groups
  public acks: Array<{ key: string; group: string; id: string }> = [];
  public quitCalled = false;
  private idSeq = 0;
  private readResponses: Array<Array<[string, Array<[string, string[]]>]> | null> = [];
  public xaddCalls: Array<{ key: string; fields: string[] }> = [];

  async xadd(key: string, _id: '*' | string, ...fieldsAndValues: string[]): Promise<string> {
    const id = `1700000000000-${this.idSeq++}`;
    const list = this.streams.get(key) ?? [];
    list.push([id, fieldsAndValues]);
    this.streams.set(key, list);
    this.xaddCalls.push({ key, fields: fieldsAndValues });
    return id;
  }

  async xgroup(
    _sub: 'CREATE',
    key: string,
    group: string,
    _id: string,
    _mk: 'MKSTREAM',
  ): Promise<string | null> {
    const set = this.groups.get(key) ?? new Set();
    if (set.has(group)) {
      throw new Error('BUSYGROUP Consumer Group name already exists');
    }
    set.add(group);
    this.groups.set(key, set);
    return 'OK';
  }

  /**
   * Queue a scripted response for the next xreadgroup call.
   */
  queueRead(response: Array<[string, Array<[string, string[]]>]> | null): void {
    this.readResponses.push(response);
  }

  async xreadgroup(
    ..._args: Array<string | number>
  ): Promise<Array<[string, Array<[string, string[]]>]> | null> {
    // Pop from the queue; if empty, return null (no messages — simulates BLOCK timeout).
    if (this.readResponses.length === 0) {
      return null;
    }
    return this.readResponses.shift() ?? null;
  }

  async xack(key: string, group: string, id: string): Promise<number> {
    this.acks.push({ key, group, id });
    return 1;
  }

  async quit(): Promise<unknown> {
    this.quitCalled = true;
    return 'OK';
  }
}

describe('RedisStreamsBus', () => {
  let redis: MockRedis;
  let bus: RedisStreamsBus;

  beforeEach(() => {
    redis = new MockRedis();
    bus = new RedisStreamsBus({ client: redis });
  });

  it('publish writes to the correct stream key with the `msg` field', async () => {
    const entry = await bus.publish('inbound', makeMsg('hi'));
    expect(entry.id).toMatch(/^\d+-\d+$/);
    expect(entry.subject).toBe('inbound');
    expect(redis.xaddCalls).toHaveLength(1);
    expect(redis.xaddCalls[0]?.key).toBe('agent:inbound');
    expect(redis.xaddCalls[0]?.fields[0]).toBe('msg');
  });

  it('respects keyPrefix override', async () => {
    const customBus = new RedisStreamsBus({ client: redis, keyPrefix: 'myapp:' });
    await customBus.publish('x', makeMsg('y'));
    expect(redis.xaddCalls[0]?.key).toBe('myapp:x');
  });

  it('ack delegates to xack', async () => {
    await bus.ack('inbound', 'g1', '123-0');
    expect(redis.acks).toEqual([{ key: 'agent:inbound', group: 'g1', id: '123-0' }]);
  });

  it('subscribe parses `msg` field as StandardMessage and calls handler', async () => {
    const serialized = JSON.stringify(makeMsg('hello'));
    redis.queueRead([['agent:inbound', [['1700000000000-0', ['msg', serialized]]]]]);

    const received: string[] = [];
    const sub = await bus.subscribe(
      'inbound',
      { group: 'g1', consumer: 'c1', blockMs: 10 },
      async (entry) => {
        if (entry.message.content.type === 'text') received.push(entry.message.content.text);
      },
    );

    // Let the loop process the single queued response + a few null returns.
    await new Promise((r) => setTimeout(r, 60));
    await sub.unsubscribe();

    expect(received).toEqual(['hello']);
  });

  it('ensureGroup creates the consumer group on first subscribe', async () => {
    redis.queueRead(null);
    const sub = await bus.subscribe('inbound', { group: 'new-group', consumer: 'c', blockMs: 10 }, async () => {});
    await new Promise((r) => setTimeout(r, 30));
    await sub.unsubscribe();
    expect(redis.groups.get('agent:inbound')?.has('new-group')).toBe(true);
  });

  it('ensureGroup is idempotent (BUSYGROUP swallowed)', async () => {
    // Pre-create the group externally to simulate an existing one.
    await redis.xgroup('CREATE', 'agent:inbound', 'existing', '$', 'MKSTREAM');
    redis.queueRead(null);
    const sub = await bus.subscribe(
      'inbound',
      { group: 'existing', consumer: 'c', blockMs: 10 },
      async () => {},
    );
    await new Promise((r) => setTimeout(r, 30));
    await sub.unsubscribe();
    expect(redis.groups.get('agent:inbound')?.has('existing')).toBe(true);
  });

  it('skips entries without a `msg` field', async () => {
    redis.queueRead([['agent:x', [['1-0', ['otherField', 'nope']]]]]);
    const received: unknown[] = [];
    const sub = await bus.subscribe(
      'x',
      { group: 'g', consumer: 'c', blockMs: 10 },
      async (e) => {
        received.push(e);
      },
    );
    await new Promise((r) => setTimeout(r, 30));
    await sub.unsubscribe();
    expect(received).toEqual([]);
  });

  it('close calls quit', async () => {
    await bus.close();
    expect(redis.quitCalled).toBe(true);
    await expect(bus.publish('x', makeMsg('y'))).rejects.toThrow(/closed/);
  });
});
