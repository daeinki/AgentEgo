import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAuditLog } from './audit-log.js';
import type { AuditEntry } from '@agent-platform/core';

describe('SqliteAuditLog', () => {
  let dir: string;
  let path: string;
  let log: SqliteAuditLog;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'ego-audit-'));
    path = resolve(dir, 'audit.db');
    log = new SqliteAuditLog(path);
  });

  afterEach(async () => {
    await log.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const entry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
    timestamp: Date.now(),
    traceId: 'trc-test',
    tag: 'ego_decision',
    actor: 'ego',
    action: 'ego.deep_path',
    result: 'success',
    riskLevel: 'low',
    sessionId: 'sess-a',
    agentId: 'agent-x',
    egoDecisionId: 'ego-1',
    parameters: { action: 'passthrough', intent: 'question' },
    ...overrides,
  });

  it('records and retrieves entries by trace', async () => {
    await log.record(entry({ traceId: 'trc-aaa' }));
    const rows = await log.query({ traceId: 'trc-aaa' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.egoDecisionId).toBe('ego-1');
    expect(rows[0]?.parameters).toMatchObject({ action: 'passthrough' });
  });

  it('filters by tag', async () => {
    await log.record(entry({ tag: 'ego_decision' }));
    await log.record(entry({ tag: 'memory_timeout' }));
    const rows = await log.query({ tag: 'memory_timeout' });
    expect(rows).toHaveLength(1);
  });

  it('filters by sinceMs', async () => {
    const base = Date.now();
    await log.record(entry({ timestamp: base - 60_000 }));
    await log.record(entry({ timestamp: base }));
    const rows = await log.query({ sinceMs: base - 10_000 });
    expect(rows).toHaveLength(1);
  });

  it('limits results and orders newest first', async () => {
    const base = Date.now();
    for (let i = 0; i < 10; i += 1) {
      await log.record(entry({ timestamp: base + i }));
    }
    const rows = await log.query({ limit: 3 });
    expect(rows).toHaveLength(3);
    expect(rows[0]!.timestamp).toBeGreaterThan(rows[2]!.timestamp);
  });
});
