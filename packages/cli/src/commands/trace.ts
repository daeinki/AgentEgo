import { existsSync } from 'node:fs';
import { resolveGatewayPaths } from '@agent-platform/gateway-cli';
import { openTraceDb, type TraceSummary } from '@agent-platform/observability';
import type { Contracts } from '@agent-platform/core';

interface TraceListOptions {
  session?: string;
  limit?: string;
}

interface TraceRenderOptions {
  format?: 'text' | 'json';
  /** When true, render absolute wall-clock (HH:mm:ss.SSS) instead of offset. */
  wallClock?: boolean;
  /** When true, dump the raw payload JSON pretty-printed under each row. */
  verbose?: boolean;
  /** Filter to a single block (G3, P1, E1, W1, R1, R2, R3, M1, X1, S1, …). */
  filter?: string;
  /** Disable ANSI color (default: auto-detect TTY). */
  noColor?: boolean;
}

type TraceShowOptions = TraceRenderOptions;
type TraceLastOptions = TraceRenderOptions & { session?: string };

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
  const filtered =
    options.filter !== undefined
      ? events.filter((e) => e.block === options.filter)
      : events;
  if (filtered.length === 0) {
    console.log(`[trace] no events match block='${options.filter}' for traceId ${traceId}.`);
    return;
  }
  if (options.format === 'json') {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }
  renderTimeline(filtered, options);
}

export async function traceLastCommand(options: TraceLastOptions): Promise<void> {
  const traceId = withDb((q) => q.getLastTraceId(options.session));
  if (!traceId) {
    console.log('[trace] no traces yet.');
    return;
  }
  const showOpts: TraceShowOptions = { format: options.format ?? 'text' };
  if (options.wallClock) showOpts.wallClock = true;
  if (options.verbose) showOpts.verbose = true;
  if (options.filter !== undefined) showOpts.filter = options.filter;
  if (options.noColor) showOpts.noColor = true;
  await traceShowCommand(traceId, showOpts);
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

function renderTimeline(
  events: Contracts.TraceEvent[],
  options: TraceRenderOptions = {},
): void {
  const t0 = events[0]!.timestamp;
  const startedAt = new Date(t0).toISOString().slice(0, 19).replace('T', ' ');
  // ANSI color is on by default in TTY; fall back to plain when piped or
  // explicitly disabled (--no-color).
  const useColor = !options.noColor && process.stdout.isTTY === true;
  const c = makePalette(useColor);

  console.log(c.dim(`# trace started at ${startedAt} UTC (${events.length} events)`));
  for (const ev of events) {
    const timeCol = options.wallClock
      ? formatWallClock(ev.timestamp)
      : (() => {
          const offsetMs = ev.timestamp - t0;
          return offsetMs < 1000 ? `${offsetMs}ms` : `${(offsetMs / 1000).toFixed(2)}s`;
        })();
    const dur =
      ev.durationMs !== undefined ? c.dim(` (${ev.durationMs}ms)`) : '';
    const block = c.block(ev.block, pad(ev.block, 3));
    const eventName = c.event(ev.event, pad(ev.event, 22));
    // Prefer the emitter-supplied summary; fall back to a payload digest so
    // pre-summary events (older DB rows, third-party emitters) still render.
    const detail = ev.summary
      ? ` ${ev.summary}`
      : ev.payload
        ? ` ${c.dim(summarizePayload(ev.payload))}`
        : '';
    const err = ev.error ? c.error(` error="${ev.error}"`) : '';
    const timeWidth = options.wallClock ? 12 : 7;
    console.log(
      `${c.dim('[')}${pad(timeCol, timeWidth)}${c.dim(']')}  ${block}  ${eventName}${dur}${detail}${err}`,
    );
    if (options.verbose && ev.payload) {
      const json = JSON.stringify(ev.payload, null, 2)
        .split('\n')
        .map((l) => `    ${c.dim(l)}`)
        .join('\n');
      console.log(json);
    }
  }
}

function formatWallClock(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  const ms = String(d.getUTCMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

interface Palette {
  dim(s: string): string;
  error(s: string): string;
  block(blockId: string, padded: string): string;
  event(eventName: string, padded: string): string;
}

function makePalette(useColor: boolean): Palette {
  if (!useColor) {
    return {
      dim: (s) => s,
      error: (s) => s,
      block: (_b, p) => p,
      event: (_e, p) => p,
    };
  }
  // ANSI 8-color codes — bright variants for readability on dark themes.
  const RESET = '\x1b[0m';
  const DIM = '\x1b[2m';
  const RED = '\x1b[31m';
  const blockColors: Record<string, string> = {
    G3: '\x1b[36m', // cyan — gateway
    C1: '\x1b[35m', // magenta — control
    P1: '\x1b[34m', // blue — platform
    E1: '\x1b[33m', // yellow — EGO
    W1: '\x1b[32m', // green — runner
    R1: '\x1b[92m', // bright green — reasoner mode select
    R2: '\x1b[92m',
    R3: '\x1b[92m',
    M1: '\x1b[95m', // bright magenta — model
    X1: '\x1b[94m', // bright blue — memory
    S1: '\x1b[93m', // bright yellow — sandbox
  };
  return {
    dim: (s) => `${DIM}${s}${RESET}`,
    error: (s) => `${RED}${s}${RESET}`,
    block: (blockId, padded) => {
      const color = blockColors[blockId] ?? '';
      return color ? `${color}${padded}${RESET}` : padded;
    },
    event: (_eventName, padded) => padded,
  };
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
