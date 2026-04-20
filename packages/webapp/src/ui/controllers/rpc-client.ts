/**
 * Browser JSON-RPC 2.0 client for the gateway's `/rpc` WebSocket endpoint.
 * Mirrors the behavior of the TUI's rpc-client with two deltas:
 *
 *  - Auth travels via `Sec-WebSocket-Protocol: bearer.<token>` because the
 *    browser WebSocket API cannot set arbitrary headers.
 *  - No Node-specific deps — plain `window.WebSocket`.
 */

export interface RpcClientOptions {
  url: string;
  /** Produces the bearer token on every connect (device-auth may rotate it). */
  getToken: () => Promise<string>;
  onOpen?: () => void;
  onClose?: (info: { willReconnect: boolean; attempt: number }) => void;
  onNotification?: (method: string, params: unknown) => void;
  maxReconnectAttempts?: number;
}

export interface CallOptions {
  onNotification?: (method: string, params: unknown) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface Pending {
  resolve(result: unknown): void;
  reject(err: Error): void;
  onNotification?: (method: string, params: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

type JsonRpcId = number | string;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcInbound {
  jsonrpc?: '2.0';
  id?: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
  params?: unknown;
}

export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'closed';

export class BrowserRpcClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private reconnectAttempt = 0;
  private closedByCaller = false;
  private readonly maxAttempts: number;
  private readyPromise: Promise<void> | null = null;
  private status: ConnectionStatus = 'idle';
  private readonly statusListeners = new Set<(s: ConnectionStatus) => void>();

  constructor(private readonly opts: RpcClientOptions) {
    this.maxAttempts = opts.maxReconnectAttempts ?? 6;
  }

  onStatus(fn: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(fn);
    fn(this.status);
    return () => {
      this.statusListeners.delete(fn);
    };
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  /** Connect eagerly. Idempotent. */
  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.openOnce();
    try {
      await this.readyPromise;
    } finally {
      this.readyPromise = null;
    }
  }

  close(): void {
    this.closedByCaller = true;
    this.setStatus('closed');
    this.ws?.close();
  }

  async call<R = unknown>(
    method: string,
    params: unknown = {},
    options: CallOptions = {},
  ): Promise<R> {
    await this.connect();
    const id = this.nextId++;
    const frame: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise<R>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? 60_000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }, timeoutMs);
      const entry: Pending = {
        resolve: (r) => resolve(r as R),
        reject,
        timer,
      };
      if (options.onNotification) entry.onNotification = options.onNotification;
      this.pending.set(id, entry);
      if (options.signal) {
        const onAbort = () => {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new Error('aborted'));
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
      this.ws!.send(JSON.stringify(frame));
    });
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async openOnce(): Promise<void> {
    this.setStatus(this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting');
    const token = await this.opts.getToken();
    // Browser WS sends the subprotocol to the server; our ApiGateway parses
    // it out to authenticate the upgrade.
    const ws = new WebSocket(this.opts.url, [`bearer.${token}`]);
    this.ws = ws;
    return new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        this.reconnectAttempt = 0;
        this.setStatus('open');
        this.opts.onOpen?.();
        resolve();
      };
      ws.onmessage = (ev) => this.handleMessage(ev.data);
      ws.onclose = () => this.handleClose(reject);
      ws.onerror = () => {
        // onclose always fires after onerror; let it drive reconnect.
      };
    });
  }

  private handleClose(reject: (err: Error) => void): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('socket closed'));
      this.pending.delete(id);
    }
    if (this.closedByCaller) {
      this.setStatus('closed');
      return;
    }
    if (this.reconnectAttempt >= this.maxAttempts) {
      this.setStatus('closed');
      reject(new Error('reconnect attempts exhausted'));
      return;
    }
    this.reconnectAttempt += 1;
    this.setStatus('reconnecting');
    this.opts.onClose?.({ willReconnect: true, attempt: this.reconnectAttempt });
    const backoff = Math.min(500 * 2 ** (this.reconnectAttempt - 1), 5000);
    setTimeout(() => {
      void this.openOnce().catch(() => {
        // next tick cycle handles it
      });
    }, backoff);
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let frame: JsonRpcInbound;
    try {
      frame = JSON.parse(data) as JsonRpcInbound;
    } catch {
      return;
    }
    if (frame.id !== undefined && frame.id !== null) {
      const pending = this.pending.get(frame.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(frame.id);
        if (frame.error) {
          pending.reject(new Error(frame.error.message));
        } else {
          pending.resolve(frame.result);
        }
      }
      return;
    }
    // Notification — route per-request first, then fall through to global.
    if (frame.method) {
      const params = frame.params as
        | { requestId?: JsonRpcId }
        | undefined;
      const rid = params?.requestId;
      if (rid !== undefined) {
        const pending = this.pending.get(rid);
        pending?.onNotification?.(frame.method, frame.params);
      }
      this.opts.onNotification?.(frame.method, frame.params);
    }
  }

  private setStatus(next: ConnectionStatus): void {
    if (this.status === next) return;
    this.status = next;
    for (const fn of this.statusListeners) fn(next);
  }
}
