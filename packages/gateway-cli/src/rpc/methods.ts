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
