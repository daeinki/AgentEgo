import type {
  ApiGateway,
  MessageHandler,
  MessageHandlerContext,
} from '@agent-platform/control-plane';
import type {
  Contracts,
  Phase,
  PhaseEvent,
  PhaseEventDetail,
  StandardMessage,
} from '@agent-platform/core';
import { generateId, generateTraceId, isTerminalPhase, nowMs } from '@agent-platform/core';
import type { SessionStore } from '@agent-platform/control-plane';
import { RpcError, RpcErrorCode } from './protocol.js';
import type { RpcContext, RpcHandler } from './server.js';

/**
 * Read-only descriptor of a registered channel adapter, surfaced by the
 * `channels.list` / `channels.status` RPCs. Channels are not owned by
 * gateway-cli; this interface is what platform wiring passes in.
 */
export interface ChannelDescriptor {
  id: string;
  type: string;
  status: 'connected' | 'disconnected' | 'error' | 'unknown';
  lastEventAt?: number;
  error?: string;
  sessionCount?: number;
}

export interface ChannelRegistry {
  list(): readonly ChannelDescriptor[];
  get?(id: string): ChannelDescriptor | undefined;
}

/**
 * Read-only descriptor of a scheduled task. Cron infrastructure is not yet
 * wired; when no registry is provided, `cron.list` returns an empty array.
 */
export interface CronTaskDescriptor {
  id: string;
  spec: string;
  status: 'idle' | 'running' | 'disabled' | 'error';
  nextRunAt?: number;
  lastRunAt?: number;
  lastError?: string;
}

export interface CronRegistry {
  list(): readonly CronTaskDescriptor[];
  runNow?(id: string): Promise<{ startedAt: number }>;
}

/**
 * Dependencies required to construct the default RPC method registry. These
 * are the same components `startPlatform()` wires together — we reuse them
 * instead of duplicating wiring.
 */
export interface RpcDeps {
  gateway: ApiGateway;
  sessions: SessionStore;
  router: Contracts.Router;
  /** Same handler already used by ApiGateway's HTTP/WS paths. */
  handler: MessageHandler;
  /** Requests a graceful shutdown of the whole platform. */
  shutdown: () => Promise<void>;
  /** Package version for `gateway.health`. */
  version: string;
  /** Listening ports surfaced in `gateway.health`. */
  ports: { gateway: number; webchat?: number };
  /** Optional per-turn debug trace logger (pipeline block G3). */
  traceLogger?: Contracts.TraceLogger;
  /**
   * Optional channel adapter registry — powers `channels.list` /
   * `channels.status`. Gateway-cli does not own channels; the platform
   * startup layer builds this view and passes it in. Omit to report an
   * empty channel list.
   */
  channels?: ChannelRegistry;
  /** Optional scheduled-task registry — powers `cron.list` / `cron.runNow`. */
  cron?: CronRegistry;
}

export function buildRpcMethods(deps: RpcDeps): Record<string, RpcHandler> {
  return {
    'gateway.health': async () => ({
      ok: true,
      version: deps.version,
      uptimeMs: deps.gateway.uptimeMs(),
      ports: deps.ports,
      pid: process.pid,
    }),

    'gateway.shutdown': async () => {
      // The actual shutdown is triggered by RpcServer's onShutdownRequested
      // hook *after* this response is flushed, so the client sees {ok:true}
      // before the socket closes.
      return { ok: true };
    },

    'chat.send': async (params, ctx) => {
      const p = requireObject(params, 'chat.send');
      const text = requireString(p['text'], 'chat.send.text');
      const agentIdOverride = optionalString(p['agentId'], 'chat.send.agentId');
      const channelIdOverride = optionalString(p['channelId'], 'chat.send.channelId');
      const conversationId =
        optionalString(p['conversationId'], 'chat.send.conversationId') ??
        optionalString(p['sessionId'], 'chat.send.sessionId') ??
        `rpc-${ctx.connectionId}`;
      const senderId = optionalString(p['senderId'], 'chat.send.senderId') ?? 'rpc-client';

      const msg: StandardMessage = {
        id: generateId(),
        traceId: generateTraceId(),
        timestamp: nowMs(),
        channel: {
          type: 'webchat',
          id: channelIdOverride ?? 'rpc',
          metadata: {},
        },
        sender: { id: senderId, isOwner: true },
        conversation: { type: 'dm', id: conversationId },
        content: { type: 'text', text },
      };

      const g3Start = Date.now();
      deps.traceLogger?.event({
        traceId: msg.traceId,
        block: 'G3',
        event: 'enter',
        timestamp: g3Start,
        payload: {
          textPreview: text.slice(0, 80),
          conversationId,
          channelId: channelIdOverride ?? 'rpc',
          senderId,
        },
      });

      const route = await deps.router.route(msg);
      const agentId = agentIdOverride ?? route.agentId;
      const sessionId = route.sessionId;

      ctx.notify('chat.accepted', {
        requestId: ctx.requestId,
        sessionId,
        agentId,
        messageId: msg.id,
        traceId: msg.traceId,
      });

      // ADR-010 / harness-engineering.md §3.1.4: phase stream.
      // `turnId` reuses `traceId` since both are 1:1 with an agent turn and
      // the OTel traceId is the canonical turn identifier in this codebase.
      const turnStart = Date.now();
      let phaseSeq = 0;
      let turnClosed = false;
      const emitPhase = (phase: Phase, detail?: PhaseEventDetail): void => {
        if (turnClosed) return;
        const evt: PhaseEvent = {
          turnId: msg.traceId,
          sessionId,
          seq: phaseSeq++,
          at: Date.now(),
          phase,
          elapsedMs: Date.now() - turnStart,
          ...(detail ? { detail } : {}),
        };
        ctx.notify('chat.phase', { requestId: ctx.requestId, ...evt });
        if (isTerminalPhase(phase)) turnClosed = true;
      };

      // First phase — server accepted the turn, nothing else has happened yet.
      emitPhase('received');

      const handlerCtx: MessageHandlerContext = {
        sessionId,
        agentId,
        traceId: msg.traceId,
        emit: (textDelta) => {
          ctx.notify('chat.delta', { requestId: ctx.requestId, text: textDelta });
        },
        emitPhase,
        ...(deps.traceLogger ? { traceLogger: deps.traceLogger } : {}),
      };

      // Abort propagation: if the socket closes mid-stream, the RpcServer
      // aborts `ctx.signal`. The current handler chain (EGO + AgentRunner)
      // doesn't yet accept AbortSignal, so cancellation is best-effort at the
      // WebSocket level — the model stream will continue until `done`, but no
      // further deltas are delivered to a closed socket.
      let usage: Awaited<ReturnType<MessageHandler>>;
      try {
        usage = await deps.handler(msg, handlerCtx);
      } catch (err) {
        deps.traceLogger?.event({
          traceId: msg.traceId,
          sessionId,
          agentId,
          block: 'G3',
          event: 'error',
          timestamp: Date.now(),
          durationMs: Date.now() - g3Start,
          error: (err as Error).message,
        });
        // ADR-010 §3.1.4.7: only errorCode is forwarded, never the raw message.
        emitPhase('error', { errorCode: classifyError(err) });
        throw err;
      }

      emitPhase('finalizing');
      emitPhase('complete');

      deps.traceLogger?.event({
        traceId: msg.traceId,
        sessionId,
        agentId,
        block: 'G3',
        event: 'exit',
        timestamp: Date.now(),
        durationMs: Date.now() - g3Start,
        payload: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd: usage.costUsd,
        },
      });

      return {
        requestId: ctx.requestId,
        sessionId,
        agentId,
        messageId: msg.id,
        traceId: msg.traceId,
        usage: {
          ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
          ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
          ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
        },
      };
    },

    'chat.history': async (params) => {
      const p = requireObject(params, 'chat.history');
      const sessionId = requireString(p['sessionId'], 'chat.history.sessionId');
      const limit = optionalNumber(p['limit'], 'chat.history.limit') ?? 50;
      const session = deps.sessions.getSession(sessionId);
      if (!session) {
        throw new RpcError(RpcErrorCode.NotFound, `session not found: ${sessionId}`);
      }
      const events = deps.sessions.getRecentEvents(sessionId, limit);
      return { session, events };
    },

    'sessions.list': async (params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      const agentId = optionalString(p['agentId'], 'sessions.list.agentId');
      const sessions = deps.sessions.listSessions(agentId ? { agentId } : undefined);
      return { sessions };
    },

    'sessions.reset': async (params) => {
      const p = requireObject(params, 'sessions.reset');
      const sessionId = requireString(p['sessionId'], 'sessions.reset.sessionId');
      const existing = deps.sessions.getSession(sessionId);
      if (!existing) {
        throw new RpcError(RpcErrorCode.NotFound, `session not found: ${sessionId}`);
      }
      // Compact aggressively: keep 0 recent events, rolling everything into a
      // single summary event. (Full deletion would break FK on session_events.)
      const result = deps.sessions.compactSession(sessionId, 0);
      return { ok: true, ...result };
    },

    'sessions.events': async (params) => {
      const p = requireObject(params, 'sessions.events');
      const sessionId = requireString(p['sessionId'], 'sessions.events.sessionId');
      const limit = optionalNumber(p['limit'], 'sessions.events.limit') ?? 100;
      if (!deps.sessions.getSession(sessionId)) {
        throw new RpcError(RpcErrorCode.NotFound, `session not found: ${sessionId}`);
      }
      const events = deps.sessions.getRecentEvents(sessionId, limit);
      return { events };
    },

    'overview.status': async () => {
      const sessions = deps.sessions.listSessions();
      const agents = new Set<string>();
      const byStatus: Record<string, number> = {};
      for (const s of sessions) {
        agents.add(s.agentId);
        byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
      }
      const mem = process.memoryUsage();
      return {
        ok: true,
        version: deps.version,
        uptimeMs: deps.gateway.uptimeMs(),
        sessionCount: sessions.length,
        sessionsByStatus: byStatus,
        activeAgents: [...agents].sort(),
        channelCount: deps.channels?.list().length ?? 0,
        memMB: Math.round(mem.rss / (1024 * 1024)),
        pid: process.pid,
      };
    },

    'channels.list': async () => {
      return { channels: deps.channels?.list() ?? [] };
    },

    'channels.status': async (params) => {
      const p = requireObject(params, 'channels.status');
      const id = requireString(p['id'], 'channels.status.id');
      const desc = deps.channels?.get?.(id) ?? deps.channels?.list().find((c) => c.id === id);
      if (!desc) {
        throw new RpcError(RpcErrorCode.NotFound, `channel not found: ${id}`);
      }
      return desc;
    },

    'instances.list': async () => {
      // "Instances" = agent runners currently holding sessions. Without a
      // dedicated registry we approximate by aggregating sessions per agentId.
      const sessions = deps.sessions.listSessions();
      const byAgent = new Map<
        string,
        { agentId: string; sessionCount: number; active: number; hibernated: number }
      >();
      for (const s of sessions) {
        const entry = byAgent.get(s.agentId) ?? {
          agentId: s.agentId,
          sessionCount: 0,
          active: 0,
          hibernated: 0,
        };
        entry.sessionCount += 1;
        if (s.status === 'active') entry.active += 1;
        else if (s.status === 'hibernated') entry.hibernated += 1;
        byAgent.set(s.agentId, entry);
      }
      return { instances: [...byAgent.values()] };
    },

    'cron.list': async () => {
      return { tasks: deps.cron?.list() ?? [] };
    },

    'cron.runNow': async (params) => {
      const p = requireObject(params, 'cron.runNow');
      const id = requireString(p['id'], 'cron.runNow.id');
      if (!deps.cron?.runNow) {
        throw new RpcError(RpcErrorCode.MethodNotFound, 'cron scheduler not configured');
      }
      const result = await deps.cron.runNow(id);
      return { ok: true, ...result };
    },
  };
}

// ─── Param helpers ──────────────────────────────────────────────────────────

function requireObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RpcError(RpcErrorCode.InvalidParams, `${where}: params must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RpcError(RpcErrorCode.InvalidParams, `${where}: expected non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new RpcError(RpcErrorCode.InvalidParams, `${where}: expected string`);
  }
  return value;
}

function optionalNumber(value: unknown, where: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RpcError(RpcErrorCode.InvalidParams, `${where}: expected finite number`);
  }
  return value;
}

/**
 * Map a handler error to an opaque PhaseEvent.detail.errorCode (ADR-010
 * §3.1.4.7). We never forward raw messages — only a coarse class so the TUI
 * can pick an appropriate label.
 */
function classifyError(err: unknown): string {
  if (err instanceof RpcError) return `rpc_${err.code}`;
  if (err instanceof Error && err.name === 'AbortError') return 'aborted';
  return 'internal';
}
