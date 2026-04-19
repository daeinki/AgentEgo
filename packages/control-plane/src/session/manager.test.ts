import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from './store.js';
import { ControlPlaneSessionManager } from './manager.js';
import type { StandardMessage } from '@agent-platform/core';
import { generateMessageId, generateTraceId, nowMs } from '@agent-platform/core';

function makeMsg(text: string): StandardMessage {
  return {
    id: generateMessageId(),
    traceId: generateTraceId(),
    timestamp: nowMs(),
    channel: { type: 'webchat', id: 'w-1', metadata: {} },
    sender: { id: 'user-1', isOwner: true },
    conversation: { type: 'dm', id: 'conv-x' },
    content: { type: 'text', text },
  };
}

describe('ControlPlaneSessionManager', () => {
  let dir: string;
  let store: SessionStore;
  let mgr: ControlPlaneSessionManager;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'cp-sm-'));
    store = new SessionStore(resolve(dir, 'sessions.db'));
    mgr = new ControlPlaneSessionManager(store, { defaultAgentId: 'default' });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolveSession creates on first call and reuses on second', async () => {
    const msg = makeMsg('hi');
    const first = await mgr.resolveSession(msg);
    const second = await mgr.resolveSession(msg);
    expect(second.id).toBe(first.id);
  });

  it('updateSession merges metadata', async () => {
    const msg = makeMsg('hi');
    const s = await mgr.resolveSession(msg);
    const updated = await mgr.updateSession(s.id, { metadata: { tag: 'x' } });
    expect(updated.metadata).toMatchObject({ tag: 'x' });
    const updated2 = await mgr.updateSession(s.id, { metadata: { extra: 'y' } });
    expect(updated2.metadata).toMatchObject({ tag: 'x', extra: 'y' });
  });

  it('hibernateSession and resumeSession flip status', async () => {
    const msg = makeMsg('hi');
    const s = await mgr.resolveSession(msg);
    await mgr.hibernateSession(s.id);
    expect((await mgr.getSession(s.id))?.status).toBe('hibernated');
    const resumed = await mgr.resumeSession(s.id);
    expect(resumed.status).toBe('active');
  });

  it('updateSession can mark a session as redirected (§3.2A.5a)', async () => {
    const msg = makeMsg('hi');
    const s = await mgr.resolveSession(msg);
    const updated = await mgr.updateSession(s.id, {
      status: 'redirected',
      metadata: { redirectedTo: 'sess-target', reason: 'expert routing' },
    });
    expect(updated.status).toBe('redirected');
    expect(updated.metadata).toMatchObject({ redirectedTo: 'sess-target' });
  });

  it('sendToSession emits a system event on the target session', async () => {
    const src = await mgr.createSession({ agentId: 'a', channelType: 'webchat', conversationId: 'c1' });
    const dst = await mgr.createSession({ agentId: 'b', channelType: 'webchat', conversationId: 'c1' });
    await mgr.sendToSession(src.id, dst.id, 'hand-off summary');
    const events = store.getEvents(dst.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe('system');
    expect(events[0]?.content).toContain('hand-off');
  });

  it('sendToSession is a no-op when target does not exist', async () => {
    await expect(mgr.sendToSession('from-x', 'nonexistent', 'hi')).resolves.toBeUndefined();
  });

  it('compactSession rolls older events into a system summary', async () => {
    const s = await mgr.createSession({ agentId: 'a', channelType: 'webchat', conversationId: 'c2' });
    for (let i = 0; i < 30; i += 1) {
      store.addEvent({
        sessionId: s.id,
        eventType: 'user_message',
        role: 'user',
        content: `msg ${i}`,
        createdAt: nowMs() + i,
      });
    }
    const result = await mgr.compactSession(s.id);
    expect(result.removedEvents).toBeGreaterThan(0);
    const after = store.getEvents(s.id, 1000);
    expect(after.some((e) => e.eventType === 'compaction')).toBe(true);
  });

  // ─── ADR-010 ──────────────────────────────────────────────────────────

  it('appendEvent + loadHistory round-trip (ADR-010)', async () => {
    const s = await mgr.createSession({
      agentId: 'a',
      channelType: 'webchat',
      conversationId: 'c-adr010',
    });

    const base = Date.now();
    const id1 = await mgr.appendEvent(s.id, {
      eventType: 'user_message',
      role: 'user',
      content: 'hello',
      createdAt: base,
    });
    const id2 = await mgr.appendEvent(s.id, {
      eventType: 'agent_response',
      role: 'assistant',
      content: 'world',
      createdAt: base + 1,
    });

    expect(id2).toBeGreaterThan(id1);
    const hist = await mgr.loadHistory(s.id);
    expect(hist.map((e) => e.content)).toEqual(['hello', 'world']);
  });

  it('loadHistory excludes reasoning_step by default (ADR-010)', async () => {
    const s = await mgr.createSession({
      agentId: 'a',
      channelType: 'webchat',
      conversationId: 'c-adr010-rs',
    });

    await mgr.appendEvent(s.id, {
      eventType: 'reasoning_step',
      role: 'assistant',
      content: '{"kind":"thought"}',
    });
    await mgr.appendEvent(s.id, {
      eventType: 'user_message',
      role: 'user',
      content: 'q',
    });

    const hist = await mgr.loadHistory(s.id);
    expect(hist.map((e) => e.eventType)).toEqual(['user_message']);
  });
});
