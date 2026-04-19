import WebSocket from 'ws';
import type { DiscordMessage } from './discord-client.js';
import {
  DEFAULT_GATEWAY_URL,
  GatewayOp,
  combineIntents,
  Intent,
  type GatewayPayload,
} from './gateway-opcodes.js';

export interface GatewayClientOptions {
  token: string;
  /**
   * Gateway URL override. Useful for tests pointing at a local mock WS server.
   */
  url?: string;
  /**
   * Explicit intent bitmask. Default: GuildMessages | DirectMessages | MessageContent.
   */
  intents?: number;
  /**
   * Inject a WebSocket class for tests. Defaults to the `ws` library.
   */
  WebSocketImpl?: typeof WebSocket;
  /**
   * Clock injection for tests (heartbeat scheduling). Defaults to `setInterval`/`clearInterval`.
   */
  now?: () => number;
}

type MessageCreateHandler = (msg: DiscordMessage, isDm: boolean) => void;

/**
 * Minimal Discord Gateway v10 client.
 *
 * Scope:
 * - HELLO → IDENTIFY → dispatch loop
 * - HEARTBEAT on the interval advertised in HELLO
 * - Emits `MESSAGE_CREATE` events through the registered handler
 *
 * Not covered (future scope):
 * - Resume after disconnect
 * - Sharding
 * - Compression
 * - Voice
 *
 * The `ws` library is used but injectable so tests can run against a local
 * fake WS server (see `gateway-client.test.ts`).
 */
export class DiscordGatewayClient {
  private ws?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastSeq: number | null = null;
  private onMessageCreate?: MessageCreateHandler;
  private closed = false;

  constructor(private readonly options: GatewayClientOptions) {}

  onMessage(handler: MessageCreateHandler): void {
    this.onMessageCreate = handler;
  }

  async connect(): Promise<void> {
    const Ctor = (this.options.WebSocketImpl ?? WebSocket) as typeof WebSocket;
    const url = this.options.url ?? DEFAULT_GATEWAY_URL;
    this.ws = new Ctor(url);
    // Register message/close handlers *before* waiting for open so we don't
    // drop the server's HELLO frame when it arrives immediately.
    this.ws.on('message', (raw: Buffer) => this.handleMessage(raw.toString('utf-8')));
    this.ws.on('close', () => this.cleanup());
    await new Promise<void>((resolve, reject) => {
      this.ws!.once('open', () => resolve());
      this.ws!.once('error', reject);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cleanup();
    if (this.ws && this.ws.readyState !== this.ws.CLOSED) {
      this.ws.close();
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private handleMessage(raw: string): void {
    let payload: GatewayPayload;
    try {
      payload = JSON.parse(raw) as GatewayPayload;
    } catch {
      return;
    }
    if (typeof payload.s === 'number') this.lastSeq = payload.s;

    switch (payload.op) {
      case GatewayOp.Hello:
        this.handleHello(payload.d as { heartbeat_interval: number });
        break;
      case GatewayOp.HeartbeatAck:
        // Could track ack-vs-heartbeat lag here. Stub for now.
        break;
      case GatewayOp.Heartbeat:
        this.sendHeartbeat();
        break;
      case GatewayOp.Dispatch:
        this.handleDispatch(payload);
        break;
      case GatewayOp.Reconnect:
      case GatewayOp.InvalidSession:
        // Caller-facing signal: close and let them reconnect via `connect()`.
        this.cleanup();
        this.ws?.close();
        break;
    }
  }

  private handleHello(d: { heartbeat_interval: number }): void {
    this.startHeartbeat(d.heartbeat_interval);
    this.sendIdentify();
  }

  private sendIdentify(): void {
    const intents =
      this.options.intents ??
      combineIntents(Intent.GuildMessages, Intent.DirectMessages, Intent.MessageContent);
    this.send({
      op: GatewayOp.Identify,
      d: {
        token: this.options.token,
        intents,
        properties: {
          os: process.platform,
          browser: 'agent-platform',
          device: 'agent-platform',
        },
      },
    });
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => this.sendHeartbeat(), intervalMs);
  }

  private sendHeartbeat(): void {
    this.send({ op: GatewayOp.Heartbeat, d: this.lastSeq });
  }

  private send(payload: GatewayPayload): void {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  private handleDispatch(payload: GatewayPayload): void {
    if (payload.t !== 'MESSAGE_CREATE') return;
    const msg = payload.d as DiscordMessage & {
      guild_id?: string;
    };
    const isDm = msg.guild_id === undefined;
    this.onMessageCreate?.(msg, isDm);
  }

  private cleanup(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  /**
   * Test helper — returns the underlying WebSocket so tests can assert on its
   * state (never needed in production code).
   */
  _socket(): WebSocket | undefined {
    return this.ws;
  }

  /**
   * Test helper — inject a raw inbound frame.
   */
  _inject(payload: GatewayPayload): void {
    this.handleMessage(JSON.stringify(payload));
  }
}
