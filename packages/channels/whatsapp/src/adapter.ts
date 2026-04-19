import type { Contracts, OutboundContent, StandardMessage } from '@agent-platform/core';
import { generateMessageId, generateTraceId, nowMs } from '@agent-platform/core';
import type { WhatsAppClient, WhatsAppMessage } from './whatsapp-client.js';

type ChannelAdapter = Contracts.ChannelAdapter;
type ChannelConfig = Contracts.ChannelConfig;
type HealthStatus = Contracts.HealthStatus;
type SendResult = Contracts.SendResult;

export interface WhatsAppConfig extends ChannelConfig {
  type: 'whatsapp';
  /**
   * Required — WhatsApp's auth/transport is too varied to pick a default.
   * Pass in a baileys-backed client, a Cloud-API client, or a test mock.
   */
  client: WhatsAppClient;
  /**
   * Owner phone numbers (JIDs without the @s.whatsapp.net suffix, or full JIDs).
   */
  ownerIds?: string[];
}

/**
 * WhatsApp channel adapter. Delegates transport to a `WhatsAppClient` so the
 * runtime stays free of the heavy baileys / Cloud-API SDKs.
 */
export class WhatsAppAdapter implements ChannelAdapter {
  private config!: WhatsAppConfig;
  private handler?: (msg: StandardMessage) => void;
  private listening = false;

  async initialize(config: ChannelConfig): Promise<void> {
    if (config['type'] !== 'whatsapp') throw new Error('WhatsAppAdapter expects type=whatsapp');
    this.config = config as WhatsAppConfig;
    await this.config.client.listen((raw) => this.dispatchInbound(raw));
    this.listening = true;
  }

  async shutdown(): Promise<void> {
    this.listening = false;
    await this.config.client.close();
  }

  async healthCheck(): Promise<HealthStatus> {
    return { healthy: this.listening, lastCheckedAt: nowMs() };
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
      const res = await this.config.client.sendText({
        chatId: conversationId,
        text: content.text,
      });
      return { messageId: res.id, sentAt: res.timestamp * 1000, status: 'sent' };
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
    // baileys supports `sendPresenceUpdate('composing', jid)` but the Cloud
    // API does not. Keep this adapter transport-agnostic and no-op.
  }

  async isAllowed(senderId: string, _conversationType: string): Promise<boolean> {
    if (!this.config.ownerIds || this.config.ownerIds.length === 0) return true;
    // senderId may arrive as raw number or full JID; normalize both.
    const normalized = normalizeJid(senderId);
    return this.config.ownerIds.map(normalizeJid).includes(normalized);
  }

  private dispatchInbound(raw: WhatsAppMessage): void {
    if (raw.fromMe) return;
    const text = raw.text ?? raw.mediaCaption ?? '';
    if (!text) return;
    const isOwner = this.isOwnerId(raw.from) && !raw.isGroup;
    const msg: StandardMessage = {
      id: raw.id,
      traceId: generateTraceId(),
      timestamp: raw.timestamp * 1000,
      channel: {
        type: 'whatsapp',
        id: 'whatsapp',
        metadata: { isGroup: raw.isGroup },
      },
      sender: {
        id: raw.from,
        isOwner,
      },
      conversation: {
        type: raw.isGroup ? 'group' : 'dm',
        id: raw.chatId,
      },
      content: { type: 'text', text },
    };
    this.handler?.(msg);
  }

  private isOwnerId(id: string): boolean {
    if (!this.config.ownerIds || this.config.ownerIds.length === 0) return false;
    const normalized = normalizeJid(id);
    return this.config.ownerIds.map(normalizeJid).includes(normalized);
  }
}

function normalizeJid(s: string): string {
  // Strip any suffix after `@` and any leading `+`.
  const at = s.indexOf('@');
  const base = at >= 0 ? s.slice(0, at) : s;
  return base.replace(/^\+/, '');
}
