import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Contracts } from '@agent-platform/core';

type TraceEvent = Contracts.TraceEvent;
type TraceBlock = Contracts.TraceBlock;

function expandHome(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

export interface TraceSummary {
  traceId: string;
  sessionId: string | null;
  agentId: string | null;
  startedAt: number;
  endedAt: number;
  totalMs: number;
  eventCount: number;
  /** First user-message text preview, if captured by G3 enter. */
  textPreview: string | null;
  /** EGO action if the E1 decision event was recorded. */
  egoAction: string | null;
  hasError: boolean;
}

/**
 * Read-only query helper against the trace_events SQLite table. The CLI
 * opens the DB itself via {@link openTraceDb} (no gateway required).
 */
export class TraceQuery {
  constructor(private readonly db: DatabaseSync) {}

  /** Return recent traces (newest first) grouped by trace_id. */
  listRecentTraces(options: { sessionId?: string; limit?: number } = {}): TraceSummary[] {
    const limit = options.limit ?? 20;
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    if (options.sessionId) {
      clauses.push('session_id = ?');
      args.push(options.sessionId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const sql = `
      SELECT
        trace_id,
        MIN(session_id) AS session_id,
        MIN(agent_id) AS agent_id,
        MIN(timestamp) AS started_at,
        MAX(timestamp) AS ended_at,
        COUNT(*) AS event_count,
        SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS error_count
      FROM trace_events
      ${where}
      GROUP BY trace_id
      ORDER BY started_at DESC
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(...args, limit) as {
      trace_id: string;
      session_id: string | null;
      agent_id: string | null;
      started_at: number;
      ended_at: number;
      event_count: number;
      error_count: number;
    }[];

    return rows.map((r) => {
      const textPreview = this.firstTextPreview(r.trace_id);
      const egoAction = this.firstEgoAction(r.trace_id);
      return {
        traceId: r.trace_id,
        sessionId: r.session_id,
        agentId: r.agent_id,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        totalMs: r.ended_at - r.started_at,
        eventCount: r.event_count,
        textPreview,
        egoAction,
        hasError: r.error_count > 0,
      };
    });
  }

  /** Ordered full timeline for a single trace. */
  getTraceTimeline(traceId: string): TraceEvent[] {
    // Pre-`summary` databases lack the column; we left-join via COALESCE on a
    // computed expression. Newer DBs always have the column populated.
    const hasSummaryColumn = this.tableHasColumn('trace_events', 'summary');
    const summarySelect = hasSummaryColumn ? 'summary' : 'NULL AS summary';
    const sql = `
      SELECT trace_id, session_id, agent_id, block, event, timestamp,
             duration_ms, ${summarySelect}, payload, error
      FROM trace_events
      WHERE trace_id = ?
      ORDER BY id ASC
    `;
    const rows = this.db.prepare(sql).all(traceId) as {
      trace_id: string;
      session_id: string | null;
      agent_id: string | null;
      block: string;
      event: string;
      timestamp: number;
      duration_ms: number | null;
      summary: string | null;
      payload: string | null;
      error: string | null;
    }[];
    return rows.map((r) => {
      const ev: TraceEvent = {
        traceId: r.trace_id,
        block: r.block as TraceBlock,
        event: r.event,
        timestamp: r.timestamp,
      };
      if (r.session_id !== null) ev.sessionId = r.session_id;
      if (r.agent_id !== null) ev.agentId = r.agent_id;
      if (r.duration_ms !== null) ev.durationMs = r.duration_ms;
      if (r.summary !== null) ev.summary = r.summary;
      if (r.payload !== null) ev.payload = JSON.parse(r.payload) as Record<string, unknown>;
      if (r.error !== null) ev.error = r.error;
      return ev;
    });
  }

  private tableHasColumn(table: string, column: string): boolean {
    try {
      const cols = this.db
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<{ name: string }>;
      return cols.some((c) => c.name === column);
    } catch {
      return false;
    }
  }

  /** Most recent traceId (optionally filtered by session), or null. */
  getLastTraceId(sessionId?: string): string | null {
    const sql = sessionId
      ? 'SELECT trace_id FROM trace_events WHERE session_id = ? ORDER BY id DESC LIMIT 1'
      : 'SELECT trace_id FROM trace_events ORDER BY id DESC LIMIT 1';
    const args: string[] = sessionId ? [sessionId] : [];
    const row = this.db.prepare(sql).get(...args) as { trace_id: string } | undefined;
    return row?.trace_id ?? null;
  }

  private firstTextPreview(traceId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT payload FROM trace_events
         WHERE trace_id = ? AND block = 'G3' AND event = 'enter' AND payload IS NOT NULL
         ORDER BY id ASC LIMIT 1`,
      )
      .get(traceId) as { payload: string } | undefined;
    if (!row) return null;
    try {
      const payload = JSON.parse(row.payload) as { textPreview?: unknown };
      return typeof payload.textPreview === 'string' ? payload.textPreview : null;
    } catch {
      return null;
    }
  }

  private firstEgoAction(traceId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT payload FROM trace_events
         WHERE trace_id = ? AND block = 'E1' AND event = 'decision' AND payload IS NOT NULL
         ORDER BY id ASC LIMIT 1`,
      )
      .get(traceId) as { payload: string } | undefined;
    if (!row) return null;
    try {
      const payload = JSON.parse(row.payload) as { action?: unknown };
      return typeof payload.action === 'string' ? payload.action : null;
    } catch {
      return null;
    }
  }
}

/** Open the trace DB read-only for CLI use. Caller must call close(). */
export function openTraceDb(storePath: string): {
  db: DatabaseSync;
  query: TraceQuery;
} {
  const db = new DatabaseSync(expandHome(storePath), { readOnly: true });
  return { db, query: new TraceQuery(db) };
}
