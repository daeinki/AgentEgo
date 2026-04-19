import type { Contracts, OutboundContent, StandardMessage } from '@agent-platform/core';
import { generateMessageId, generateTraceId, nowMs } from '@agent-platform/core';
import type { DiscordClient, DiscordMessage } from './discord-client.js';
import { HttpDiscordClient } from './discord-client.js';

type ChannelAdapter = Contracts.ChannelAdapter;
type ChannelConfig = Contracts.ChannelConfig;
type HealthStatus = Contracts.HealthStatus;
type SendResult = Contracts.SendResult;

export interface DiscordConfig extends ChannelConfig {
  type: 'discord';
  botToken?: string;
  client?: DiscordClient;
  ownerIds?: string[];
}

/**
 * Discord channel adapter. Inbound messages arrive via `injectMessage()` —
 * the caller wires this up either to a Gateway WebSocket client (future) or
 * to an Interactions webhook layer. This keeps the adapter focused on the
 * translation layer.
 */
export class DiscordAdapter implements ChannelAdapter {
  private config!: DiscordConfig;
  private client!: DiscordClient;
  private handler?: (msg: StandardMessage) => void;
  private running = false;

  async initialize(config: ChannelConfig): Promise<void> {
    if (config['type'] !== 'discord') throw new Error('DiscordAdapter expects type=discord');
    this.config = config as DiscordConfig;
    if (this.config.client) {
      this.client = this.config.client;
    } else if (this.config.botToken) {
      this.client = new HttpDiscordClient(this.config.botToken);
    } else {
      throw new Error('DiscordAdapter requires either `botToken` or `client`');
    }
    this.running = true;
  }

  async shutdown(): Promise<void> {
    this.running = false;
    await this.client.close();
  }

  async healthCheck(): Promise<HealthStatus> {
    return { healthy: this.running, lastCheckedAt: nowMs() };
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
    try {
      const res = await this.client.createMessage({
        channelId: conversationId,
        content: content.text,
      });
      return { messageId: res.id, sentAt: nowMs(), status: 'sent' };
    } catch (err) {
      return {
        messageId: generateMessageId(),
        sentAt: nowMs(),
        status: 'failed',
        error: (err as Error).message,
      };
    }
  }

  async sendTypingIndicator(_conversationId: string, _isTyping: boolean): Promise<void> {
    // Supported via POST /channels/{id}/typing but not wired here — Discord
    // auto-expires the indicator after 10s, and keeping this lean avoids a
    // fire-and-forget failure path.
  }

  async isAllowed(senderId: string, _conversationType: string): Promise<boolean> {
    if (!this.config.ownerIds || this.config.ownerIds.length === 0) return true;
    return this.config.ownerIds.includes(senderId);
  }

  /**
   * Test + wiring entry-point. A future Gateway client would call this for
   * every MESSAGE_CREATE event it receives.
   */
  injectMessage(raw: DiscordMessage, isDm = false): void {
    if (raw.author.bot) return;
    const isOwner = this.isOwnerId(raw.author.id) && isDm;
    const msg: StandardMessage = {
      id: raw.id,
      traceId: generateTraceId(),
      timestamp: Date.parse(raw.timestamp) || nowMs(),
      channel: {
        type: 'discord',
        id: 'discord',
        metadata: { channelType: isDm ? 'dm' : 'guild' },
      },
      sender: {
        id: raw.author.id,
        isOwner,
        displayName: raw.author.username,
      },
      conversation: {
        type: isDm ? 'dm' : 'group',
        id: raw.channel_id,
      },
      content: { type: 'text', text: raw.content },
    };
    this.handler?.(msg);
  }

  private isOwnerId(id: string): boolean {
    if (!this.config.ownerIds || this.config.ownerIds.length === 0) return false;
    return this.config.ownerIds.includes(id);
  }
}
