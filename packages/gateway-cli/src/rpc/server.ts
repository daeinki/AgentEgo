import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { UpgradeMount } from '@agent-platform/control-plane';
import {
  encodeFrame,
  errorFrame,
  notification,
  parseInbound,
  RpcError,
  RpcErrorCode,
  successFrame,
  type JsonRpcId,
  type JsonRpcRequest,
} from './protocol.js';

/**
 * Context passed to RPC method handlers. Handlers can emit server→client
 * notifications tied to the same connection (e.g. streaming `chat.delta`).
 */
export interface RpcContext {
  /**
   * Send a notification to the single client that made this request. Use for
   * streaming deltas and progress events. Returns false if the socket is
   * already closed.
   */
  notify(method: string, params: unknown): boolean;
  /**
   * Signal cancellation (wired to AbortSignal for e.g. model streaming).
   */
  readonly signal: AbortSignal;
  /** Stable per-connection id, useful for logs. */
  readonly connectionId: string;
  /** Request id. */
  readonly requestId: JsonRpcId;
}

export type RpcHandler = (params: unknown, ctx: RpcContext) => Promise<unknown>;

export interface RpcServerOptions {
  path: string;
  methods: Record<string, RpcHandler>;
  /**
   * Optional hook invoked when the gateway itself should shut down (e.g. a
   * `gateway.shutdown` RPC was received). The RPC server does not own the
   * HTTP listener; it simply forwards the request.
   */
  onShutdownRequested?: () => Promise<void>;
}

/**
 * WebSocket-based JSON-RPC 2.0 server. Mount on an ApiGateway via
 * `apiGateway.mount(rpcServer)`. Auth is handled by the gateway before the
 * upgrade is delegated to this server.
 */
export class RpcServer implements UpgradeMount {
  readonly path: string;
  private readonly wss: WebSocketServer;
  private readonly methods: Record<string, RpcHandler>;
  private readonly onShutdownRequested?: () => Promise<void>;
  private connCounter = 0;

  constructor(options: RpcServerOptions) {
    this.path = options.path;
    this.methods = options.methods;
    if (options.onShutdownRequested) {
      this.onShutdownRequested = options.onShutdownRequested;
    }
    this.wss = new WebSocketServer({ noServer: true });
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.handleConnection(ws);
    });
  }

  /** Close all active connections. */
  async close(): Promise<void> {
    for (const client of this.wss.clients) {
      try {
        client.close();
      } catch {
        // best-effort
      }
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  private handleConnection(ws: WebSocket): void {
    const connectionId = `rpc-${++this.connCounter}`;
    const inflight = new Map<JsonRpcId, AbortController>();

    ws.on('message', (data) => {
      const raw = typeof data === 'string' ? data : data.toString('utf-8');
      const parsed = parseInbound(raw);
      if (!parsed.ok) {
        safeSend(ws, encodeFrame(parsed.error));
        return;
      }
      const { frame, isNotification } = parsed.parsed;
      if (isNotification) {
        // Client→server notification. MVP: no methods expect this; ignore.
        return;
      }
      void this.dispatch(ws, connectionId, frame as JsonRpcRequest, inflight);
    });

    ws.on('close', () => {
      for (const ac of inflight.values()) ac.abort();
      inflight.clear();
    });

    ws.on('error', () => {
      for (const ac of inflight.values()) ac.abort();
      inflight.clear();
    });
  }

  private async dispatch(
    ws: WebSocket,
    connectionId: string,
    req: JsonRpcRequest,
    inflight: Map<JsonRpcId, AbortController>,
  ): Promise<void> {
    const handler = this.methods[req.method];
    if (!handler) {
      safeSend(
        ws,
        encodeFrame(errorFrame(req.id, RpcErrorCode.MethodNotFound, `method not found: ${req.method}`)),
      );
      return;
    }

    const ac = new AbortController();
    inflight.set(req.id, ac);

    const ctx: RpcContext = {
      connectionId,
      requestId: req.id,
      signal: ac.signal,
      notify: (method, params) => {
        if (ws.readyState !== ws.OPEN) return false;
        ws.send(encodeFrame(notification(method, params)));
        return true;
      },
    };

    try {
      const result = await handler(req.params, ctx);
      safeSend(ws, encodeFrame(successFrame(req.id, result)));

      // Special case: `gateway.shutdown` — trigger listener after responding.
      if (req.method === 'gateway.shutdown' && this.onShutdownRequested) {
        // Fire and forget — the response has already been flushed.
        void this.onShutdownRequested().catch(() => {});
      }
    } catch (err) {
      const frame =
        err instanceof RpcError
          ? errorFrame(req.id, err.code, err.message, err.data)
          : errorFrame(
              req.id,
              RpcErrorCode.InternalError,
              (err as Error).message ?? 'internal error',
            );
      safeSend(ws, encodeFrame(frame));
    } finally {
      inflight.delete(req.id);
    }
  }
}

function safeSend(ws: WebSocket, payload: string): void {
  if (ws.readyState === ws.OPEN) ws.send(payload);
}
