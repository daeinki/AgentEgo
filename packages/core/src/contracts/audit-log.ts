import type { AuditEntry, AuditTag } from '../schema/observability.js';

export interface AuditLogQuery {
  tag?: AuditTag;
  sessionId?: string;
  traceId?: string;
  sinceMs?: number;
  limit?: number;
}

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
  query(q: AuditLogQuery): Promise<AuditEntry[]>;
  close(): Promise<void>;
}
