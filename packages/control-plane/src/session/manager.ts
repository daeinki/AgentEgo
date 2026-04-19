import type {
  CompactionResult,
  Contracts,
  CreateSessionParams,
  LoadHistoryOptions,
  Session,
  SessionEvent,
  SessionEventInput,
  SessionPatch,
  StandardMessage,
} from '@agent-platform/core';
import { nowMs } from '@agent-platform/core';
import { SessionStore } from './store.js';

type SessionManager = Contracts.SessionManager;

export interface SessionManagerConfig {
  defaultAgentId: string;
}

/**
 * Thin façade over SessionStore that implements the Contracts.SessionManager
 * interface. Callers (EGO, CLI, Gateway) should hold this rather than the raw
 * SessionStore so they remain decoupled from SQLite.
 */
export class ControlPlaneSessionManager implements SessionManager {
  constructor(
    private readonly store: SessionStore,
    private readonly config: SessionManagerConfig,
  ) {}

  async resolveSession(msg: StandardMessage): Promise<Session> {
    return this.store.resolveSession(
      this.config.defaultAgentId,
      msg.channel.type,
      msg.conversation.id,
    );
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return this.store.getSession(sessionId);
  }

  async createSession(params: CreateSessionParams): Promise<Session> {
    return this.store.createSession(params);
  }

  async updateSession(sessionId: string, patch: SessionPatch): Promise<Session> {
    return this.store.updateSession(sessionId, patch);
  }

  async appendEvent(sessionId: string, event: SessionEventInput): Promise<number> {
    return this.store.appendEvent(sessionId, event);
  }

  async loadHistory(sessionId: string, opts?: LoadHistoryOptions): Promise<SessionEvent[]> {
    return this.store.loadHistory(sessionId, opts);
  }

  async compactSession(sessionId: string): Promise<CompactionResult> {
    return this.store.compactSession(sessionId);
  }

  async hibernateSession(sessionId: string): Promise<void> {
    this.store.hibernateSession(sessionId);
  }

  async resumeSession(sessionId: string): Promise<Session> {
    return this.store.resumeSession(sessionId);
  }

  async sendToSession(fromId: string, toId: string, msg: string): Promise<void> {
    // Record a system event on the target session documenting the cross-session
    // message. If the target session doesn't exist we treat it as a no-op — the
    // caller is expected to create the target first (EGO redirect does this).
    const target = this.store.getSession(toId);
    if (!target) return;
    this.store.addEvent({
      sessionId: toId,
      eventType: 'system',
      role: 'system',
      content: msg,
      createdAt: nowMs(),
      traceId: `cross:${fromId}`,
    });
  }
}
