import { DatabaseSync } from 'node:sqlite';
import type {
  CompactionResult,
  CreateSessionParams,
  LoadHistoryOptions,
  Session,
  SessionEvent,
  SessionEventInput,
  SessionEventType,
  SessionPatch,
} from '@agent-platform/core';
import { DEFAULT_PROMPT_EVENT_KINDS, generateId, nowMs } from '@agent-platform/core';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL,
  channel_type    TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  status          TEXT DEFAULT 'active',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  metadata        TEXT,
  UNIQUE(agent_id, channel_type, conversation_id)
);

CREATE TABLE IF NOT EXISTS session_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  event_type  TEXT NOT NULL,  -- 'user_message' | 'agent_response' | 'tool_call' | 'tool_result'
                              -- | 'reasoning_step' | 'compaction' | 'system'
                              -- (reasoning_step: ADR-010, 관측 전용. loadHistory 기본값에서 제외)
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  token_count INTEGER,
  cost_usd    REAL,
  trace_id    TEXT,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_trace ON session_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status, updated_at);
`;

const MAX_HISTORY_LIMIT = 500;
const DEFAULT_HISTORY_LIMIT = 100;

export class SessionStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);
  }

  resolveSession(agentId: string, channelType: string, conversationId: string): Session {
    return this.resolveSessionWithNewFlag(agentId, channelType, conversationId).session;
  }

  /**
   * ADR-010: resolveSession 과 동일하나 "새로 생성됐는가(isNew)" 를 함께 반환.
   * hibernated 히트는 자동으로 resumeSession 된다(isNew=false).
   */
  resolveSessionWithNewFlag(
    agentId: string,
    channelType: string,
    conversationId: string,
  ): { session: Session; isNew: boolean } {
    const stmt = this.db.prepare(
      'SELECT * FROM sessions WHERE agent_id = ? AND channel_type = ? AND conversation_id = ?',
    );
    const row = stmt.get(agentId, channelType, conversationId) as SessionRow | undefined;

    if (row) {
      const existing = rowToSession(row);
      if (existing.status === 'hibernated') {
        return { session: this.resumeSession(existing.id), isNew: false };
      }
      return { session: existing, isNew: false };
    }

    return {
      session: this.createSession({ agentId, channelType, conversationId }),
      isNew: true,
    };
  }

  getSession(sessionId: string): Session | null {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    const row = stmt.get(sessionId) as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  createSession(params: CreateSessionParams): Session {
    const now = nowMs();
    const id = generateId();
    const metadata = params.metadata ? JSON.stringify(params.metadata) : null;

    const stmt = this.db.prepare(
      `INSERT INTO sessions (id, agent_id, channel_type, conversation_id, status, created_at, updated_at, metadata)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    );
    stmt.run(id, params.agentId, params.channelType, params.conversationId, now, now, metadata);

    const session: Session = {
      id,
      agentId: params.agentId,
      channelType: params.channelType,
      conversationId: params.conversationId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    if (params.metadata) session.metadata = params.metadata;
    return session;
  }

  updateSession(sessionId: string, patch: SessionPatch): Session {
    const existing = this.getSession(sessionId);
    if (!existing) throw new Error(`Session ${sessionId} not found`);

    const now = nowMs();
    const nextStatus = patch.status ?? existing.status;
    const nextMetadata = patch.metadata
      ? { ...(existing.metadata ?? {}), ...patch.metadata }
      : existing.metadata;

    const stmt = this.db.prepare(
      'UPDATE sessions SET status = ?, updated_at = ?, metadata = ? WHERE id = ?',
    );
    stmt.run(
      nextStatus,
      now,
      nextMetadata ? JSON.stringify(nextMetadata) : null,
      sessionId,
    );

    const result: Session = {
      ...existing,
      status: nextStatus,
      updatedAt: now,
    };
    if (nextMetadata !== undefined) result.metadata = nextMetadata;
    return result;
  }

  /**
   * Summarize older events into a single 'compaction' event. Trivial
   * implementation: keep the most recent `keepRecent` events and roll the rest
   * into a system-role compaction event with a plain-text summary. Real
   * LLM-based compaction can replace this in a later phase.
   */
  compactSession(sessionId: string, keepRecent = 20): CompactionResult {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const allEvents = this.getEvents(sessionId, 10_000);
    const toCompact = allEvents.slice(0, Math.max(0, allEvents.length - keepRecent));

    if (toCompact.length === 0) {
      return {
        sessionId,
        removedEvents: 0,
        tokensBefore: 0,
        tokensAfter: 0,
      };
    }

    const tokensBefore = toCompact.reduce((acc, e) => acc + (e.tokenCount ?? 0), 0);
    const summary = toCompact
      .map((e) => `[${e.role}/${e.eventType}] ${truncate(e.content, 200)}`)
      .join('\n');

    const summaryEventId = this.addEvent({
      sessionId,
      eventType: 'compaction',
      role: 'system',
      content: `Compacted ${toCompact.length} events:\n${summary}`,
      createdAt: nowMs(),
      ...(tokensBefore > 0 ? { tokenCount: Math.ceil(tokensBefore / 10) } : {}),
    });

    const deleteStmt = this.db.prepare(
      'DELETE FROM session_events WHERE session_id = ? AND id IN (SELECT id FROM session_events WHERE session_id = ? ORDER BY created_at ASC LIMIT ?)',
    );
    deleteStmt.run(sessionId, sessionId, toCompact.length);

    return {
      sessionId,
      removedEvents: toCompact.length,
      summaryEventId,
      tokensBefore,
      tokensAfter: Math.ceil(tokensBefore / 10),
    };
  }

  hibernateSession(sessionId: string): void {
    this.updateSession(sessionId, { status: 'hibernated' });
  }

  resumeSession(sessionId: string): Session {
    return this.updateSession(sessionId, { status: 'active' });
  }

  listSessions(filter?: { status?: Session['status']; agentId?: string }): Session[] {
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    if (filter?.status) {
      clauses.push('status = ?');
      args.push(filter.status);
    }
    if (filter?.agentId) {
      clauses.push('agent_id = ?');
      args.push(filter.agentId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const stmt = this.db.prepare(
      `SELECT * FROM sessions ${where} ORDER BY updated_at DESC LIMIT 500`,
    );
    const rows = stmt.all(...args) as unknown as SessionRow[];
    return rows.map(rowToSession);
  }

  addEvent(event: Omit<SessionEvent, 'id'>): number {
    const stmt = this.db.prepare(
      `INSERT INTO session_events (session_id, event_type, role, content, token_count, cost_usd, trace_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      event.sessionId,
      event.eventType,
      event.role,
      event.content,
      event.tokenCount ?? null,
      event.costUsd ?? null,
      event.traceId ?? null,
      event.createdAt,
    );

    // Update session timestamp
    const updateStmt = this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?');
    updateStmt.run(event.createdAt, event.sessionId);

    return Number(result.lastInsertRowid);
  }

  getEvents(sessionId: string, limit = 50): SessionEvent[] {
    const stmt = this.db.prepare(
      'SELECT * FROM session_events WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
    );
    const rows = stmt.all(sessionId, limit) as unknown as SessionEventRow[];
    return rows.reverse().map(rowToEvent);
  }

  getRecentEvents(sessionId: string, count: number): SessionEvent[] {
    const stmt = this.db.prepare(
      'SELECT * FROM session_events WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
    );
    const rows = stmt.all(sessionId, count) as unknown as SessionEventRow[];
    return rows.reverse().map(rowToEvent);
  }

  /**
   * ADR-010: session_events 에 단일 이벤트를 append. INSERT only.
   * createdAt 미지정 시 nowMs() 로 자동 부여. 반환값은 autoincrement id.
   * 실패 시 addEvent 와 동일하게 예외 전파.
   */
  appendEvent(sessionId: string, input: SessionEventInput): number {
    return this.addEvent({
      sessionId,
      eventType: input.eventType,
      role: input.role,
      content: input.content,
      createdAt: input.createdAt ?? nowMs(),
      ...(input.tokenCount !== undefined ? { tokenCount: input.tokenCount } : {}),
      ...(input.costUsd !== undefined ? { costUsd: input.costUsd } : {}),
      ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
    });
  }

  /**
   * ADR-010: 시간 오름차순으로 이력 반환.
   *   - honorCompaction (기본 true): 최신 compaction 이벤트 이후만 반환.
   *     그 자체(compaction) 는 summary 로서 결과에 포함.
   *   - includeKinds (기본 DEFAULT_PROMPT_EVENT_KINDS): reasoning_step 기본 제외.
   *   - limit (기본 100, 최대 500). sinceId: id > sinceId 만.
   */
  loadHistory(sessionId: string, opts: LoadHistoryOptions = {}): SessionEvent[] {
    const honorCompaction = opts.honorCompaction ?? true;
    const includeKinds = opts.includeKinds ?? DEFAULT_PROMPT_EVENT_KINDS;
    const limit = Math.min(opts.limit ?? DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
    const sinceId = opts.sinceId ?? 0;

    // compaction 경계 찾기
    let compactionFloorId = 0;
    if (honorCompaction) {
      const stmt = this.db.prepare(
        `SELECT id FROM session_events
         WHERE session_id = ? AND event_type = 'compaction'
         ORDER BY id DESC LIMIT 1`,
      );
      const row = stmt.get(sessionId) as { id: number } | undefined;
      if (row) compactionFloorId = row.id - 1; // compaction 자체는 포함
    }

    const floorId = Math.max(sinceId, compactionFloorId);

    // includeKinds 가 빈 배열이면 결과 없음
    if (includeKinds.length === 0) return [];

    const placeholders = includeKinds.map(() => '?').join(',');
    const stmt = this.db.prepare(
      `SELECT * FROM session_events
       WHERE session_id = ?
         AND id > ?
         AND event_type IN (${placeholders})
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    );
    const rows = stmt.all(
      sessionId,
      floorId,
      ...(includeKinds as readonly SessionEventType[]),
      limit,
    ) as unknown as SessionEventRow[];
    return rows.map(rowToEvent);
  }

  close(): void {
    this.db.close();
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

// ─── Internal types ───

interface SessionRow {
  id: string;
  agent_id: string;
  channel_type: string;
  conversation_id: string;
  status: string;
  created_at: number;
  updated_at: number;
  metadata: string | null;
}

interface SessionEventRow {
  id: number;
  session_id: string;
  event_type: string;
  role: string;
  content: string;
  token_count: number | null;
  cost_usd: number | null;
  trace_id: string | null;
  created_at: number;
}

function rowToSession(row: SessionRow): Session {
  const session: Session = {
    id: row.id,
    agentId: row.agent_id,
    channelType: row.channel_type,
    conversationId: row.conversation_id,
    status: row.status as Session['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.metadata) {
    session.metadata = JSON.parse(row.metadata) as Record<string, unknown>;
  }
  return session;
}

function rowToEvent(row: SessionEventRow): SessionEvent {
  const event: SessionEvent = {
    id: row.id,
    sessionId: row.session_id,
    eventType: row.event_type as SessionEvent['eventType'],
    role: row.role as SessionEvent['role'],
    content: row.content,
    createdAt: row.created_at,
  };
  if (row.token_count !== null) event.tokenCount = row.token_count;
  if (row.cost_usd !== null) event.costUsd = row.cost_usd;
  if (row.trace_id !== null) event.traceId = row.trace_id;
  return event;
}
