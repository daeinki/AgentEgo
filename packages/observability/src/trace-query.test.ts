import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteTraceLog } from './sqlite-trace-log.js';
import { TraceQuery } from './trace-query.js';

let tempDir: string;
let log: SqliteTraceLog;
let q: TraceQuery;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'trace-query-test-'));
  log = new SqliteTraceLog({ storePath: join(tempDir, 'traces.db') });
  q = new TraceQuery(log._db);
});

afterEach(async () => {
  await log.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function seedTrace(
  traceId: string,
  sessionId: string,
  opts: { text?: string; action?: string; withError?: boolean } = {},
): void {
  const t0 = Date.now();
  log.event({
    traceId,
    sessionId,
    block: 'G3',
    event: 'enter',
    timestamp: t0,
    payload: opts.text ? { textPreview: opts.text } : undefined,
  });
  if (opts.action) {
    log.event({
      traceId,
      sessionId,
      block: 'E1',
      event: 'decision',
      timestamp: t0 + 5,
      payload: { action: opts.action, confidence: 0.8 },
    });
  }
  if (opts.withError) {
    log.event({
      traceId,
      sessionId,
      block: 'W1',
      event: 'error',
      timestamp: t0 + 10,
      error: 'oops',
    });
  }
  log.event({
    traceId,
    sessionId,
    block: 'G3',
    event: 'exit',
    timestamp: t0 + 20,
    durationMs: 20,
  });
}

describe('TraceQuery', () => {
  it('listRecentTraces groups events by traceId and returns newest first', async () => {
    seedTrace('t-1', 's-A', { text: 'hi', action: 'passthrough' });
    await new Promise((r) => setTimeout(r, 5));
    seedTrace('t-2', 's-B', { text: 'weather?', action: 'enrich' });

    const list = q.listRecentTraces();
    expect(list).toHaveLength(2);
    expect(list[0]!.traceId).toBe('t-2');
    expect(list[0]!.sessionId).toBe('s-B');
    expect(list[0]!.textPreview).toBe('weather?');
    expect(list[0]!.egoAction).toBe('enrich');
    expect(list[0]!.eventCount).toBe(3);
    expect(list[0]!.hasError).toBe(false);
    expect(list[1]!.traceId).toBe('t-1');
  });

  it('listRecentTraces filters by sessionId', () => {
    seedTrace('t-1', 's-A');
    seedTrace('t-2', 's-B');
    seedTrace('t-3', 's-A');

    const filtered = q.listRecentTraces({ sessionId: 's-A' });
    const ids = filtered.map((r) => r.traceId).sort();
    expect(ids).toEqual(['t-1', 't-3']);
  });

  it('listRecentTraces reports hasError:true when error rows exist', () => {
    seedTrace('t-err', 's-A', { withError: true });
    const list = q.listRecentTraces();
    expect(list[0]!.hasError).toBe(true);
  });

  it('listRecentTraces honors limit', () => {
    for (let i = 0; i < 5; i++) seedTrace(`t-${i}`, 's');
    expect(q.listRecentTraces({ limit: 3 })).toHaveLength(3);
  });

  it('getTraceTimeline returns events in insertion order with parsed payloads', () => {
    seedTrace('t-1', 's-A', { text: 'hello', action: 'direct_response' });
    const tl = q.getTraceTimeline('t-1');
    expect(tl.map((e) => e.event)).toEqual(['enter', 'decision', 'exit']);
    expect(tl[0]!.payload).toEqual({ textPreview: 'hello' });
    expect(tl[1]!.payload).toEqual({ action: 'direct_response', confidence: 0.8 });
    expect(tl[2]!.durationMs).toBe(20);
  });

  it('getTraceTimeline returns [] for an unknown traceId', () => {
    expect(q.getTraceTimeline('t-missing')).toEqual([]);
  });

  it('getLastTraceId returns the most recent trace, or null when empty', () => {
    expect(q.getLastTraceId()).toBeNull();
    seedTrace('t-1', 's-A');
    seedTrace('t-2', 's-B');
    expect(q.getLastTraceId()).toBe('t-2');
    expect(q.getLastTraceId('s-A')).toBe('t-1');
    expect(q.getLastTraceId('s-Z')).toBeNull();
  });
});
