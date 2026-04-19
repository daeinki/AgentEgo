import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { WebChatAdapter } from './adapter.js';
import type { StandardMessage } from '@agent-platform/core';

async function waitFor<T>(
  predicate: () => T | undefined,
  timeoutMs = 1000,
  intervalMs = 10,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = predicate();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor: predicate not satisfied within ${timeoutMs}ms`);
}

describe('WebChatAdapter', () => {
  let adapter: WebChatAdapter;

  beforeEach(async () => {
    adapter = new WebChatAdapter();
    await adapter.initialize({
      type: 'webchat',
      port: 0,
      credentials: {},
      conversationId: 'webchat-test',
      ownerIds: ['owner-u'],
    });
  });

  afterEach(async () => {
    await adapter.shutdown();
  });

  async function openClient(): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${adapter.listeningPort()}/webchat`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return ws;
  }

  it('boots an HTTP+WS server on a real port', async () => {
    expect(adapter.listeningPort()).toBeGreaterThan(0);
    const health = await adapter.healthCheck();
    expect(health.healthy).toBe(true);
  });

  it('translates browser `say` into a StandardMessage', async () => {
    let received: StandardMessage | undefined;
    adapter.onMessage((m) => {
      received = m;
    });

    const ws = await openClient();
    const inboxForClient: unknown[] = [];
    ws.on('message', (data: Buffer) => inboxForClient.push(JSON.parse(data.toString())));

    ws.send(JSON.stringify({ type: 'identify', userId: 'owner-u' }));
    await waitFor(() =>
      inboxForClient.find((m) => (m as { type: string }).type === 'system'),
    );

    ws.send(JSON.stringify({ type: 'say', text: '안녕', clientMessageId: 'c-1' }));

    const msg = await waitFor(() => received);
    expect(msg.content.type).toBe('text');
    if (msg.content.type === 'text') expect(msg.content.text).toBe('안녕');
    expect(msg.sender.id).toBe('owner-u');
    expect(msg.sender.isOwner).toBe(true);
    expect(msg.conversation.id).toBe('webchat-test');
    expect(msg.channel.type).toBe('webchat');

    // accepted envelope sent to the browser
    const accepted = inboxForClient.find(
      (m) => (m as { type: string }).type === 'accepted',
    ) as { type: string; clientMessageId: string; traceId: string } | undefined;
    expect(accepted?.clientMessageId).toBe('c-1');
    expect(accepted?.traceId).toBe(msg.traceId);

    ws.close();
  });

  it('refuses `say` before identify', async () => {
    const ws = await openClient();
    const inbox: unknown[] = [];
    ws.on('message', (d: Buffer) => inbox.push(JSON.parse(d.toString())));

    ws.send(JSON.stringify({ type: 'say', text: 'hi' }));
    await waitFor(() => inbox.find((m) => (m as { type: string }).type === 'error'));

    expect(inbox.some((m) => (m as { type: string; message: string }).message === 'identify first')).toBe(true);

    ws.close();
  });

  it('isAllowed enforces ownerIds when configured', async () => {
    expect(await adapter.isAllowed('owner-u', 'dm')).toBe(true);
    expect(await adapter.isAllowed('stranger', 'dm')).toBe(false);
  });

  it('broadcasts outbound content via sendMessage', async () => {
    const ws = await openClient();
    const inbox: unknown[] = [];
    ws.on('message', (d: Buffer) => inbox.push(JSON.parse(d.toString())));

    ws.send(JSON.stringify({ type: 'identify', userId: 'owner-u' }));
    await waitFor(() => inbox.find((m) => (m as { type: string }).type === 'system'));

    const result = await adapter.sendMessage('webchat-test', { type: 'text', text: 'hello back' });
    expect(result.status).toBe('sent');

    const out = await waitFor(() => inbox.find((m) => (m as { type: string }).type === 'out')) as {
      type: string;
      content: { type: string; text: string };
    };
    expect(out.content.text).toBe('hello back');

    ws.close();
  });

  it('sendMessage reports failed when no clients are connected', async () => {
    const result = await adapter.sendMessage('nobody-here', { type: 'text', text: 'hi' });
    expect(result.status).toBe('failed');
  });

  it('emitDelta + emitDone stream to all clients in a conversation', async () => {
    const ws = await openClient();
    const inbox: unknown[] = [];
    ws.on('message', (d: Buffer) => inbox.push(JSON.parse(d.toString())));

    ws.send(JSON.stringify({ type: 'identify', userId: 'owner-u' }));
    await waitFor(() => inbox.find((m) => (m as { type: string }).type === 'system'));

    adapter.emitDelta('webchat-test', 't-1', 'hi ');
    adapter.emitDelta('webchat-test', 't-1', 'there');
    adapter.emitDone('webchat-test', 't-1');

    await waitFor(() => inbox.find((m) => (m as { type: string }).type === 'done'));
    const deltas = inbox.filter((m) => (m as { type: string }).type === 'delta');
    expect(deltas).toHaveLength(2);

    ws.close();
  });

  it('ping yields pong', async () => {
    const ws = await openClient();
    const inbox: unknown[] = [];
    ws.on('message', (d: Buffer) => inbox.push(JSON.parse(d.toString())));

    ws.send(JSON.stringify({ type: 'ping', sentAt: 7 }));
    const pong = await waitFor(() => inbox.find((m) => (m as { type: string }).type === 'pong')) as {
      sentAt: number;
    };
    expect(pong.sentAt).toBe(7);
    ws.close();
  });
});
