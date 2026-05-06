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
   * Gateway URL override. Used for the initial connection and for tests pointing
   * at a local mock WS server. Resume traffic uses `resume_gateway_url` from
   * READY when the session is resumable.
   */
  url?: string;
  /**
   * Explicit intent bitmask. Default: GuildMessages | DirectMessages | MessageContent.
   */
  intents?: number;
  /**
   * Optional `[shardId, shardCount]` sent inside IDENTIFY. Discord routes guild
   * traffic deterministically by `(guild_id >> 22) % shardCount`, so each shard
   * sees a disjoint slice of guilds. DMs always come through shard 0.
   */
  shard?: [number, number];
  /**
   * Inject a WebSocket class for tests. Defaults to the `ws` library.
   */
  WebSocketImpl?: typeof WebSocket;
  /**
   * Clock injection for tests (heartbeat scheduling). Defaults to `setInterval`/`clearInterval`.
   */
  now?: () => number;
  /**
   * Auto-reconnect on socket close (default: true). Tests use false to keep
   * close behavior observable.
   */
  autoReconnect?: boolean;
  /**
   * Cap for exponential backoff between reconnect attempts (default: 30_000ms).
   * Backoff schedule: 1s, 2s, 4s, 8s, 16s, 30s, 30s…
   */
  maxReconnectDelayMs?: number;
  /**
   * Lifecycle callback for visibility into the reconnect/resume state machine.
   * Optional; production callers can wire it to a logger or trace block.
   */
  onLifecycle?: (event: GatewayLifecycleEvent) => void;
}

export type GatewayLifecycleEvent =
  | { type: 'connecting'; attempt: number; resuming: boolean }
  | { type: 'identify'; shard?: [number, number] }
  | { type: 'resume'; sessionId: string; seq: number }
  | { type: 'ready'; sessionId: string; resumeGatewayUrl: string | null }
  | { type: 'resumed' }
  | { type: 'invalid_session'; resumable: boolean }
  | { type: 'close'; code: number; resumable: boolean; willReconnect: boolean }
  | { type: 'reconnect_scheduled'; delayMs: number; resuming: boolean }
  | { type: 'fatal'; code: number; reason: string };

type MessageCreateHandler = (msg: DiscordMessage, isDm: boolean) => void;

/**
 * Discord WS close codes that are non-resumable: the existing session_id is
 * dead and we must IDENTIFY again. Anything else (including 1006 abnormal
 * closure from a transient network drop) is treated as resumable.
 *
 * 4004 / 4010-4014 are fatal — re-identifying will fail in the same way, so
 * we abort the reconnect loop entirely.
 */
const NON_RESUMABLE_CODES: ReadonlySet<number> = new Set([4007, 4009]);
const FATAL_CODES: ReadonlySet<number> = new Set([4004, 4010, 4011, 4012, 4013, 4014]);

/**
 * Minimal Discord Gateway v10 client.
 *
 * Scope:
 * - HELLO → IDENTIFY → dispatch loop
 * - HEARTBEAT on the interval advertised in HELLO
 * - Resume after disconnect (op6 RESUME with session_id + lastSeq)
 * - Sharding via the `shard` option (one instance per shard; see
 *   `DiscordShardManager` for multi-shard fan-out)
 * - Auto-reconnect with exponential backoff
 * - Emits `MESSAGE_CREATE` events through the registered handler
 *
 * Not covered:
 * - Compression / Voice
 *
 * The `ws` library is used but injectable so tests can run against a local
 * fake WS server (see `gateway-client.test.ts`).
 */
export class DiscordGatewayClient {
  private ws?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private lastSeq: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private onMessageCreate?: MessageCreateHandler;
  private closed = false;
  private fatal = false;
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private resumePending = false;
  private readonly autoReconnect: boolean;
  private readonly maxReconnectDelayMs: number;

  constructor(private readonly options: GatewayClientOptions) {
    this.autoReconnect = options.autoReconnect ?? true;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30_000;
  }

  onMessage(handler: MessageCreateHandler): void {
    this.onMessageCreate = handler;
  }

  async connect(): Promise<void> {
    await this.openSocket(false);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.cleanup();
    if (this.ws && this.ws.readyState !== this.ws.CLOSED) {
      this.ws.close();
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /**
   * Currently held session id (set after READY). `null` between disconnects
   * that invalidate the session. Tests use this to assert resume state.
   */
  sessionState(): { sessionId: string | null; lastSeq: number | null } {
    return { sessionId: this.sessionId, lastSeq: this.lastSeq };
  }

  // ─── Connection lifecycle ────────────────────────────────────────────────

  private async openSocket(resuming: boolean): Promise<void> {
    if (this.closed || this.fatal) return;
    const Ctor = (this.options.WebSocketImpl ?? WebSocket) as typeof WebSocket;
    const url =
      resuming && this.resumeGatewayUrl
        ? this.resumeGatewayUrl
        : (this.options.url ?? DEFAULT_GATEWAY_URL);
    this.resumePending = resuming;
    this.emit({ type: 'connecting', attempt: this.reconnectAttempts, resuming });

    this.ws = new Ctor(url);
    // Register message/close handlers *before* waiting for open so we don't
    // drop the server's HELLO frame when it arrives immediately.
    this.ws.on('message', (raw: Buffer) => this.handleMessage(raw.toString('utf-8')));
    this.ws.on('close', (code: number) => this.handleClose(code));
    this.ws.on('error', () => {
      // Errors land here only on socket-level failures (TLS, DNS, refused).
      // The ensuing `close` event drives the reconnect logic.
    });
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        this.ws!.off('error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        this.ws!.off('open', onOpen);
        reject(err);
      };
      this.ws!.once('open', onOpen);
      this.ws!.once('error', onError);
    });
  }

  private handleClose(code: number): void {
    this.cleanup();

    if (this.closed) return;

    if (FATAL_CODES.has(code)) {
      this.fatal = true;
      this.emit({ type: 'fatal', code, reason: 'non-recoverable close code' });
      this.emit({ type: 'close', code, resumable: false, willReconnect: false });
      return;
    }

    const resumable = !NON_RESUMABLE_CODES.has(code) && this.sessionId !== null;
    if (!resumable) {
      // Drop session — next IDENTIFY starts fresh.
      this.sessionId = null;
      this.resumeGatewayUrl = null;
      this.lastSeq = null;
    }

    if (!this.autoReconnect) {
      this.emit({ type: 'close', code, resumable, willReconnect: false });
      return;
    }

    const delay = this.nextBackoffDelayMs();
    this.reconnectAttempts += 1;
    this.emit({ type: 'close', code, resumable, willReconnect: true });
    this.emit({ type: 'reconnect_scheduled', delayMs: delay, resuming: resumable });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.openSocket(resumable).catch(() => {
        // openSocket itself queued no further reconnect; the close handler
        // from the failed attempt will re-arm the timer.
      });
    }, delay);
  }

  private nextBackoffDelayMs(): number {
    const base = 1_000 * 2 ** Math.min(this.reconnectAttempts, 5);
    return Math.min(base, this.maxReconnectDelayMs);
  }

  // ─── Inbound dispatch ────────────────────────────────────────────────────

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
        // Server asked us to reconnect — close, the close handler drives
        // resume on reconnect.
        this.ws?.close();
        break;
      case GatewayOp.InvalidSession: {
        const resumable = payload.d === true;
        this.emit({ type: 'invalid_session', resumable });
        if (!resumable) {
          this.sessionId = null;
          this.resumeGatewayUrl = null;
          this.lastSeq = null;
        }
        // Per Discord docs: wait a small random delay before re-identifying.
        // The close handler picks up backoff; just close here.
        this.ws?.close();
        break;
      }
    }
  }

  private handleHello(d: { heartbeat_interval: number }): void {
    this.startHeartbeat(d.heartbeat_interval);
    if (this.resumePending && this.sessionId !== null && this.lastSeq !== null) {
      this.sendResume(this.sessionId, this.lastSeq);
    } else {
      this.sendIdentify();
    }
  }

  private sendIdentify(): void {
    const intents =
      this.options.intents ??
      combineIntents(Intent.GuildMessages, Intent.DirectMessages, Intent.MessageContent);
    const d: Record<string, unknown> = {
      token: this.options.token,
      intents,
      properties: {
        os: process.platform,
        browser: 'agent-platform',
        device: 'agent-platform',
      },
    };
    if (this.options.shard) d['shard'] = this.options.shard;
    this.send({ op: GatewayOp.Identify, d });
    const ev: GatewayLifecycleEvent = this.options.shard
      ? { type: 'identify', shard: this.options.shard }
      : { type: 'identify' };
    this.emit(ev);
  }

  private sendResume(sessionId: string, seq: number): void {
    this.send({
      op: GatewayOp.Resume,
      d: { token: this.options.token, session_id: sessionId, seq },
    });
    this.emit({ type: 'resume', sessionId, seq });
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
    if (payload.t === 'READY') {
      const ready = payload.d as {
        session_id?: string;
        resume_gateway_url?: string;
      };
      if (typeof ready.session_id === 'string') this.sessionId = ready.session_id;
      this.resumeGatewayUrl = ready.resume_gateway_url ?? null;
      this.reconnectAttempts = 0;
      this.emit({
        type: 'ready',
        sessionId: this.sessionId ?? '',
        resumeGatewayUrl: this.resumeGatewayUrl,
      });
      return;
    }
    if (payload.t === 'RESUMED') {
      this.reconnectAttempts = 0;
      this.emit({ type: 'resumed' });
      return;
    }
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

  private emit(event: GatewayLifecycleEvent): void {
    this.options.onLifecycle?.(event);
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

// ─── Multi-shard manager ───────────────────────────────────────────────────

export interface ShardManagerOptions extends Omit<
  GatewayClientOptions,
  'shard' | 'autoReconnect' | 'maxReconnectDelayMs'
> {
  /**
   * Total number of shards. Each shard `i` (0..N-1) gets its own
   * `DiscordGatewayClient` configured with `shard: [i, N]`.
   */
  shardCount: number;
  /**
   * Override per-client auto-reconnect behavior (default: true).
   */
  autoReconnect?: boolean;
  /**
   * Cap for exponential backoff (default: 30_000ms).
   */
  maxReconnectDelayMs?: number;
}

/**
 * Spawns one `DiscordGatewayClient` per shard and forwards their
 * MESSAGE_CREATE events through a single handler. Discord requires a
 * 5-second delay between IDENTIFY calls per shard bucket; this manager
 * connects shards sequentially with that gap.
 *
 * For most bots a single shard is enough — this only matters past 2,500
 * guilds. The manager exists primarily to keep the calling adapter free of
 * shard-bookkeeping.
 */
export class DiscordShardManager {
  private readonly clients: DiscordGatewayClient[] = [];
  private handler?: MessageCreateHandler;

  constructor(private readonly options: ShardManagerOptions) {
    if (options.shardCount < 1) throw new Error('shardCount must be >= 1');
  }

  onMessage(handler: MessageCreateHandler): void {
    this.handler = handler;
    for (const c of this.clients) c.onMessage(handler);
  }

  /**
   * Connect every shard. Per Discord guidance, identifies are spaced out
   * (default 5s) to avoid the per-bucket rate limit. Tests can pass
   * `identifyDelayMs: 0` to skip the wait.
   */
  async connect(identifyDelayMs = 5_000): Promise<void> {
    for (let i = 0; i < this.options.shardCount; i++) {
      const opts: GatewayClientOptions = {
        ...this.options,
        shard: [i, this.options.shardCount],
      };
      const client = new DiscordGatewayClient(opts);
      if (this.handler) client.onMessage(this.handler);
      this.clients.push(client);
      await client.connect();
      if (i + 1 < this.options.shardCount && identifyDelayMs > 0) {
        await new Promise((r) => setTimeout(r, identifyDelayMs));
      }
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.clients.map((c) => c.close()));
  }

  shards(): readonly DiscordGatewayClient[] {
    return this.clients;
  }
}
