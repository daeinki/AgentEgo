import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type WebSocket from 'ws';
import type { Contracts, OutboundContent, StandardMessage } from '@agent-platform/core';
import { generateMessageId, generateTraceId, nowMs } from '@agent-platform/core';
import type { SlackClient } from './slack-client.js';
import { HttpSlackClient } from './slack-client.js';
import { verifySlackSignature } from './signing.js';
import type { SlackEventsRequest, SlackMessageEvent } from './slack-events.js';
import { SocketModeTransport, type SocketLifecycleEvent } from './socket-mode-transport.js';

type ChannelAdapter = Contracts.ChannelAdapter;
type ChannelConfig = Contracts.ChannelConfig;
type HealthStatus = Contracts.HealthStatus;
type SendResult = Contracts.SendResult;

interface SlackConfigBase extends ChannelConfig {
  type: 'slack';
  /**
   * Bot User OAuth Token (xoxb-...). Required unless `client` is injected.
   */
  botToken?: string;
  client?: SlackClient;
  ownerIds?: string[];
}

export interface HttpSlackConfig extends SlackConfigBase {
  /** Default — Events API webhook over HTTP. */
  transport?: 'http';
  /**
   * Slack app signing secret (for Events API verification).
   */
  signingSecret: string;
  /**
   * Port to bind the Events API HTTP server. 0 = OS-assigned.
   */
  port: number;
}

export interface SocketSlackConfig extends SlackConfigBase {
  /** Socket Mode WebSocket transport. */
  transport: 'socket';
  /**
   * App-Level Token (xapp-…). Slack issues this separately from the bot
   * token; required to call `apps.connections.open`.
   */
  appToken: string;
  /**
   * Test/staging override that bypasses `apps.connections.open` and connects
   * directly to a given WSS URL.
   */
  socketUrlOverride?: string;
  /**
   * Inject a WebSocket class for tests. Defaults to the `ws` library.
   */
  WebSocketImpl?: typeof WebSocket;
  /**
   * Auto-reconnect behavior (default: true). Disable in tests that want to
   * observe a single close.
   */
  autoReconnect?: boolean;
  maxReconnectDelayMs?: number;
  onLifecycle?: (event: SocketLifecycleEvent) => void;
}

export type SlackConfig = HttpSlackConfig | SocketSlackConfig;

/**
 * Slack channel adapter — supports two inbound transports:
 *
 * - `transport: 'http'` (default): Events API HTTP webhook with signing-
 *   secret verification. Outbound goes through `chat.postMessage`.
 * - `transport: 'socket'`: Slack Socket Mode WebSocket. The adapter calls
 *   `apps.connections.open` to lease a WSS URL, ack envelopes within 3s,
 *   and reconnects automatically on Slack's hourly URL refresh.
 *
 * The translation layer (`toStandardMessage`) is shared — both transports
 * yield the same Events API event shape.
 */
export class SlackAdapter implements ChannelAdapter {
  private config!: SlackConfig;
  private client!: SlackClient;
  private handler?: (msg: StandardMessage) => void;
  private running = false;

  // HTTP-mode state
  private http?: Server;
  private port = 0;

  // Socket-mode state
  private socket?: SocketModeTransport;

  async initialize(config: ChannelConfig): Promise<void> {
    if (config['type'] !== 'slack') throw new Error('SlackAdapter expects type=slack');
    this.config = config as SlackConfig;

    if (this.config.client) {
      this.client = this.config.client;
    } else if (this.config.botToken) {
      this.client = new HttpSlackClient(this.config.botToken);
    } else {
      throw new Error('SlackAdapter requires either `botToken` or `client`');
    }

    if (this.config.transport === 'socket') {
      await this.startSocketMode(this.config);
    } else {
      await this.startHttpMode(this.config);
    }
    this.running = true;
  }

  async shutdown(): Promise<void> {
    this.running = false;
    if (this.http) {
      await new Promise<void>((resolve, reject) => {
        this.http!.close((err) => (err ? reject(err) : resolve()));
      });
    }
    if (this.socket) {
      await this.socket.stop();
    }
    await this.client.close();
  }

  async healthCheck(): Promise<HealthStatus> {
    if (this.config?.transport === 'socket') {
      return {
        healthy: this.running && (this.socket?.isOpen() ?? false),
        lastCheckedAt: nowMs(),
        message: 'transport=socket',
      };
    }
    return {
      healthy: this.running && (this.http?.listening ?? false),
      lastCheckedAt: nowMs(),
      message: `transport=http port=${this.port}`,
    };
  }

  onMessage(handler: (msg: StandardMessage) => void): void {
    this.handler = handler;
  }

  async sendMessage(conversationId: string, content: OutboundContent): Promise<SendResult> {
    if (content.type !== 'text') {
      return {
        messageId: generateMessageId(),
        sentAt: nowMs(),
        status: 'failed',
        error: `unsupported content type: ${content.type}`,
      };
    }
    const res = await this.client.postMessage({
      channel: conversationId,
      text: content.text,
    });
    if (!res.ok) {
      return {
        messageId: generateMessageId(),
        sentAt: nowMs(),
        status: 'failed',
        error: res.error ?? 'unknown slack error',
      };
    }
    return {
      messageId: res.ts ?? generateMessageId(),
      sentAt: nowMs(),
      status: 'sent',
    };
  }

  async sendTypingIndicator(_conversationId: string, _isTyping: boolean): Promise<void> {
    // Slack has no public typing indicator API for bots — no-op.
  }

  async isAllowed(senderId: string, _conversationType: string): Promise<boolean> {
    if (!this.config.ownerIds || this.config.ownerIds.length === 0) return true;
    return this.config.ownerIds.includes(senderId);
  }

  /**
   * Test entry-point — feed a pre-verified Events API payload.
   */
  injectEvent(payload: SlackEventsRequest): void {
    this.dispatchEvent(payload);
  }

  /**
   * HTTP transport only. Returns 0 in socket mode.
   */
  listeningPort(): number {
    return this.port;
  }

  // ─── Transports ──────────────────────────────────────────────────────────

  private async startHttpMode(config: HttpSlackConfig): Promise<void> {
    this.http = createServer((req, res) => this.handleHttp(config, req, res));
    await new Promise<void>((resolve) => {
      this.http!.listen(config.port, () => {
        const addr = this.http!.address();
        this.port = typeof addr === 'object' && addr ? addr.port : config.port;
        resolve();
      });
    });
  }

  private async startSocketMode(config: SocketSlackConfig): Promise<void> {
    const opts: ConstructorParameters<typeof SocketModeTransport>[0] = {
      appToken: config.appToken,
      onEvent: (payload) => this.dispatchEvent(payload),
    };
    if (config.socketUrlOverride !== undefined) opts.socketUrlOverride = config.socketUrlOverride;
    if (config.WebSocketImpl !== undefined) opts.WebSocketImpl = config.WebSocketImpl;
    if (config.autoReconnect !== undefined) opts.autoReconnect = config.autoReconnect;
    if (config.maxReconnectDelayMs !== undefined) opts.maxReconnectDelayMs = config.maxReconnectDelayMs;
    if (config.onLifecycle !== undefined) opts.onLifecycle = config.onLifecycle;
    this.socket = new SocketModeTransport(opts);
    await this.socket.start();
  }

  private async handleHttp(
    config: HttpSlackConfig,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const body = await readBody(req);
    const timestamp = headerValue(req, 'x-slack-request-timestamp') ?? '';
    const signature = headerValue(req, 'x-slack-signature') ?? '';

    const ok = verifySlackSignature({
      signingSecret: config.signingSecret,
      timestamp,
      signature,
      body,
    });
    if (!ok) {
      res.writeHead(401).end('bad signature');
      return;
    }

    let parsed: SlackEventsRequest;
    try {
      parsed = JSON.parse(body) as SlackEventsRequest;
    } catch {
      res.writeHead(400).end('invalid json');
      return;
    }

    if (parsed.type === 'url_verification') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end(parsed.challenge ?? '');
      return;
    }

    if (parsed.type === 'event_callback') {
      this.dispatchEvent(parsed);
      res.writeHead(200).end('ok');
      return;
    }

    res.writeHead(200).end();
  }

  private dispatchEvent(payload: SlackEventsRequest): void {
    const ev = payload.event;
    if (!ev || ev.type !== 'message') return;
    if (ev.bot_id) return;
    const msg = this.toStandardMessage(ev);
    if (msg) this.handler?.(msg);
  }

  private toStandardMessage(ev: SlackMessageEvent): StandardMessage | null {
    if (!ev.user || !ev.text) return null;
    const isOwner = this.isOwnerId(ev.user) && ev.channel_type === 'im';
    const msg: StandardMessage = {
      id: ev.ts,
      traceId: generateTraceId(),
      timestamp: Math.floor(Number(ev.ts) * 1000),
      channel: {
        type: 'slack',
        id: 'slack',
        metadata: { channelType: ev.channel_type ?? 'channel' },
      },
      sender: { id: ev.user, isOwner },
      conversation: {
        type: ev.channel_type === 'im' ? 'dm' : 'group',
        id: ev.channel,
      },
      content: { type: 'text', text: ev.text },
    };
    return msg;
  }

  private isOwnerId(userId: string): boolean {
    if (!this.config.ownerIds || this.config.ownerIds.length === 0) return false;
    return this.config.ownerIds.includes(userId);
  }
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const h = req.headers[name.toLowerCase()];
  return Array.isArray(h) ? h[0] : h;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}
