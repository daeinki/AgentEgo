import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Contracts } from '@agent-platform/core';
import { SqliteTraceLog } from './sqlite-trace-log.js';

let tempDir: string;
let dbPath: string;
let log: SqliteTraceLog;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'trace-log-test-'));
  dbPath = join(tempDir, 'traces.db');
  log = new SqliteTraceLog({ storePath: dbPath });
});

afterEach(async () => {
  await log.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('SqliteTraceLog', () => {
  it('event() inserts a row readable via query', async () => {
    log.event({
      traceId: 'trc-1',
      sessionId: 'ses-1',
      agentId: 'agt-1',
      block: 'G3',
      event: 'enter',
      timestamp: 1000,
      payload: { textPreview: 'hi' },
    });

    const rows = log._db
      .prepare('SELECT * FROM trace_events WHERE trace_id = ?')
      .all('trc-1');
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row['block']).toBe('G3');
    expect(row['event']).toBe('enter');
    expect(row['timestamp']).toBe(1000);
    expect(JSON.parse(row['payload'] as string)).toEqual({ textPreview: 'hi' });
    expect(row['duration_ms']).toBe(null);
  });

  it('span() emits enter + exit rows around a successful fn', async () => {
    const result = await log.span<number>(
      { traceId: 'trc-2', block: 'P1' },
      async () => {
        await new Promise((r) => setTimeout(r, 5));
        return 42;
      },
    );
    expect(result).toBe(42);

    const rows = log._db
      .prepare(
        'SELECT event, duration_ms FROM trace_events WHERE trace_id = ? ORDER BY id',
      )
      .all('trc-2') as { event: string; duration_ms: number | null }[];
    expect(rows.map((r) => r.event)).toEqual(['enter', 'exit']);
    expect(rows[0]!.duration_ms).toBe(null);
    expect(rows[1]!.duration_ms).not.toBe(null);
    expect(rows[1]!.duration_ms!).toBeGreaterThanOrEqual(0);
  });

  it('span() emits enter + error on a failing fn and rethrows', async () => {
    await expect(
      log.span({ traceId: 'trc-3', block: 'P1' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const rows = log._db
      .prepare(
        'SELECT event, error FROM trace_events WHERE trace_id = ? ORDER BY id',
      )
      .all('trc-3') as { event: string; error: string | null }[];
    expect(rows.map((r) => r.event)).toEqual(['enter', 'error']);
    expect(rows[1]!.error).toBe('boom');
  });

  it('event() swallows write errors silently (closed DB)', async () => {
    await log.close();
    const entry: Contracts.TraceEvent = {
      traceId: 'trc-4',
      block: 'G3',
      event: 'enter',
      timestamp: 1,
    };
    expect(() => log.event(entry)).not.toThrow();
  });

  it('pruneOlderThan deletes rows older than cutoff and keeps fresh ones', async () => {
    const old = Date.now() - 30 * 86_400_000;
    const fresh = Date.now();
    log.event({ traceId: 't-old', block: 'G3', event: 'enter', timestamp: old });
    log.event({ traceId: 't-new', block: 'G3', event: 'enter', timestamp: fresh });

    const deleted = log.pruneOlderThan(14);
    expect(deleted).toBe(1);

    const remaining = log._db
      .prepare('SELECT trace_id FROM trace_events ORDER BY id')
      .all() as { trace_id: string }[];
    expect(remaining.map((r) => r.trace_id)).toEqual(['t-new']);
  });

  it('retentionDays option prunes on construction', async () => {
    const old = Date.now() - 100 * 86_400_000;
    log.event({ traceId: 't-very-old', block: 'G3', event: 'enter', timestamp: old });
    await log.close();

    const log2 = new SqliteTraceLog({ storePath: dbPath, retentionDays: 7 });
    const rows = log2._db.prepare('SELECT * FROM trace_events').all();
    expect(rows).toHaveLength(0);
    log = log2;
  });
});
