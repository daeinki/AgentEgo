/**
 * Minimal Telegram Bot API client using `fetch`. No third-party runtime deps.
 *
 * Scope:
 * - `getUpdates` (long-polling)
 * - `sendMessage`
 * - `sendChatAction` (typing indicators)
 *
 * Full Telegram Bot API surface is enormous; this is the subset the adapter
 * actually uses. Add more methods here as the adapter grows.
 */

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number }>;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface SendMessageParams {
  chat_id: number;
  text: string;
  reply_to_message_id?: number;
}

export interface TelegramClient {
  getUpdates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]>;
  sendMessage(params: SendMessageParams): Promise<TelegramMessage>;
  sendChatAction(chatId: number, action: 'typing'): Promise<void>;
  close(): Promise<void>;
}

export class HttpTelegramClient implements TelegramClient {
  private readonly base: string;
  private abortController?: AbortController;

  constructor(token: string, baseUrl = 'https://api.telegram.org') {
    this.base = `${baseUrl.replace(/\/$/, '')}/bot${token}`;
  }

  async getUpdates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]> {
    this.abortController = new AbortController();
    const res = await this.callApi<TelegramUpdate[]>('getUpdates', {
      offset,
      timeout: timeoutSec,
      allowed_updates: ['message', 'edited_message'],
    });
    return res ?? [];
  }

  async sendMessage(params: SendMessageParams): Promise<TelegramMessage> {
    const result = await this.callApi<TelegramMessage>('sendMessage', { ...params });
    if (!result) throw new Error('sendMessage returned empty result');
    return result;
  }

  async sendChatAction(chatId: number, action: 'typing'): Promise<void> {
    await this.callApi('sendChatAction', { chat_id: chatId, action });
  }

  async close(): Promise<void> {
    this.abortController?.abort();
  }

  private async callApi<T>(method: string, body: Record<string, unknown>): Promise<T | null> {
    const response = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: this.abortController?.signal,
    });
    if (!response.ok) {
      throw new Error(`Telegram API ${method} failed: HTTP ${response.status} ${response.statusText}`);
    }
    const json = (await response.json()) as { ok: boolean; result?: T; description?: string };
    if (!json.ok) {
      throw new Error(`Telegram API ${method} error: ${json.description ?? 'unknown'}`);
    }
    return json.result ?? null;
  }
}
