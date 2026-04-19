import { existsSync } from 'node:fs';
import { resolveGatewayPaths } from '@agent-platform/gateway-cli';
import { openTraceDb, type TraceSummary } from '@agent-platform/observability';
import type { Contracts } from '@agent-platform/core';

interface TraceListOptions {
  session?: string;
  limit?: string;
}

interface TraceShowOptions {
  format?: 'text' | 'json';
}

interface TraceLastOptions {
  session?: string;
  format?: 'text' | 'json';
}

interface TraceExportOptions {
  format?: 'json' | 'ndjson';
}

function resolveDbPath(): string {
  const paths = resolveGatewayPaths();
  if (!existsSync(paths.traceDb)) {
    console.error(
      `[trace] no trace DB found at ${paths.traceDb}.\n` +
        `  Start the gateway (agent gateway start) and send at least one message,\n` +
        `  or set AGENT_STATE_DIR if you use a custom state directory.`,
    );
    process.exit(1);
  }
  return paths.traceDb;
}

function withDb<T>(fn: (q: ReturnType<typeof openTraceDb>['query']) => T): T {
  const { db, query } = openTraceDb(resolveDbPath());
  try {
    return fn(query);
  } finally {
    try {
      db.close();
    } catch {
      /* best-effort */
    }
  }
}

export async function traceListCommand(options: TraceListOptions): Promise<void> {
  const limit = options.limit ? Number(options.limit) : 20;
  const rows = withDb((q) =>
    q.listRecentTraces({ ...(options.session ? { sessionId: options.session } : {}), limit }),
  );
  if (rows.length === 0) {
    console.log('[trace] no traces yet.');
    return;
  }
  console.log(formatListHeader());
  for (const r of rows) console.log(formatListRow(r));
}

export async function traceShowCommand(
  traceId: string,
  options: TraceShowOptions,
): Promise<void> {
  const events = withDb((q) => q.getTraceTimeline(traceId));
  if (events.length === 0) {
    console.log(`[trace] no events for traceId ${traceId}.`);
    return;
  }
  if (options.format === 'json') {
    console.log(JSON.stringify(events, null, 2));
    return;
  }
  renderTimeline(events);
}

export async function traceLastCommand(options: TraceLastOptions): Promise<void> {
  const traceId = withDb((q) => q.getLastTraceId(options.session));
  if (!traceId) {
    console.log('[trace] no traces yet.');
    return;
  }
  await traceShowCommand(traceId, { format: options.format ?? 'text' });
}

export async function traceExportCommand(
  traceId: string,
  options: TraceExportOptions,
): Promise<void> {
  const events = withDb((q) => q.getTraceTimeline(traceId));
  if (events.length === 0) {
    console.error(`[trace] no events for traceId ${traceId}.`);
    process.exit(1);
  }
  if (options.format === 'ndjson') {
    for (const ev of events) console.log(JSON.stringify(ev));
  } else {
    console.log(JSON.stringify({ traceId, events }, null, 2));
  }
}

// ─── Formatting helpers ─────────────────────────────────────────────────────

function formatListHeader(): string {
  return [
    pad('startedAt', 19),
    pad('traceId', 14),
    pad('session', 18),
    pad('ms', 7),
    pad('egoAction', 16),
    'preview',
  ].join('  ');
}

function formatListRow(r: TraceSummary): string {
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

function renderTimeline(events: Contracts.TraceEvent[]): void {
  const t0 = events[0]!.timestamp;
  for (const ev of events) {
    const offsetMs = ev.timestamp - t0;
    const offset = offsetMs < 1000 ? `${offsetMs}ms` : `${(offsetMs / 1000).toFixed(2)}s`;
    const dur = ev.durationMs !== undefined ? ` (${ev.durationMs}ms)` : '';
    const payload = ev.payload ? ` ${summarizePayload(ev.payload)}` : '';
    const err = ev.error ? ` error="${ev.error}"` : '';
    console.log(
      `[${pad(offset, 7)}]  ${pad(ev.block, 3)}  ${pad(ev.event, 22)}${dur}${payload}${err}`,
    );
  }
}

function summarizePayload(p: Record<string, unknown>): string {
  const pairs: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') {
      pairs.push(`${k}="${v.length > 40 ? v.slice(0, 40) + '…' : v}"`);
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

function shortenTraceId(id: string): string {
  // Preserve the `trc-` prefix + first 8 uuid chars.
  if (id.startsWith('trc-') && id.length > 14) return `${id.slice(0, 12)}…`;
  return id;
}

function pad(s: string, width: number, rightAlign = false): string {
  if (s.length >= width) return s;
  return rightAlign ? s.padStart(width) : s.padEnd(width);
}
