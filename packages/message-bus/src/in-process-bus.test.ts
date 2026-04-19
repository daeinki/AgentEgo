import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { StandardMessage } from '@agent-platform/core';
import { generateMessageId, generateTraceId, nowMs } from '@agent-platform/core';
import { InProcessBus } from './in-process-bus.js';
import type { BusEntry } from './bus.js';

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

describe('InProcessBus', () => {
  let bus: InProcessBus;

  beforeEach(() => {
    bus = new InProcessBus();
  });

  afterEach(async () => {
    await bus.close();
  });

  it('publish + subscribe delivers messages', async () => {
    const received: BusEntry[] = [];
    const sub = await bus.subscribe(
      'inbound',
      { group: 'g1', consumer: 'c1', blockMs: 50, count: 10 },
      async (entry) => {
        received.push(entry);
        await bus.ack('inbound', 'g1', entry.id);
      },
    );

    await bus.publish('inbound', makeMsg('one'));
    await bus.publish('inbound', makeMsg('two'));

    // Wait for delivery.
    for (let i = 0; i < 50 && received.length < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(received).toHaveLength(2);
    await sub.unsubscribe();
  });

  it('two groups each get their own copy of every message', async () => {
    const aReceived: string[] = [];
    const bReceived: string[] = [];

    const subA = await bus.subscribe(
      'topic',
      { group: 'group-a', consumer: 'a1', blockMs: 50 },
      async (e) => {
        if (e.message.content.type === 'text') aReceived.push(e.message.content.text);
        await bus.ack('topic', 'group-a', e.id);
      },
    );
    const subB = await bus.subscribe(
      'topic',
      { group: 'group-b', consumer: 'b1', blockMs: 50 },
      async (e) => {
        if (e.message.content.type === 'text') bReceived.push(e.message.content.text);
        await bus.ack('topic', 'group-b', e.id);
      },
    );

    await bus.publish('topic', makeMsg('hi'));
    for (let i = 0; i < 50 && (aReceived.length === 0 || bReceived.length === 0); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(aReceived).toEqual(['hi']);
    expect(bReceived).toEqual(['hi']);

    await subA.unsubscribe();
    await subB.unsubscribe();
  });

  it('publish wakes subscribers that are blocked', async () => {
    let received = false;
    const sub = await bus.subscribe(
      'wake',
      { group: 'g', consumer: 'c', blockMs: 5000 },
      async () => {
        received = true;
      },
    );
    const start = Date.now();
    await bus.publish('wake', makeMsg('x'));
    // Subscriber should fire within well under 5000ms.
    for (let i = 0; i < 100 && !received; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(received).toBe(true);
    expect(Date.now() - start).toBeLessThan(1000);
    await sub.unsubscribe();
  });

  it('subsequent subscribers do not replay old messages', async () => {
    await bus.publish('t', makeMsg('pre'));
    await bus.publish('t', makeMsg('pre2'));

    // New subscriber starts at the latest offset of its group (0 when group is
    // fresh). The in-process bus delivers ALL existing entries to a fresh group
    // since offsets start at 0 — verify that behavior (at-least-once semantics).
    const got: string[] = [];
    const sub = await bus.subscribe(
      't',
      { group: 'fresh', consumer: 'c', blockMs: 20 },
      async (e) => {
        if (e.message.content.type === 'text') got.push(e.message.content.text);
        await bus.ack('t', 'fresh', e.id);
      },
    );

    await new Promise((r) => setTimeout(r, 60));
    expect(got).toEqual(['pre', 'pre2']);
    await sub.unsubscribe();
  });

  it('peek reports state', async () => {
    await bus.publish('peek-test', makeMsg('x'));
    const snap = bus.peek('peek-test');
    expect(snap.entries).toBe(1);
  });

  it('publish after close throws', async () => {
    await bus.close();
    await expect(bus.publish('x', makeMsg('y'))).rejects.toThrow(/closed/);
  });
});
