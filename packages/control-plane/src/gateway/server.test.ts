import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { SessionStore } from '../session/store.js';
import { RuleRouter } from '../session/router.js';
import { ApiGateway, type MessageHandler } from './server.js';
import type { StandardMessage } from '@agent-platform/core';
import { generateMessageId, generateTraceId, nowMs } from '@agent-platform/core';

function makeMsg(overrides: Partial<StandardMessage> = {}): StandardMessage {
  return {
    id: generateMessageId(),
    traceId: generateTraceId(),
    timestamp: nowMs(),
    channel: { type: 'webchat', id: 'w-1', metadata: {} },
    sender: { id: 'user-1', isOwner: true },
    conversation: { type: 'dm', id: 'c-1' },
    content: { type: 'text', text: 'hello' },
    ...overrides,
  };
}

describe('ApiGateway', () => {
  let dir: string;
  let store: SessionStore;
  let gateway: ApiGateway;
  let port: number;
  let handlerCalls: StandardMessage[];
  let handler: MessageHandler;

  beforeEach(async () => {
    dir = mkdtempSync(resolve(tmpdir(), 'cp-gw-'));
    store = new SessionStore(resolve(dir, 'sessions.db'));
    handlerCalls = [];
    handler = async (msg, ctx) => {
      handlerCalls.push(msg);
      ctx.emit('hello ');
      ctx.emit('world');
      return { inputTokens: 5, outputTokens: 2, costUsd: 0.0001 };
    };
    const router = new RuleRouter(store, { defaultAgentId: 'default' });
    gateway = new ApiGateway({
      port: 0,
      auth: { tokens: ['sekrit'] },
      rateLimit: { capacity: 5, refillPerSecond: 1 },
      router,
      sessions: store,
      handler,
    });
    port = await gateway.start();
  });

  afterEach(async () => {
    await gateway.stop();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // ─── HTTP ────────────────────────────────────────────────────────────────

  it('GET /healthz returns 200 without auth', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it('GET /sessions/:id without auth returns 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/sessions/x`);
    expect(res.status).toBe(401);
  });

  it('GET /sessions/:id returns 404 for missing session', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/sessions/missing`, {
      headers: { Authorization: 'Bearer sekrit' },
    });
    expect(res.status).toBe(404);
  });

  it('GET /sessions/:id returns the session', async () => {
    const s = store.createSession({ agentId: 'default', channelType: 'webchat', conversationId: 'c-1' });
    const res = await fetch(`http://127.0.0.1:${port}/sessions/${s.id}`, {
      headers: { Authorization: 'Bearer sekrit' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(s.id);
  });

  it('POST /sessions/:id/hibernate flips status', async () => {
    const s = store.createSession({ agentId: 'a', channelType: 'webchat', conversationId: 'c-2' });
    const res = await fetch(`http://127.0.0.1:${port}/sessions/${s.id}/hibernate`, {
      method: 'POST',
      headers: { Authorization: 'Bearer sekrit' },
    });
    expect(res.status).toBe(200);
    expect(store.getSession(s.id)?.status).toBe('hibernated');
  });

  it('POST /messages routes, invokes handler, and returns response text', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/messages`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer sekrit',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(makeMsg()),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accepted: boolean;
      responseText: string;
      routedTo: { agentId: string };
    };
    expect(body.accepted).toBe(true);
    expect(body.responseText).toBe('hello world');
    expect(body.routedTo.agentId).toBe('default');
    expect(handlerCalls).toHaveLength(1);
  });

  it('POST /messages returns 429 when rate limited', async () => {
    // capacity=5, burn through
    for (let i = 0; i < 5; i += 1) {
      const r = await fetch(`http://127.0.0.1:${port}/messages`, {
        method: 'POST',
        headers: { Authorization: 'Bearer sekrit', 'Content-Type': 'application/json' },
        body: JSON.stringify(makeMsg()),
      });
      expect(r.status).toBe(200);
    }
    const throttled = await fetch(`http://127.0.0.1:${port}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Bearer sekrit', 'Content-Type': 'application/json' },
      body: JSON.stringify(makeMsg()),
    });
    expect(throttled.status).toBe(429);
  });

  // ─── WebSocket ───────────────────────────────────────────────────────────

  it('WS rejects connection without auth', async () => {
    await new Promise<void>((done) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.on('error', () => done());
      ws.on('unexpected-response', () => done());
    });
  });

  it('WS accepts connection with valid bearer and handles submit_message', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Authorization: 'Bearer sekrit' },
    });
    await new Promise<void>((resolveOpen, reject) => {
      ws.on('open', resolveOpen);
      ws.on('error', reject);
    });

    const received: unknown[] = [];
    ws.on('message', (data: Buffer) => {
      received.push(JSON.parse(data.toString('utf-8')));
    });

    ws.send(
      JSON.stringify({
        type: 'submit_message',
        message: makeMsg(),
      }),
    );

    // Wait for response_done
    await new Promise<void>((resolveDone) => {
      const check = setInterval(() => {
        if (received.some((r) => (r as { type: string }).type === 'response_done')) {
          clearInterval(check);
          resolveDone();
        }
      }, 20);
    });

    const types = received.map((r) => (r as { type: string }).type);
    expect(types).toContain('accepted');
    expect(types).toContain('response_delta');
    expect(types).toContain('response_done');

    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('WS ping is answered with pong', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Authorization: 'Bearer sekrit' },
    });
    await new Promise<void>((resolveOpen, reject) => {
      ws.on('open', resolveOpen);
      ws.on('error', reject);
    });
    const received: unknown[] = [];
    ws.on('message', (data: Buffer) => {
      received.push(JSON.parse(data.toString('utf-8')));
    });
    ws.send(JSON.stringify({ type: 'ping', sentAt: 42 }));
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toContainEqual(expect.objectContaining({ type: 'pong', sentAt: 42 }));
    ws.close();
  });

  it('WS reports rate_limited when bucket is empty', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Authorization: 'Bearer sekrit' },
    });
    await new Promise<void>((resolveOpen, reject) => {
      ws.on('open', resolveOpen);
      ws.on('error', reject);
    });

    const received: unknown[] = [];
    ws.on('message', (data: Buffer) => {
      received.push(JSON.parse(data.toString('utf-8')));
    });

    // Fire 6 submits rapidly (capacity=5).
    for (let i = 0; i < 6; i += 1) {
      ws.send(JSON.stringify({ type: 'submit_message', message: makeMsg() }));
    }
    await new Promise((r) => setTimeout(r, 200));
    const errors = received.filter(
      (r) => (r as { type?: string; code?: string }).type === 'error' &&
        (r as { code?: string }).code === 'rate_limited',
    );
    expect(errors.length).toBeGreaterThanOrEqual(1);
    ws.close();
  });
});
