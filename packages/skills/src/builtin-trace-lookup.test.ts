import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const BUILTIN_DIR = resolve(
  fileURLToPath(new URL('../builtin/trace-lookup', import.meta.url)),
);
const ENTRY = resolve(BUILTIN_DIR, 'index.js');

// Real CREATE TABLE mirrored from packages/observability/src/sqlite-trace-log.ts.
// Keeping this identical to the production schema is the point — if the prod
// schema changes, this test (and the skill's SELECTs) must be updated together.
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

interface LoadedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  execute(args: unknown, ctx?: unknown): Promise<{
    toolName: string;
    success: boolean;
    output?: string;
    error?: string;
    durationMs: number;
  }>;
}

interface Factory {
  createTools(ctx: { manifest: { id: string; version: string }; installDir: string }): LoadedTool[];
}

function seedFixture(dbPath: string): { t0: number; t1: number; t2: number } {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL);
  const ins = db.prepare(
    `INSERT INTO trace_events (trace_id, session_id, agent_id, block, event, timestamp, duration_ms, payload, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // trc-A: session s1, clean turn (oldest)
  const t0 = Date.now() - 60_000;
  ins.run('trc-A', 's1', 'agent-1', 'G3', 'enter', t0, null, JSON.stringify({ textPreview: 'hello world' }), null);
  ins.run('trc-A', 's1', 'agent-1', 'E1', 'decision', t0 + 10, 4, JSON.stringify({ action: 'tool_use', confidence: 0.9 }), null);
  ins.run('trc-A', 's1', 'agent-1', 'W1', 'tool_call', t0 + 20, 90, JSON.stringify({ toolName: 'bash', success: true }), null);

  // trc-B: session s1, with an error (middle)
  const t1 = Date.now() - 10_000;
  ins.run('trc-B', 's1', 'agent-1', 'G3', 'enter', t1, null, JSON.stringify({ textPreview: 'second turn' }), null);
  ins.run('trc-B', 's1', 'agent-1', 'W1', 'error', t1 + 5, 3, null, 'boom');

  // trc-C: session s2 (newest)
  const t2 = Date.now() - 1_000;
  ins.run('trc-C', 's2', 'agent-1', 'G3', 'enter', t2, null, JSON.stringify({ textPreview: 'other session' }), null);
  db.close();
  return { t0, t1, t2 };
}

async function loadTools(): Promise<Map<string, LoadedTool>> {
  const mod = (await import(`file://${ENTRY.replace(/\\/g, '/')}`)) as Factory;
  const tools = mod.createTools({
    manifest: { id: 'trace-lookup', version: '0.1.0' },
    installDir: dirname(ENTRY),
  });
  return new Map(tools.map((t) => [t.name, t]));
}

describe('builtin trace-lookup skill', () => {
  let stateDir: string;
  let tools: Map<string, LoadedTool>;
  const prevStateDir = process.env.AGENT_STATE_DIR;

  beforeAll(async () => {
    stateDir = mkdtempSync(resolve(tmpdir(), 'trace-lookup-'));
    mkdirSync(resolve(stateDir, 'trace'), { recursive: true });
    seedFixture(resolve(stateDir, 'trace', 'traces.db'));
    process.env.AGENT_STATE_DIR = stateDir;
    tools = await loadTools();
  });

  afterAll(() => {
    if (prevStateDir === undefined) delete process.env.AGENT_STATE_DIR;
    else process.env.AGENT_STATE_DIR = prevStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('exposes three tools', () => {
    expect(tools.size).toBe(3);
    expect(tools.has('trace.list')).toBe(true);
    expect(tools.has('trace.show')).toBe(true);
    expect(tools.has('trace.last')).toBe(true);
  });

  describe('trace.list', () => {
    it('returns newest-first rows with a header', async () => {
      const res = await tools.get('trace.list')!.execute({});
      expect(res.success).toBe(true);
      const out = res.output ?? '';
      expect(out).toMatch(/^startedAt\s+traceId/);
      // Newest first: trc-C appears before trc-B which appears before trc-A.
      const idxC = out.indexOf('trc-C');
      const idxB = out.indexOf('trc-B');
      const idxA = out.indexOf('trc-A');
      expect(idxC).toBeGreaterThan(-1);
      expect(idxB).toBeGreaterThan(idxC);
      expect(idxA).toBeGreaterThan(idxB);
      // Error tag rendered for trc-B.
      expect(out).toMatch(/trc-B.*\[err\]/);
    });

    it('filters by sessionId', async () => {
      const res = await tools.get('trace.list')!.execute({ sessionId: 's1' });
      expect(res.success).toBe(true);
      const out = res.output ?? '';
      expect(out).toContain('trc-A');
      expect(out).toContain('trc-B');
      expect(out).not.toContain('trc-C');
    });

    it('honors limit', async () => {
      const res = await tools.get('trace.list')!.execute({ limit: 1 });
      expect(res.success).toBe(true);
      const out = res.output ?? '';
      // Header + one row.
      const dataLines = out.split('\n').slice(1);
      expect(dataLines).toHaveLength(1);
      expect(dataLines[0]).toContain('trc-C');
    });

    it('clamps absurd limit to 50', async () => {
      const res = await tools.get('trace.list')!.execute({ limit: 10_000 });
      expect(res.success).toBe(true);
      // We only inserted 3 traces, so at most 3 rows — but the clamp path must
      // not reject the call.
      expect((res.output ?? '').split('\n').length).toBe(1 + 3);
    });

    it('surfaces EGO action in the row', async () => {
      const res = await tools.get('trace.list')!.execute({ sessionId: 's1' });
      // trc-A has E1 decision with action=tool_use.
      expect(res.output ?? '').toContain('tool_use');
    });
  });

  describe('trace.show', () => {
    it('returns the full timeline in order', async () => {
      const res = await tools.get('trace.show')!.execute({ traceId: 'trc-A' });
      expect(res.success).toBe(true);
      const out = res.output ?? '';
      // All three blocks present, in order.
      const idxG3 = out.indexOf('G3');
      const idxE1 = out.indexOf('E1');
      const idxW1 = out.indexOf('W1');
      expect(idxG3).toBeGreaterThan(-1);
      expect(idxE1).toBeGreaterThan(idxG3);
      expect(idxW1).toBeGreaterThan(idxE1);
      // Payload summary used whitelist keys.
      expect(out).toContain('textPreview=');
      expect(out).toContain('action=');
      expect(out).toContain('toolName=');
    });

    it('applies blockFilter', async () => {
      const res = await tools
        .get('trace.show')!
        .execute({ traceId: 'trc-A', blockFilter: ['E1'] });
      expect(res.success).toBe(true);
      const out = res.output ?? '';
      expect(out).toContain('E1');
      // G3 and W1 must be absent when filtered out.
      expect(out).not.toMatch(/\bG3\b/);
      expect(out).not.toMatch(/\bW1\b/);
    });

    it('reports unknown traceId with a discovery hint', async () => {
      const res = await tools.get('trace.show')!.execute({ traceId: 'trc-missing' });
      expect(res.success).toBe(false);
      expect(res.error ?? '').toContain('no events for traceId');
      expect(res.error ?? '').toContain('trace.list');
    });

    it('rejects missing traceId', async () => {
      const res = await tools.get('trace.show')!.execute({});
      expect(res.success).toBe(false);
      expect(res.error ?? '').toContain('traceId is required');
    });

    it('renders error field when present', async () => {
      const res = await tools.get('trace.show')!.execute({ traceId: 'trc-B' });
      expect(res.success).toBe(true);
      expect(res.output ?? '').toContain('error="boom"');
    });

    // Intentionally placed AFTER the trace.last suite below: inserting a
    // trc-BUSY trace mutates the shared fixture and, because getLastTraceId
    // orders by insertion id (not timestamp), would shadow trc-C as "last".
  });

  describe('trace.last', () => {
    it('returns the most recent trace with header + timeline', async () => {
      const res = await tools.get('trace.last')!.execute({});
      expect(res.success).toBe(true);
      const out = res.output ?? '';
      expect(out).toMatch(/^startedAt/);
      expect(out).toContain('trc-C');
      // trc-C only has one G3 event.
      expect(out).toContain('G3');
    });

    it('scopes to a sessionId', async () => {
      const res = await tools.get('trace.last')!.execute({ sessionId: 's1' });
      expect(res.success).toBe(true);
      // Latest of session s1 is trc-B.
      expect(res.output ?? '').toContain('trc-B');
      expect(res.output ?? '').not.toContain('trc-C');
    });
  });

  describe('trace.show (mutating cases)', () => {
    it('truncates the timeline past maxEvents with a tail marker', async () => {
      // Run last: this INSERTs into the shared DB and would otherwise
      // pollute trace.last lookups above.
      const busyDb = new DatabaseSync(resolve(stateDir, 'trace', 'traces.db'));
      const ins = busyDb.prepare(
        `INSERT INTO trace_events (trace_id, session_id, agent_id, block, event, timestamp, duration_ms, payload, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const t = Date.now();
      for (let i = 0; i < 5; i++) {
        ins.run('trc-BUSY', 's3', 'agent-1', 'W1', 'step', t + i, 1, null, null);
      }
      busyDb.close();

      const res = await tools
        .get('trace.show')!
        .execute({ traceId: 'trc-BUSY', maxEvents: 2 });
      expect(res.success).toBe(true);
      expect(res.output ?? '').toContain('truncated, 3 more event');
    });
  });
});

describe('builtin trace-lookup skill (no DB)', () => {
  let stateDir: string;
  let tools: Map<string, LoadedTool>;
  const prevStateDir = process.env.AGENT_STATE_DIR;

  beforeEach(async () => {
    stateDir = mkdtempSync(resolve(tmpdir(), 'trace-lookup-empty-'));
    // Do NOT create the trace/ subdir or the DB — emulate tracing disabled.
    process.env.AGENT_STATE_DIR = stateDir;
    tools = await loadTools();
  });

  afterEach(() => {
    if (prevStateDir === undefined) delete process.env.AGENT_STATE_DIR;
    else process.env.AGENT_STATE_DIR = prevStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('trace.list returns a friendly message when the DB is absent', async () => {
    const res = await tools.get('trace.list')!.execute({});
    expect(res.success).toBe(true);
    expect(res.output ?? '').toContain('no trace DB');
    expect(res.output ?? '').toMatch(/AGENT_TRACE=0|no turn has run yet/);
  });

  it('trace.show returns the same friendly message when the DB is absent', async () => {
    const res = await tools.get('trace.show')!.execute({ traceId: 'whatever' });
    expect(res.success).toBe(true);
    expect(res.output ?? '').toContain('no trace DB');
  });

  it('trace.last returns the same friendly message when the DB is absent', async () => {
    const res = await tools.get('trace.last')!.execute({});
    expect(res.success).toBe(true);
    expect(res.output ?? '').toContain('no trace DB');
  });
});
