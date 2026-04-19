import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionStore } from './store.js';
import { existsSync, unlinkSync } from 'node:fs';

const TEST_DB = './test-sessions.db';

describe('SessionStore', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore(TEST_DB);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const path = TEST_DB + suffix;
      if (existsSync(path)) unlinkSync(path);
    }
  });

  it('creates and retrieves a session', () => {
    const session = store.createSession({
      agentId: 'test-agent',
      channelType: 'webchat',
      conversationId: 'conv-1',
    });

    expect(session.id).toBeTruthy();
    expect(session.status).toBe('active');
    expect(session.agentId).toBe('test-agent');

    const retrieved = store.getSession(session.id);
    expect(retrieved).toEqual(session);
  });

  it('resolves existing session', () => {
    const created = store.createSession({
      agentId: 'a1',
      channelType: 'telegram',
      conversationId: 'c1',
    });

    const resolved = store.resolveSession('a1', 'telegram', 'c1');
    expect(resolved.id).toBe(created.id);
  });

  it('auto-creates session on resolve', () => {
    const resolved = store.resolveSession('a1', 'webchat', 'new-conv');
    expect(resolved.id).toBeTruthy();
    expect(resolved.status).toBe('active');
  });

  it('stores and retrieves events', () => {
    const session = store.createSession({
      agentId: 'a1',
      channelType: 'webchat',
      conversationId: 'c1',
    });

    store.addEvent({
      sessionId: session.id,
      eventType: 'user_message',
      role: 'user',
      content: 'Hello!',
      createdAt: Date.now(),
    });

    store.addEvent({
      sessionId: session.id,
      eventType: 'agent_response',
      role: 'assistant',
      content: 'Hi there!',
      createdAt: Date.now() + 1,
    });

    const events = store.getEvents(session.id);
    expect(events).toHaveLength(2);
    expect(events[0].content).toBe('Hello!');
    expect(events[1].content).toBe('Hi there!');
  });

  it('limits event retrieval', () => {
    const session = store.createSession({
      agentId: 'a1',
      channelType: 'webchat',
      conversationId: 'c1',
    });

    for (let i = 0; i < 10; i++) {
      store.addEvent({
        sessionId: session.id,
        eventType: 'user_message',
        role: 'user',
        content: `Message ${i}`,
        createdAt: Date.now() + i,
      });
    }

    const recent = store.getRecentEvents(session.id, 3);
    expect(recent).toHaveLength(3);
    expect(recent[2].content).toBe('Message 9');
  });

  // ─── ADR-010 ──────────────────────────────────────────────────────────

  it('appendEvent returns autoincrement id and loadHistory returns ascending order', () => {
    const session = store.createSession({
      agentId: 'a1',
      channelType: 'webchat',
      conversationId: 'c1',
    });

    const base = Date.now();
    const id1 = store.appendEvent(session.id, {
      eventType: 'user_message',
      role: 'user',
      content: 'first',
      createdAt: base,
    });
    const id2 = store.appendEvent(session.id, {
      eventType: 'agent_response',
      role: 'assistant',
      content: 'second',
      createdAt: base + 1,
    });

    expect(id2).toBeGreaterThan(id1);

    const history = store.loadHistory(session.id);
    expect(history.map((e) => e.content)).toEqual(['first', 'second']);
  });

  it('loadHistory excludes reasoning_step by default', () => {
    const session = store.createSession({
      agentId: 'a1',
      channelType: 'webchat',
      conversationId: 'c1',
    });

    const base = Date.now();
    store.appendEvent(session.id, {
      eventType: 'user_message',
      role: 'user',
      content: 'user',
      createdAt: base,
    });
    store.appendEvent(session.id, {
      eventType: 'reasoning_step',
      role: 'assistant',
      content: '{"kind":"thought"}',
      createdAt: base + 1,
    });
    store.appendEvent(session.id, {
      eventType: 'agent_response',
      role: 'assistant',
      content: 'resp',
      createdAt: base + 2,
    });

    const history = store.loadHistory(session.id);
    expect(history.map((e) => e.eventType)).toEqual(['user_message', 'agent_response']);

    // includeKinds 를 명시적으로 확장하면 reasoning_step 도 반환
    const full = store.loadHistory(session.id, {
      includeKinds: ['user_message', 'agent_response', 'reasoning_step'],
    });
    expect(full).toHaveLength(3);
  });

  it('loadHistory honors compaction boundary by default', () => {
    const session = store.createSession({
      agentId: 'a1',
      channelType: 'webchat',
      conversationId: 'c1',
    });

    const base = Date.now();
    store.appendEvent(session.id, {
      eventType: 'user_message',
      role: 'user',
      content: 'old-user',
      createdAt: base,
    });
    store.appendEvent(session.id, {
      eventType: 'agent_response',
      role: 'assistant',
      content: 'old-resp',
      createdAt: base + 1,
    });
    store.appendEvent(session.id, {
      eventType: 'compaction',
      role: 'system',
      content: 'SUMMARY',
      createdAt: base + 2,
    });
    store.appendEvent(session.id, {
      eventType: 'user_message',
      role: 'user',
      content: 'fresh-user',
      createdAt: base + 3,
    });

    const history = store.loadHistory(session.id);
    // compaction 자체 + 그 이후 이벤트만
    expect(history.map((e) => e.content)).toEqual(['SUMMARY', 'fresh-user']);

    // honorCompaction:false 면 전체 반환
    const full = store.loadHistory(session.id, { honorCompaction: false });
    expect(full).toHaveLength(4);
  });
});
