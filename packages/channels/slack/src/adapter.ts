import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Contracts, OutboundContent, StandardMessage } from '@agent-platform/core';
import { generateMessageId, generateTraceId, nowMs } from '@agent-platform/core';
import type { SlackClient } from './slack-client.js';
import { HttpSlackClient } from './slack-client.js';
import { verifySlackSignature } from './signing.js';

type ChannelAdapter = Contracts.ChannelAdapter;
type ChannelConfig = Contracts.ChannelConfig;
type HealthStatus = Contracts.HealthStatus;
type SendResult = Contracts.SendResult;

export interface SlackConfig extends ChannelConfig {
  type: 'slack';
  /**
   * Bot User OAuth Token (xoxb-...). Required unless `client` is injected.
   */
  botToken?: string;
  /**
   * Slack app signing secret (for Events API verification).
   */
  signingSecret: string;
  client?: SlackClient;
  /**
   * Port to bind the Events API HTTP server. 0 = OS-assigned.
   */
  port: number;
  ownerIds?: string[];
}

interface SlackEventsRequest {
  type: 'url_verification' | 'event_callback';
  challenge?: string;
  event?: SlackMessageEvent;
  team_id?: string;
}

interface SlackMessageEvent {
  type: 'message';
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  channel: string;
  channel_type?: 'im' | 'channel' | 'group' | 'mpim';
}

/**
 * Slack channel adapter — HTTP server consuming Events API + bot-token client
 * for outbound posts. Signature verification keeps spoofed requests out.
 */
export class SlackAdapter implements ChannelAdapter {
  private config!: SlackConfig;
  private client!: SlackClient;
  private http!: Server;
  private handler?: (msg: StandardMessage) => void;
  private port = 0;
  private running = false;

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

    this.http = createServer((req, res) => this.handleHttp(req, res));
    await new Promise<void>((resolve) => {
      this.http.listen(this.config.port, () => {
        const addr = this.http.address();
        this.port = typeof addr === 'object' && addr ? addr.port : this.config.port;
        resolve();
      });
    });
    this.running = true;
  }

  async shutdown(): Promise<void> {
    this.running = false;
    await new Promise<void>((resolve, reject) => {
      this.http.close((err) => (err ? reject(err) : resolve()));
    });
    await this.client.close();
  }

  async healthCheck(): Promise<HealthStatus> {
    return {
      healthy: this.running && this.http.listening,
      lastCheckedAt: nowMs(),
      message: `port=${this.port}`,
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

  listeningPort(): number {
    return this.port;
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const body = await readBody(req);
    const timestamp = headerValue(req, 'x-slack-request-timestamp') ?? '';
    const signature = headerValue(req, 'x-slack-signature') ?? '';

    const ok = verifySlackSignature({
      signingSecret: this.config.signingSecret,
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
    if (ev.bot_id) return; // ignore our own bot messages
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
