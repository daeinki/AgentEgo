import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Contracts, OutboundContent, StandardMessage } from '@agent-platform/core';
import { generateMessageId, generateTraceId, nowMs } from '@agent-platform/core';
import {
  decodeBrowserInbound,
  encodeBrowserOutbound,
  type BrowserOutbound,
} from './envelope.js';

type ChannelAdapter = Contracts.ChannelAdapter;
type ChannelConfig = Contracts.ChannelConfig;
type HealthStatus = Contracts.HealthStatus;
type SendResult = Contracts.SendResult;

export interface WebChatConfig extends ChannelConfig {
  type: 'webchat';
  port: number;
  /**
   * conversationId attached to every message that comes through this adapter.
   * Typically "webchat-default" or a user-scoped id.
   */
  conversationId?: string;
  /**
   * Allowed owner userIds. First identify-as-this gets isOwner=true.
   */
  ownerIds?: string[];
}

interface ClientRegistration {
  socket: WebSocket;
  userId: string;
  displayName?: string;
  isOwner: boolean;
}

/**
 * WebChat channel adapter: boots a WebSocket server that the browser UI
 * connects to. Inbound `say` → emits a StandardMessage via onMessage.
 * Agent / EGO responses come back through `sendMessage()` which broadcasts to
 * the conversation's registered sockets.
 */
export class WebChatAdapter implements ChannelAdapter {
  private http!: Server;
  private wss!: WebSocketServer;
  private handler?: (msg: StandardMessage) => void;
  private clients = new Map<string, Set<ClientRegistration>>(); // conversationId → clients
  private config!: WebChatConfig;
  private port = 0;

  async initialize(config: ChannelConfig): Promise<void> {
    if (config['type'] !== 'webchat') throw new Error('WebChatAdapter expects type=webchat');
    this.config = config as WebChatConfig;
    this.http = createServer();
    this.wss = new WebSocketServer({ server: this.http, path: '/webchat' });
    this.wss.on('connection', (ws) => this.handleConnection(ws));
    await new Promise<void>((resolve) => {
      this.http.listen(this.config.port, () => {
        const addr = this.http.address();
        this.port = typeof addr === 'object' && addr ? addr.port : this.config.port;
        resolve();
      });
    });
  }

  async shutdown(): Promise<void> {
    for (const set of this.clients.values()) {
      for (const c of set) c.socket.close();
    }
    this.clients.clear();
    await new Promise<void>((resolve, reject) => {
      this.wss.close(() => {
        this.http.close((err) => (err ? reject(err) : resolve()));
      });
    });
  }

  async healthCheck(): Promise<HealthStatus> {
    return {
      healthy: this.http?.listening === true,
      lastCheckedAt: nowMs(),
      message: `clients=${Array.from(this.clients.values()).reduce((acc, s) => acc + s.size, 0)}`,
    };
  }

  onMessage(handler: (msg: StandardMessage) => void): void {
    this.handler = handler;
  }

  async sendMessage(conversationId: string, content: OutboundContent): Promise<SendResult> {
    const set = this.clients.get(conversationId);
    if (!set || set.size === 0) {
      return {
        messageId: generateMessageId(),
        sentAt: nowMs(),
        status: 'failed',
        error: 'no clients connected',
      };
    }
    const env: BrowserOutbound = { type: 'out', content };
    const raw = encodeBrowserOutbound(env);
    let sent = 0;
    for (const c of set) {
      if (c.socket.readyState === c.socket.OPEN) {
        c.socket.send(raw);
        sent += 1;
      }
    }
    return {
      messageId: generateMessageId(),
      sentAt: nowMs(),
      status: sent > 0 ? 'sent' : 'failed',
      ...(sent === 0 ? { error: 'no open sockets' } : {}),
    };
  }

  async sendTypingIndicator(_conversationId: string, _isTyping: boolean): Promise<void> {
    // WebChat doesn't currently surface typing indicators. No-op.
  }

  async isAllowed(senderId: string, _conversationType: string): Promise<boolean> {
    if (!this.config.ownerIds || this.config.ownerIds.length === 0) return true;
    return this.config.ownerIds.includes(senderId);
  }

  /**
   * Stream an LLM response delta back to any client in a conversation. Used
   * by the wiring code that pipes AgentRunner's onChunk callback through.
   */
  emitDelta(conversationId: string, traceId: string, text: string): void {
    this.broadcast(conversationId, { type: 'delta', traceId, text });
  }

  emitDone(conversationId: string, traceId: string): void {
    this.broadcast(conversationId, { type: 'done', traceId });
  }

  /**
   * Listening port (0 → OS-assigned; useful for tests).
   */
  listeningPort(): number {
    return this.port;
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private handleConnection(ws: WebSocket): void {
    let registration: ClientRegistration | undefined;

    ws.on('message', (data) => {
      const parsed = decodeBrowserInbound(data.toString('utf-8'));
      if ('error' in parsed) {
        this.safeSend(ws, { type: 'error', message: parsed.error });
        return;
      }
      if (parsed.type === 'identify') {
        const isOwner = this.isOwnerId(parsed.userId);
        const reg: ClientRegistration = {
          socket: ws,
          userId: parsed.userId,
          isOwner,
        };
        if (parsed.displayName !== undefined) reg.displayName = parsed.displayName;
        registration = reg;
        const cid = this.conversationIdFor(registration);
        this.register(cid, registration);
        this.safeSend(ws, {
          type: 'system',
          text: `identified as ${parsed.userId}${isOwner ? ' (owner)' : ''}`,
        });
        return;
      }
      if (parsed.type === 'ping') {
        this.safeSend(ws, { type: 'pong', sentAt: parsed.sentAt, receivedAt: nowMs() });
        return;
      }
      if (parsed.type === 'say') {
        if (!registration) {
          this.safeSend(ws, { type: 'error', message: 'identify first' });
          return;
        }
        const msg = this.buildStandardMessage(registration, parsed.text);
        this.safeSend(ws, { type: 'accepted', traceId: msg.traceId, ...(parsed.clientMessageId ? { clientMessageId: parsed.clientMessageId } : {}) });
        this.handler?.(msg);
      }
    });

    ws.on('close', () => {
      if (registration) {
        const cid = this.conversationIdFor(registration);
        this.unregister(cid, registration);
      }
    });
  }

  private conversationIdFor(reg: ClientRegistration): string {
    return this.config.conversationId ?? `webchat:${reg.userId}`;
  }

  private isOwnerId(userId: string): boolean {
    if (!this.config.ownerIds || this.config.ownerIds.length === 0) return false;
    return this.config.ownerIds.includes(userId);
  }

  private register(conversationId: string, reg: ClientRegistration): void {
    const set = this.clients.get(conversationId) ?? new Set<ClientRegistration>();
    set.add(reg);
    this.clients.set(conversationId, set);
  }

  private unregister(conversationId: string, reg: ClientRegistration): void {
    const set = this.clients.get(conversationId);
    if (!set) return;
    set.delete(reg);
    if (set.size === 0) this.clients.delete(conversationId);
  }

  private buildStandardMessage(reg: ClientRegistration, text: string): StandardMessage {
    const cid = this.conversationIdFor(reg);
    const msg: StandardMessage = {
      id: generateMessageId(),
      traceId: generateTraceId(),
      timestamp: nowMs(),
      channel: { type: 'webchat', id: `port-${this.port}`, metadata: {} },
      sender: {
        id: reg.userId,
        isOwner: reg.isOwner,
      },
      conversation: { type: 'dm', id: cid },
      content: { type: 'text', text },
    };
    if (reg.displayName !== undefined) {
      msg.sender.displayName = reg.displayName;
    }
    return msg;
  }

  private broadcast(conversationId: string, env: BrowserOutbound): void {
    const set = this.clients.get(conversationId);
    if (!set) return;
    const raw = encodeBrowserOutbound(env);
    for (const c of set) {
      if (c.socket.readyState === c.socket.OPEN) c.socket.send(raw);
    }
  }

  private safeSend(ws: WebSocket, env: BrowserOutbound): void {
    if (ws.readyState === ws.OPEN) ws.send(encodeBrowserOutbound(env));
  }
}
