import type { Contracts, OutboundContent, StandardMessage } from '@agent-platform/core';
import { generateMessageId, generateTraceId, nowMs } from '@agent-platform/core';
import type { TelegramClient, TelegramMessage, TelegramUpdate } from './telegram-client.js';
import { HttpTelegramClient } from './telegram-client.js';

type ChannelAdapter = Contracts.ChannelAdapter;
type ChannelConfig = Contracts.ChannelConfig;
type HealthStatus = Contracts.HealthStatus;
type SendResult = Contracts.SendResult;

export interface TelegramConfig extends ChannelConfig {
  type: 'telegram';
  /**
   * Bot API token (from BotFather). Used when no `client` is supplied.
   */
  token?: string;
  /**
   * Pre-built client — useful for tests and for advanced users who want to
   * route through a proxy or mock.
   */
  client?: TelegramClient;
  /**
   * Long-poll timeout in seconds (Telegram default 30, max 50). Tests should
   * use 0 to avoid hanging.
   */
  pollTimeoutSec?: number;
  /**
   * If true, the adapter won't start the polling loop in `initialize` — tests
   * drive updates manually via `injectUpdate`.
   */
  disablePolling?: boolean;
  /**
   * Allowed user IDs. First identified user becomes owner. If omitted, any
   * sender is allowed.
   */
  ownerIds?: number[];
}

/**
 * Telegram channel adapter (long-polling).
 *
 * - Translates Telegram updates → StandardMessage
 * - Uses chat.id as the conversation id (string-coerced)
 * - For groups, isOwner is false even if the user is in ownerIds (per spec's
 *   channel.sender.isOwner semantics = system-owner, not chat-owner)
 */
export class TelegramAdapter implements ChannelAdapter {
  private config!: TelegramConfig;
  private client!: TelegramClient;
  private handler?: (msg: StandardMessage) => void;
  private pollAbortController?: AbortController;
  private pollLoop?: Promise<void>;
  private nextOffset = 0;
  private running = false;

  async initialize(config: ChannelConfig): Promise<void> {
    if (config['type'] !== 'telegram') throw new Error('TelegramAdapter expects type=telegram');
    this.config = config as TelegramConfig;
    if (this.config.client) {
      this.client = this.config.client;
    } else if (this.config.token) {
      this.client = new HttpTelegramClient(this.config.token);
    } else {
      throw new Error('TelegramAdapter requires either `token` or `client`');
    }
    this.running = true;

    if (!this.config.disablePolling) {
      this.pollAbortController = new AbortController();
      this.pollLoop = this.pollForever(this.pollAbortController.signal).catch(() => {
        // swallow — shutdown will set running=false
      });
    }
  }

  async shutdown(): Promise<void> {
    this.running = false;
    this.pollAbortController?.abort();
    await this.client.close();
    if (this.pollLoop) {
      await this.pollLoop;
    }
  }

  async healthCheck(): Promise<HealthStatus> {
    return {
      healthy: this.running,
      lastCheckedAt: nowMs(),
      message: `polling=${!this.config.disablePolling}`,
    };
  }

  onMessage(handler: (msg: StandardMessage) => void): void {
    this.handler = handler;
  }

  async sendMessage(conversationId: string, content: OutboundContent): Promise<SendResult> {
    const chatId = Number(conversationId);
    if (!Number.isFinite(chatId)) {
      return {
        messageId: generateMessageId(),
        sentAt: nowMs(),
        status: 'failed',
        error: `invalid conversation id: ${conversationId}`,
      };
    }
    try {
      if (content.type === 'text') {
        const tg = await this.client.sendMessage({ chat_id: chatId, text: content.text });
        return {
          messageId: String(tg.message_id),
          sentAt: tg.date * 1000,
          status: 'sent',
        };
      }
      return {
        messageId: generateMessageId(),
        sentAt: nowMs(),
        status: 'failed',
        error: `unsupported content type: ${content.type}`,
      };
    } catch (err) {
      return {
        messageId: generateMessageId(),
        sentAt: nowMs(),
        status: 'failed',
        error: (err as Error).message,
      };
    }
  }

  async sendTypingIndicator(conversationId: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    const chatId = Number(conversationId);
    if (!Number.isFinite(chatId)) return;
    await this.client.sendChatAction(chatId, 'typing');
  }

  async isAllowed(senderId: string, _conversationType: string): Promise<boolean> {
    if (!this.config.ownerIds || this.config.ownerIds.length === 0) return true;
    const id = Number(senderId);
    return this.config.ownerIds.includes(id);
  }

  /**
   * Feed a pre-built Telegram update into the adapter (test entry point).
   */
  injectUpdate(update: TelegramUpdate): void {
    this.dispatchUpdate(update);
  }

  private async pollForever(signal: AbortSignal): Promise<void> {
    const timeoutSec = this.config.pollTimeoutSec ?? 30;
    while (this.running && !signal.aborted) {
      try {
        const updates = await this.client.getUpdates(this.nextOffset, timeoutSec);
        for (const update of updates) {
          this.dispatchUpdate(update);
        }
      } catch (err) {
        if (signal.aborted) return;
        // Back off a bit so a persistent failure doesn't hot-loop the API.
        await sleep(1000);
        void err;
      }
    }
  }

  private dispatchUpdate(update: TelegramUpdate): void {
    this.nextOffset = Math.max(this.nextOffset, update.update_id + 1);
    const tgMsg = update.message ?? update.edited_message;
    if (!tgMsg) return;
    const standard = this.toStandardMessage(tgMsg);
    if (!standard) return;
    this.handler?.(standard);
  }

  private toStandardMessage(tgMsg: TelegramMessage): StandardMessage | null {
    const text = tgMsg.text ?? tgMsg.caption ?? '';
    if (!text) return null;
    if (!tgMsg.from) return null;

    const conversationId = String(tgMsg.chat.id);
    const isOwner = this.isOwnerId(tgMsg.from.id) && tgMsg.chat.type === 'private';

    const msg: StandardMessage = {
      id: String(tgMsg.message_id),
      traceId: generateTraceId(),
      timestamp: tgMsg.date * 1000,
      channel: {
        type: 'telegram',
        id: 'telegram',
        metadata: { chatType: tgMsg.chat.type },
      },
      sender: {
        id: String(tgMsg.from.id),
        isOwner,
      },
      conversation: {
        type: tgMsg.chat.type === 'private' ? 'dm' : 'group',
        id: conversationId,
      },
      content: { type: 'text', text },
    };
    if (tgMsg.from.username) msg.sender.displayName = tgMsg.from.username;
    else msg.sender.displayName = tgMsg.from.first_name;
    if (tgMsg.chat.title) msg.conversation.title = tgMsg.chat.title;
    return msg;
  }

  private isOwnerId(id: number): boolean {
    if (!this.config.ownerIds || this.config.ownerIds.length === 0) return false;
    return this.config.ownerIds.includes(id);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
