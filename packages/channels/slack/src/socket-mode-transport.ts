import WebSocket from 'ws';
import type { SlackEventsRequest } from './slack-events.js';

/**
 * Slack Socket Mode envelope shape. Slack pushes one of these per inbound
 * frame; every envelope with an `envelope_id` must be acked back through
 * the WS within 3s.
 */
interface SocketEnvelope {
  type: 'hello' | 'events_api' | 'disconnect' | string;
  envelope_id?: string;
  payload?: SlackEventsRequest;
  accepts_response_payload?: boolean;
  reason?: string;
  num_connections?: number;
}

export type SocketLifecycleEvent =
  | { type: 'connecting'; attempt: number }
  | { type: 'open' }
  | { type: 'hello'; numConnections: number }
  | { type: 'event'; envelopeId: string; eventType: string }
  | { type: 'ack'; envelopeId: string }
  | { type: 'disconnect_warning'; reason: string }
  | { type: 'disconnect_immediate'; reason: string }
  | { type: 'close'; code: number; willReconnect: boolean }
  | { type: 'reconnect_scheduled'; delayMs: number }
  | { type: 'fatal'; reason: string };

export interface SocketModeOptions {
  /**
   * App-level token (xapp-…). Used to call `apps.connections.open` and
   * obtain the temporary WSS URL that Slack issues per connection.
   */
  appToken: string;
  /**
   * Override for `apps.connections.open` (default: Slack's prod URL). Tests
   * point this at a local mock server.
   */
  apiBase?: string;
  /**
   * Bypass the `apps.connections.open` round-trip and connect directly to
   * the given WSS URL. Used by integration tests against a fake gateway.
   * When set, this URL is reused for every reconnect attempt.
   */
  socketUrlOverride?: string;
  WebSocketImpl?: typeof WebSocket;
  /**
   * Auto-reconnect on close (default: true). Slack issues short-lived URLs,
   * so disconnects are part of normal operation — `reason: 'refresh_requested'`
   * arrives roughly every hour.
   */
  autoReconnect?: boolean;
  /**
   * Cap for exponential backoff between reconnect attempts (default: 30_000ms).
   */
  maxReconnectDelayMs?: number;
  /**
   * Per-event handler. Slack frames the events_api payload identically to the
   * Events-API HTTP body, so the adapter can reuse its existing dispatcher.
   */
  onEvent: (payload: SlackEventsRequest) => void;
  onLifecycle?: (event: SocketLifecycleEvent) => void;
}

interface AppsConnectionsOpenResponse {
  ok: boolean;
  url?: string;
  error?: string;
}

/**
 * Slack Socket Mode WS client.
 *
 * Lifecycle:
 *   apps.connections.open → wss URL → HELLO → events_api envelopes
 *   (ack each within 3s) → disconnect{warning|refresh_requested} → close → reconnect
 *
 * The `ws` library is used but injectable for tests (see
 * `socket-mode-transport.test.ts`).
 */
export class SocketModeTransport {
  private ws?: WebSocket;
  private closed = false;
  private fatal = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempts = 0;
  private readonly autoReconnect: boolean;
  private readonly maxReconnectDelayMs: number;

  constructor(private readonly options: SocketModeOptions) {
    this.autoReconnect = options.autoReconnect ?? true;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30_000;
  }

  async start(): Promise<void> {
    await this.openSocket();
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.ws && this.ws.readyState !== this.ws.CLOSED) {
      this.ws.close();
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  isOpen(): boolean {
    return this.ws !== undefined && this.ws.readyState === this.ws.OPEN;
  }

  private async resolveSocketUrl(): Promise<string> {
    if (this.options.socketUrlOverride) return this.options.socketUrlOverride;
    const base = this.options.apiBase ?? 'https://slack.com/api';
    const res = await fetch(`${base}/apps.connections.open`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.appToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    if (!res.ok) {
      throw new Error(`apps.connections.open HTTP ${res.status}`);
    }
    const body = (await res.json()) as AppsConnectionsOpenResponse;
    if (!body.ok || !body.url) {
      throw new Error(`apps.connections.open failed: ${body.error ?? 'no url returned'}`);
    }
    return body.url;
  }

  private async openSocket(): Promise<void> {
    if (this.closed || this.fatal) return;
    this.emit({ type: 'connecting', attempt: this.reconnectAttempts });
    let url: string;
    try {
      url = await this.resolveSocketUrl();
    } catch (err) {
      this.scheduleReconnect((err as Error).message);
      return;
    }

    const Ctor = (this.options.WebSocketImpl ?? WebSocket) as typeof WebSocket;
    const ws = new Ctor(url);
    this.ws = ws;

    ws.on('message', (raw: Buffer) => this.handleMessage(raw.toString('utf-8')));
    ws.on('close', (code: number) => this.handleClose(code));
    ws.on('error', () => {
      // Errors land here only on socket-level failures. The ensuing `close`
      // event drives the reconnect logic.
    });
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.off('error', onError);
        this.emit({ type: 'open' });
        resolve();
      };
      const onError = (err: Error) => {
        ws.off('open', onOpen);
        reject(err);
      };
      ws.once('open', onOpen);
      ws.once('error', onError);
    });
  }

  private handleMessage(raw: string): void {
    let env: SocketEnvelope;
    try {
      env = JSON.parse(raw) as SocketEnvelope;
    } catch {
      return;
    }
    switch (env.type) {
      case 'hello':
        this.reconnectAttempts = 0;
        this.emit({ type: 'hello', numConnections: env.num_connections ?? 1 });
        return;
      case 'disconnect':
        // `warning` is a 1-minute heads-up that the URL will be refreshed
        // soon — we keep serving until the actual close. `refresh_requested`
        // means Slack wants us off this socket now; close and reconnect.
        if (env.reason === 'refresh_requested') {
          this.emit({ type: 'disconnect_immediate', reason: env.reason });
          this.ws?.close();
        } else {
          this.emit({ type: 'disconnect_warning', reason: env.reason ?? 'warning' });
        }
        return;
      case 'events_api':
      case 'interactive':
      case 'slash_commands': {
        if (env.envelope_id) {
          this.emit({
            type: 'event',
            envelopeId: env.envelope_id,
            eventType: env.payload?.event?.type ?? env.type,
          });
          this.ack(env.envelope_id);
        }
        if (env.type === 'events_api' && env.payload) {
          this.options.onEvent(env.payload);
        }
        return;
      }
      default:
        // Ignore other envelope kinds (`pong`, etc.).
        return;
    }
  }

  private ack(envelopeId: string): void {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(JSON.stringify({ envelope_id: envelopeId }));
    this.emit({ type: 'ack', envelopeId });
  }

  private handleClose(code: number): void {
    if (this.closed) {
      this.emit({ type: 'close', code, willReconnect: false });
      return;
    }
    if (!this.autoReconnect) {
      this.emit({ type: 'close', code, willReconnect: false });
      return;
    }
    this.emit({ type: 'close', code, willReconnect: true });
    this.scheduleReconnect(`close ${code}`);
  }

  private scheduleReconnect(reason: string): void {
    if (this.closed || this.fatal) return;
    if (!this.autoReconnect) return;
    const delay = this.nextBackoffDelayMs();
    this.reconnectAttempts += 1;
    this.emit({ type: 'reconnect_scheduled', delayMs: delay });
    void reason; // suppressed in production; visible via lifecycle close events
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.openSocket().catch(() => {
        // openSocket scheduled its own reconnect on the resolveSocketUrl path,
        // and the close handler covers post-open failures.
      });
    }, delay);
  }

  private nextBackoffDelayMs(): number {
    const base = 1_000 * 2 ** Math.min(this.reconnectAttempts, 5);
    return Math.min(base, this.maxReconnectDelayMs);
  }

  private emit(event: SocketLifecycleEvent): void {
    this.options.onLifecycle?.(event);
  }
}
