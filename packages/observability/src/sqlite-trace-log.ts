import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Contracts } from '@agent-platform/core';

type TraceLogger = Contracts.TraceLogger;
type TraceEvent = Contracts.TraceEvent;
type TraceBlock = Contracts.TraceBlock;
type TraceSpanOptions = Contracts.TraceSpanOptions;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS trace_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  trace_id     TEXT NOT NULL,
  session_id   TEXT,
  agent_id     TEXT,
  block        TEXT NOT NULL,
  event        TEXT NOT NULL,
  timestamp    INTEGER NOT NULL,
  duration_ms  INTEGER,
  payload      TEXT,
  error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_trace_events_trace ON trace_events(trace_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_trace_events_session ON trace_events(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_trace_events_block ON trace_events(block, timestamp);
`;

function expandHome(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

export interface SqliteTraceLogOptions {
  storePath: string;
  /** When > 0, DELETE rows older than (now - retentionDays) on construction. */
  retentionDays?: number;
}

/**
 * SQLite-backed trace event log. Mirror of `SqliteAuditLog` but dedicated
 * to pipeline-block telemetry. Writes are synchronous (node:sqlite) but
 * exposed as async/non-throwing per the `TraceLogger` contract — trace
 * logging is best-effort and never breaks the pipeline.
 */
export class SqliteTraceLog implements TraceLogger {
  private readonly db: DatabaseSync;

  constructor(options: SqliteTraceLogOptions) {
    const path = expandHome(options.storePath);
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA_SQL);

    if (options.retentionDays && options.retentionDays > 0) {
      this.pruneOlderThan(options.retentionDays);
    }
  }

  event(entry: TraceEvent): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO trace_events (
          trace_id, session_id, agent_id, block, event,
          timestamp, duration_ms, payload, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        entry.traceId,
        entry.sessionId ?? null,
        entry.agentId ?? null,
        entry.block,
        entry.event,
        entry.timestamp,
        entry.durationMs ?? null,
        entry.payload ? JSON.stringify(entry.payload) : null,
        entry.error ?? null,
      );
    } catch {
      // Trace logging is best-effort: never propagate write failures.
    }
  }

  async span<T>(opts: TraceSpanOptions, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    this.event({
      traceId: opts.traceId,
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
      block: opts.block,
      event: opts.event ?? 'enter',
      timestamp: start,
      ...(opts.payload ? { payload: opts.payload } : {}),
    });
    try {
      const result = await fn();
      this.event({
        traceId: opts.traceId,
        ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
        ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
        block: opts.block,
        event: opts.event ? `${opts.event}:exit` : 'exit',
        timestamp: Date.now(),
        durationMs: Date.now() - start,
      });
      return result;
    } catch (err) {
      this.event({
        traceId: opts.traceId,
        ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
        ...(opts.agentId !== undefined ? { agentId: opts.agentId } : {}),
        block: opts.block,
        event: 'error',
        timestamp: Date.now(),
        durationMs: Date.now() - start,
        error: (err as Error).message,
      });
      throw err;
    }
  }

  async close(): Promise<void> {
    try {
      this.db.close();
    } catch {
      // best-effort
    }
  }

  /** Visible for testing. */
  pruneOlderThan(retentionDays: number): number {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const stmt = this.db.prepare('DELETE FROM trace_events WHERE timestamp < ?');
    const info = stmt.run(cutoff) as { changes: number | bigint };
    return typeof info.changes === 'bigint' ? Number(info.changes) : info.changes;
  }

  // The raw db handle is exported for the query helpers in
  // `trace-query.ts`. No part of the public contract relies on this.
  get _db(): DatabaseSync {
    return this.db;
  }
}

export type { TraceBlock };
