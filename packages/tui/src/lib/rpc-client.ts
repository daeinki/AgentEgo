import WebSocket from 'ws';

/**
 * A minimal JSON-RPC 2.0 client for the gateway's `/rpc` endpoint. Handles:
 *  - bearer auth on upgrade
 *  - id allocation and correlation of results to requests
 *  - server-sent notifications (per-request for streaming + general broadcasts)
 *  - reconnect with exponential backoff (capped at 5s, up to 5 retries)
 *
 * This is intentionally framework-free so it can be used from both the TUI
 * (via a React hook) and plain scripts.
 */
export interface RpcClientOptions {
  url: string;
  authToken: string;
  /** Called on every successful open (initial + reconnect). */
  onOpen?: () => void;
  /** Called on disconnect. */
  onClose?: (info: { willReconnect: boolean; attempt: number }) => void;
  /** Called for a server notification (no `id`). */
  onNotification?: (method: string, params: unknown) => void;
  /** Maximum reconnect attempts. Default 5. */
  maxReconnectAttempts?: number;
}

export interface CallOptions {
  /** Per-call streaming notification listener (e.g. `chat.delta`). */
  onNotification?: (method: string, params: unknown) => void;
  /** Timeout in milliseconds. Default 60_000. */
  timeoutMs?: number;
  /** Abort signal — closes the pending promise when fired. */
  signal?: AbortSignal;
}

interface Pending {
  resolve(result: unknown): void;
  reject(err: Error): void;
  onNotification?: (method: string, params: unknown) => void;
  timer: NodeJS.Timeout;
}

export class RpcClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<string | number, Pending>();
  private reconnectAttempt = 0;
  private closedByCaller = false;
  private readonly maxAttempts: number;
  private readyPromise: Promise<void> | null = null;

  constructor(private readonly opts: RpcClientOptions) {
    this.maxAttempts = opts.maxReconnectAttempts ?? 5;
  }

  /** Open the connection. Resolves on first successful upgrade. */
  connect(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.openSocket();
    return this.readyPromise;
  }

  /** Close the socket permanently (no reconnect). */
  close(): void {
    this.closedByCaller = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('client closed'));
    }
    this.pending.clear();
    this.ws?.close();
    this.ws = null;
  }

  /** Whether the socket is currently open. */
  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async call<R = unknown>(method: string, params: unknown, options: CallOptions = {}): Promise<R> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      await this.connect();
    }
    const ws = this.ws!;
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? 60_000;

    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const pending: Pending = {
        resolve: (r) => resolve(r as R),
        reject,
        timer,
      };
      if (options.onNotification) pending.onNotification = options.onNotification;
      this.pending.set(id, pending);

      if (options.signal) {
        options.signal.addEventListener(
          'abort',
          () => {
            this.pending.delete(id);
            clearTimeout(timer);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      }

      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.url, {
        headers: { Authorization: `Bearer ${this.opts.authToken}` },
      });
      this.ws = ws;

      const fail = (err: Error) => {
        this.ws = null;
        this.readyPromise = null;
        reject(err);
      };

      ws.once('unexpected-response', (_req, res) => {
        fail(new Error(`gateway rejected upgrade with HTTP ${res.statusCode ?? '?'}`));
      });
      ws.once('error', (err) => fail(err));

      ws.once('open', () => {
        this.reconnectAttempt = 0;
        this.opts.onOpen?.();
        resolve();
      });

      ws.on('message', (data) => this.handleMessage(data.toString('utf-8')));

      ws.on('close', () => {
        if (this.closedByCaller) return;
        this.readyPromise = null;
        const willReconnect = this.reconnectAttempt < this.maxAttempts;
        this.opts.onClose?.({ willReconnect, attempt: this.reconnectAttempt });
        if (willReconnect) {
          const delay = Math.min(5000, 500 * 2 ** this.reconnectAttempt);
          this.reconnectAttempt++;
          setTimeout(() => {
            this.openSocket().catch(() => {});
          }, delay);
        } else {
          // Fail any remaining pending calls so UI can react.
          for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(new Error('socket closed'));
          }
          this.pending.clear();
        }
      });
    });
  }

  private handleMessage(raw: string): void {
    let frame: {
      id?: unknown;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    };
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }

    // Server notification
    if (frame.id === undefined && typeof frame.method === 'string') {
      // Per-request notification? Find any pending with onNotification and
      // forward. Since notifications don't carry the request id directly,
      // we include `requestId` in params as a convention for chat.* methods.
      const params = (frame.params ?? {}) as { requestId?: string | number };
      if (params.requestId !== undefined && this.pending.has(params.requestId)) {
        this.pending.get(params.requestId)!.onNotification?.(frame.method, frame.params);
      }
      this.opts.onNotification?.(frame.method, frame.params);
      return;
    }

    // Response
    if (frame.id !== undefined && (typeof frame.id === 'string' || typeof frame.id === 'number')) {
      const p = this.pending.get(frame.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(frame.id);
      if (frame.error) {
        p.reject(new Error(`${frame.error.message} (code ${frame.error.code})`));
      } else {
        p.resolve(frame.result);
      }
    }
  }
}
