import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { AuditEntry, Contracts } from '@agent-platform/core';

type AuditLog = Contracts.AuditLog;
type AuditLogQuery = Contracts.AuditLogQuery;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ego_audit (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp       INTEGER NOT NULL,
  trace_id        TEXT NOT NULL,
  tag             TEXT NOT NULL,
  actor           TEXT NOT NULL,
  action          TEXT NOT NULL,
  target          TEXT,
  parameters      TEXT,
  result          TEXT NOT NULL,
  risk_level      TEXT NOT NULL,
  session_id      TEXT,
  agent_id        TEXT,
  ego_decision_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_ego_audit_trace ON ego_audit(trace_id);
CREATE INDEX IF NOT EXISTS idx_ego_audit_tag ON ego_audit(tag, timestamp);
CREATE INDEX IF NOT EXISTS idx_ego_audit_session ON ego_audit(session_id, timestamp);
`;

function expandHome(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

type RawRow = {
  timestamp: number;
  trace_id: string;
  tag: string;
  actor: string;
  action: string;
  target: string | null;
  parameters: string | null;
  result: string;
  risk_level: string;
  session_id: string | null;
  agent_id: string | null;
  ego_decision_id: string | null;
};

function rowToEntry(row: RawRow): AuditEntry {
  return {
    timestamp: row.timestamp,
    traceId: row.trace_id,
    tag: row.tag as AuditEntry['tag'],
    actor: row.actor as AuditEntry['actor'],
    action: row.action,
    ...(row.target !== null ? { target: row.target } : {}),
    ...(row.parameters !== null
      ? { parameters: JSON.parse(row.parameters) as Record<string, unknown> }
      : {}),
    result: row.result as AuditEntry['result'],
    riskLevel: row.risk_level as AuditEntry['riskLevel'],
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    ...(row.agent_id !== null ? { agentId: row.agent_id } : {}),
    ...(row.ego_decision_id !== null ? { egoDecisionId: row.ego_decision_id } : {}),
  };
}

/**
 * SQLite-backed audit log (node:sqlite). Synchronous writes but exposed as
 * async to conform to the AuditLog contract.
 */
export class SqliteAuditLog implements AuditLog {
  private readonly db: DatabaseSync;

  constructor(storePath: string) {
    const path = expandHome(storePath);
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA_SQL);
  }

  async record(entry: AuditEntry): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO ego_audit (
        timestamp, trace_id, tag, actor, action, target, parameters,
        result, risk_level, session_id, agent_id, ego_decision_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entry.timestamp,
      entry.traceId,
      entry.tag,
      entry.actor,
      entry.action,
      entry.target ?? null,
      entry.parameters ? JSON.stringify(entry.parameters) : null,
      entry.result,
      entry.riskLevel,
      entry.sessionId ?? null,
      entry.agentId ?? null,
      entry.egoDecisionId ?? null,
    );
  }

  async query(q: AuditLogQuery): Promise<AuditEntry[]> {
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    if (q.tag) {
      clauses.push('tag = ?');
      args.push(q.tag);
    }
    if (q.sessionId) {
      clauses.push('session_id = ?');
      args.push(q.sessionId);
    }
    if (q.traceId) {
      clauses.push('trace_id = ?');
      args.push(q.traceId);
    }
    if (q.sinceMs) {
      clauses.push('timestamp >= ?');
      args.push(q.sinceMs);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = q.limit ?? 100;
    const stmt = this.db.prepare(
      `SELECT timestamp, trace_id, tag, actor, action, target, parameters, result,
              risk_level, session_id, agent_id, ego_decision_id
       FROM ego_audit ${where}
       ORDER BY timestamp DESC
       LIMIT ?`,
    );
    const rows = stmt.all(...args, limit) as unknown as RawRow[];
    return rows.map(rowToEntry);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
