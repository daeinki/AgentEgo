// trace-lookup (first-party builtin skill)
//
// Exposes three tools that let the agent inspect its own pipeline-block
// trace events written by SqliteTraceLog to `<stateDir>/trace/traces.db`:
//
//   - trace.list({ sessionId?, limit? })           — recent trace summaries
//   - trace.show({ traceId, blockFilter?, maxEvents? }) — full timeline
//   - trace.last({ sessionId? })                   — most recent trace
//
// Self-contained by design: the skill runs from `~/.agent/skills/trace-lookup/`
// where workspace packages are not resolvable, so it duplicates the three SQL
// queries from `@agent-platform/observability`'s `TraceQuery`. Any schema
// change to `trace_events` needs to be mirrored here — the companion vitest
// in `packages/skills/src/builtin-trace-lookup.test.ts` uses the real CREATE
// TABLE statement to catch drift.
//
// Read-only: opens the DB with { readOnly: true } and closes on each call so
// the gateway's WAL writer isn't blocked from checkpointing.
//
// Loaded by `loadSkillTools()` via a dynamic ESM import; written as plain
// `.js` to match the on-disk install layout, same as architecture-lookup.

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const MAX_OUTPUT_CHARS = 8000;

const PAYLOAD_WHITELIST = {
  G3: ['textPreview', 'sessionId', 'role'],
  P1: ['message', 'skillId', 'version'],
  E1: ['action', 'goalId', 'decisionId', 'confidence'],
  W1: ['toolName', 'stepIdx', 'success', 'durationMs'],
  R1: ['mode', 'iter', 'toolCount', 'finishReason'],
  R2: ['mode', 'iter', 'toolCount', 'finishReason'],
  R3: ['mode', 'iter', 'toolCount', 'finishReason'],
  M1: ['kind', 'path', 'bytes'],
};

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createTools(_ctx) {
  return [traceListTool(), traceShowTool(), traceLastTool()];
}

function traceListTool() {
  return {
    name: 'trace.list',
    description:
      'List recent turn traces (newest first) from the agent\'s own ' +
      'pipeline-block log. Each row shows startedAt, traceId, sessionId, ' +
      'total duration, EGO decision, and a preview of the user message. ' +
      'Use this to discover recent activity; call trace.show for the full ' +
      'timeline of a specific id.',
    permissions: [],
    riskLevel: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Filter to a single session id.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          default: 10,
          description: 'Max rows to return (newest first).',
        },
      },
    },
    async execute(args) {
      const start = Date.now();
      const { sessionId, limit } = normalizeListArgs(args);
      const result = withDb((db) => listRecentTraces(db, { sessionId, limit }));
      if (result.kind === 'missing') {
        return ok('trace.list', renderMissing(result.path), start);
      }
      if (result.value.length === 0) {
        return ok('trace.list', 'no traces yet.', start);
      }
      const lines = [formatListHeader(), ...result.value.map(formatListRow)];
      return ok('trace.list', capOutput(lines.join('\n')), start);
    },
  };
}

function traceShowTool() {
  return {
    name: 'trace.show',
    description:
      'Show the full block-by-block timeline of a single trace. Each event ' +
      'has an offset from start, block id (G3|P1|E1|W1|R1|R2|R3|M1|…), ' +
      'event name, duration, and a summarized payload. Use blockFilter to ' +
      'focus on specific stages.',
    permissions: [],
    riskLevel: 'low',
    inputSchema: {
      type: 'object',
      required: ['traceId'],
      properties: {
        traceId: {
          type: 'string',
          minLength: 3,
          description: 'The trace id returned by trace.list or trace.last.',
        },
        blockFilter: {
          type: 'array',
          items: { type: 'string' },
          description:
            'If set, only return events whose block is in this list ' +
            '(e.g. ["E1","W1"]). Unknown blocks are ignored silently.',
        },
        maxEvents: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          default: 200,
          description: 'Cap on events returned after filtering.',
        },
      },
    },
    async execute(args) {
      const start = Date.now();
      const parsed = normalizeShowArgs(args);
      if (!parsed.ok) return fail('trace.show', parsed.error, start);
      const { traceId, blockFilter, maxEvents } = parsed.value;
      const result = withDb((db) => getTraceTimeline(db, traceId));
      if (result.kind === 'missing') {
        return ok('trace.show', renderMissing(result.path), start);
      }
      const events = result.value;
      if (events.length === 0) {
        return fail(
          'trace.show',
          `no events for traceId '${traceId}'. Try trace.list() to see known ids.`,
          start,
        );
      }
      return ok(
        'trace.show',
        renderTimeline(events, { blockFilter, maxEvents }),
        start,
      );
    },
  };
}

function traceLastTool() {
  return {
    name: 'trace.last',
    description:
      'Show the most recent trace — a one-line header plus the full ' +
      'timeline. Use this right after a turn to inspect what the agent ' +
      'actually did.',
    permissions: [],
    riskLevel: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Restrict the lookup to a single session id.',
        },
      },
    },
    async execute(args) {
      const start = Date.now();
      const { sessionId } = normalizeLastArgs(args);
      const result = withDb((db) => {
        const traceId = getLastTraceId(db, sessionId);
        if (traceId === null) return null;
        const summaries = listRecentTraces(db, { sessionId, limit: 50 });
        const summary = summaries.find((s) => s.traceId === traceId) ?? null;
        const events = getTraceTimeline(db, traceId);
        return { traceId, summary, events };
      });
      if (result.kind === 'missing') {
        return ok('trace.last', renderMissing(result.path), start);
      }
      if (result.value === null) {
        return ok('trace.last', 'no traces yet.', start);
      }
      const { summary, events } = result.value;
      const header = summary
        ? `${formatListHeader()}\n${formatListRow(summary)}\n\n`
        : '';
      return ok(
        'trace.last',
        capOutput(header + renderTimeline(events, { maxEvents: 200 })),
        start,
      );
    },
  };
}

// ─── Arg normalization ──────────────────────────────────────────────────────

function asObject(args) {
  if (args === null || args === undefined) return {};
  if (typeof args !== 'object') return {};
  return args;
}

function normalizeListArgs(args) {
  const a = asObject(args);
  const sessionId =
    typeof a.sessionId === 'string' && a.sessionId.trim().length > 0
      ? a.sessionId.trim()
      : undefined;
  let limit = typeof a.limit === 'number' ? a.limit : 10;
  if (!Number.isFinite(limit)) limit = 10;
  limit = Math.max(1, Math.min(50, Math.floor(limit)));
  return { sessionId, limit };
}

function normalizeShowArgs(args) {
  const a = asObject(args);
  if (typeof a.traceId !== 'string' || a.traceId.trim().length === 0) {
    return { ok: false, error: 'traceId is required' };
  }
  const traceId = a.traceId.trim();
  let blockFilter;
  if (Array.isArray(a.blockFilter)) {
    const filtered = a.blockFilter.filter(
      (b) => typeof b === 'string' && b.trim().length > 0,
    );
    if (filtered.length > 0) blockFilter = new Set(filtered.map((b) => b.trim()));
  }
  let maxEvents = typeof a.maxEvents === 'number' ? a.maxEvents : 200;
  if (!Number.isFinite(maxEvents)) maxEvents = 200;
  maxEvents = Math.max(1, Math.min(500, Math.floor(maxEvents)));
  return { ok: true, value: { traceId, blockFilter, maxEvents } };
}

function normalizeLastArgs(args) {
  const a = asObject(args);
  const sessionId =
    typeof a.sessionId === 'string' && a.sessionId.trim().length > 0
      ? a.sessionId.trim()
      : undefined;
  return { sessionId };
}

// ─── DB access ──────────────────────────────────────────────────────────────

function resolveTraceDbPath() {
  const override = process.env.AGENT_STATE_DIR;
  const stateDir =
    override && override.length > 0 ? expandHome(override) : join(homedir(), '.agent');
  return join(stateDir, 'trace', 'traces.db');
}

function expandHome(p) {
  if (p === '~' || p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p;
}

function withDb(fn) {
  const path = resolveTraceDbPath();
  if (!existsSync(path)) return { kind: 'missing', path };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return { kind: 'ok', value: fn(db) };
  } finally {
    try {
      db.close();
    } catch {
      /* best-effort */
    }
  }
}

// Mirrors packages/observability/src/trace-query.ts: listRecentTraces +
// firstTextPreview + firstEgoAction.
function listRecentTraces(db, { sessionId, limit }) {
  const clauses = [];
  const args = [];
  if (sessionId) {
    clauses.push('session_id = ?');
    args.push(sessionId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
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
  const rows = db.prepare(sql).all(...args, limit);
  return rows.map((r) => ({
    traceId: r.trace_id,
    sessionId: r.session_id,
    agentId: r.agent_id,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    totalMs: r.ended_at - r.started_at,
    eventCount: r.event_count,
    textPreview: firstTextPreview(db, r.trace_id),
    egoAction: firstEgoAction(db, r.trace_id),
    hasError: r.error_count > 0,
  }));
}

function getTraceTimeline(db, traceId) {
  const sql = `
    SELECT trace_id, session_id, agent_id, block, event, timestamp,
           duration_ms, payload, error
    FROM trace_events
    WHERE trace_id = ?
    ORDER BY id ASC
  `;
  const rows = db.prepare(sql).all(traceId);
  return rows.map((r) => ({
    traceId: r.trace_id,
    sessionId: r.session_id,
    agentId: r.agent_id,
    block: r.block,
    event: r.event,
    timestamp: r.timestamp,
    durationMs: r.duration_ms,
    payload: r.payload !== null ? safeParseJson(r.payload) : null,
    error: r.error,
  }));
}

function getLastTraceId(db, sessionId) {
  const sql = sessionId
    ? 'SELECT trace_id FROM trace_events WHERE session_id = ? ORDER BY id DESC LIMIT 1'
    : 'SELECT trace_id FROM trace_events ORDER BY id DESC LIMIT 1';
  const args = sessionId ? [sessionId] : [];
  const row = db.prepare(sql).get(...args);
  return row?.trace_id ?? null;
}

function firstTextPreview(db, traceId) {
  const row = db
    .prepare(
      `SELECT payload FROM trace_events
       WHERE trace_id = ? AND block = 'G3' AND event = 'enter' AND payload IS NOT NULL
       ORDER BY id ASC LIMIT 1`,
    )
    .get(traceId);
  if (!row) return null;
  const payload = safeParseJson(row.payload);
  return payload && typeof payload.textPreview === 'string' ? payload.textPreview : null;
}

function firstEgoAction(db, traceId) {
  const row = db
    .prepare(
      `SELECT payload FROM trace_events
       WHERE trace_id = ? AND block = 'E1' AND event = 'decision' AND payload IS NOT NULL
       ORDER BY id ASC LIMIT 1`,
    )
    .get(traceId);
  if (!row) return null;
  const payload = safeParseJson(row.payload);
  return payload && typeof payload.action === 'string' ? payload.action : null;
}

function safeParseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function formatListHeader() {
  return [
    pad('startedAt', 19),
    pad('traceId', 14),
    pad('session', 18),
    pad('ms', 7),
    pad('egoAction', 16),
    'preview',
  ].join('  ');
}

function formatListRow(r) {
  const ts = new Date(r.startedAt).toISOString().slice(0, 19).replace('T', ' ');
  const errTag = r.hasError ? ' [err]' : '';
  return [
    pad(ts, 19),
    pad(shortenTraceId(r.traceId), 14),
    pad(r.sessionId ?? '-', 18),
    pad(String(r.totalMs), 7, true),
    pad(r.egoAction ?? '-', 16),
    `${(r.textPreview ?? '').slice(0, 60)}${errTag}`,
  ].join('  ');
}

function renderTimeline(events, options = {}) {
  const { blockFilter, maxEvents = 200 } = options;
  const filtered = blockFilter ? events.filter((e) => blockFilter.has(e.block)) : events;
  if (filtered.length === 0) {
    return 'no events match the given blockFilter.';
  }
  const shown = filtered.slice(0, maxEvents);
  const dropped = filtered.length - shown.length;
  const t0 = shown[0].timestamp;
  const lines = shown.map((ev) => {
    const offsetMs = ev.timestamp - t0;
    const offset = offsetMs < 1000 ? `${offsetMs}ms` : `${(offsetMs / 1000).toFixed(2)}s`;
    const dur = ev.durationMs !== null && ev.durationMs !== undefined ? ` (${ev.durationMs}ms)` : '';
    const payload =
      ev.payload && typeof ev.payload === 'object'
        ? ` ${summarizePayload(ev.block, ev.payload)}`
        : '';
    const err = ev.error ? ` error="${truncateString(ev.error, 80)}"` : '';
    return `[${pad(offset, 7)}]  ${pad(ev.block, 3)}  ${pad(ev.event, 22)}${dur}${payload}${err}`;
  });
  let out = lines.join('\n');
  if (dropped > 0) {
    out += `\n\n…[truncated, ${dropped} more event${dropped === 1 ? '' : 's'}]`;
  }
  return capOutput(out);
}

function summarizePayload(block, payload) {
  const whitelist = PAYLOAD_WHITELIST[block];
  const keys = new Set(Object.keys(payload));
  const ordered = [];
  if (whitelist) {
    for (const k of whitelist) {
      if (keys.has(k)) {
        ordered.push(k);
        keys.delete(k);
      }
    }
  }
  // Fill up to 3 remaining keys to avoid runaway payloads.
  const remaining = [...keys].slice(0, 3);
  ordered.push(...remaining);

  const pairs = [];
  for (const k of ordered) {
    const v = payload[k];
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') {
      pairs.push(`${k}="${truncateString(v, 40)}"`);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      pairs.push(`${k}=${v}`);
    } else if (Array.isArray(v)) {
      pairs.push(`${k}=[${v.length}]`);
    } else if (typeof v === 'object') {
      pairs.push(`${k}={…}`);
    }
  }
  return pairs.join(' ');
}

function truncateString(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function shortenTraceId(id) {
  if (id.startsWith('trc-') && id.length > 14) return `${id.slice(0, 12)}…`;
  return id;
}

function pad(s, width, rightAlign = false) {
  if (s.length >= width) return s;
  return rightAlign ? s.padStart(width) : s.padEnd(width);
}

function capOutput(s) {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  return s.slice(0, MAX_OUTPUT_CHARS) + '\n\n…[truncated]';
}

function renderMissing(path) {
  return (
    `no trace DB at ${path}. Tracing may be disabled (AGENT_TRACE=0) ` +
    `or no turn has run yet.`
  );
}

// ─── Result shape ───────────────────────────────────────────────────────────

function ok(toolName, output, start) {
  return { toolName, success: true, output, durationMs: Date.now() - start };
}

function fail(toolName, error, start) {
  return { toolName, success: false, error, durationMs: Date.now() - start };
}
