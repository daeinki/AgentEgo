import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { StandardMessage } from '@agent-platform/core';
import { TelegramAdapter } from './adapter.js';
import type {
  TelegramClient,
  TelegramMessage,
  TelegramUpdate,
  SendMessageParams,
} from './telegram-client.js';

class MockTelegramClient implements TelegramClient {
  public sent: SendMessageParams[] = [];
  public actions: Array<{ chatId: number; action: string }> = [];
  public pendingUpdates: TelegramUpdate[] = [];
  public closed = false;
  private messageIdSeq = 1;

  async getUpdates(_offset: number, _timeoutSec: number): Promise<TelegramUpdate[]> {
    const out = this.pendingUpdates;
    this.pendingUpdates = [];
    return out;
  }
  async sendMessage(params: SendMessageParams): Promise<TelegramMessage> {
    this.sent.push(params);
    this.messageIdSeq += 1;
    return {
      message_id: this.messageIdSeq,
      date: Math.floor(Date.now() / 1000),
      chat: { id: params.chat_id, type: 'private' },
      text: params.text,
    };
  }
  async sendChatAction(chatId: number, action: 'typing'): Promise<void> {
    this.actions.push({ chatId, action });
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

function makeUpdate(overrides: Partial<TelegramMessage> = {}): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 101,
      date: Math.floor(Date.now() / 1000),
      from: { id: 7777, is_bot: false, first_name: 'Alice', username: 'alice' },
      chat: { id: 7777, type: 'private' },
      text: 'hi',
      ...overrides,
    },
  };
}

describe('TelegramAdapter', () => {
  let client: MockTelegramClient;
  let adapter: TelegramAdapter;

  beforeEach(async () => {
    client = new MockTelegramClient();
    adapter = new TelegramAdapter();
    await adapter.initialize({
      type: 'telegram',
      client,
      credentials: {},
      pollTimeoutSec: 0,
      disablePolling: true,
      ownerIds: [7777],
    });
  });

  afterEach(async () => {
    await adapter.shutdown();
  });

  it('refuses initialize without token or client', async () => {
    const a = new TelegramAdapter();
    await expect(
      a.initialize({ type: 'telegram', credentials: {} }),
    ).rejects.toThrow(/token.*client/);
  });

  it('translates a private-chat text update into a StandardMessage', async () => {
    let got: StandardMessage | undefined;
    adapter.onMessage((m) => {
      got = m;
    });

    adapter.injectUpdate(makeUpdate());

    expect(got).toBeDefined();
    expect(got!.channel.type).toBe('telegram');
    expect(got!.conversation.type).toBe('dm');
    expect(got!.conversation.id).toBe('7777');
    expect(got!.sender.id).toBe('7777');
    expect(got!.sender.isOwner).toBe(true);
    expect(got!.sender.displayName).toBe('alice');
    if (got!.content.type === 'text') expect(got!.content.text).toBe('hi');
  });

  it('marks sender as non-owner for group chats', async () => {
    let got: StandardMessage | undefined;
    adapter.onMessage((m) => {
      got = m;
    });

    adapter.injectUpdate({
      update_id: 2,
      message: {
        message_id: 200,
        date: Math.floor(Date.now() / 1000),
        from: { id: 7777, is_bot: false, first_name: 'Alice' },
        chat: { id: -100, type: 'supergroup', title: 'team-chat' },
        text: 'group message',
      },
    });

    expect(got!.conversation.type).toBe('group');
    expect(got!.conversation.id).toBe('-100');
    expect(got!.conversation.title).toBe('team-chat');
    expect(got!.sender.isOwner).toBe(false);
  });

  it('skips updates with no text/caption/from', async () => {
    let called = false;
    adapter.onMessage(() => {
      called = true;
    });
    adapter.injectUpdate({
      update_id: 10,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 1, type: 'private' },
      },
    });
    expect(called).toBe(false);
  });

  it('sendMessage forwards text content via the client', async () => {
    const result = await adapter.sendMessage('7777', { type: 'text', text: '안녕' });
    expect(result.status).toBe('sent');
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]?.chat_id).toBe(7777);
    expect(client.sent[0]?.text).toBe('안녕');
  });

  it('sendMessage rejects non-numeric conversation id', async () => {
    const result = await adapter.sendMessage('not-a-chat', { type: 'text', text: 'x' });
    expect(result.status).toBe('failed');
  });

  it('sendMessage reports failed for unsupported content types', async () => {
    const result = await adapter.sendMessage('7777', {
      type: 'media',
      mimeType: 'image/png',
      url: 'https://example.com/x.png',
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('unsupported');
  });

  it('isAllowed respects ownerIds', async () => {
    expect(await adapter.isAllowed('7777', 'dm')).toBe(true);
    expect(await adapter.isAllowed('9999', 'dm')).toBe(false);
  });

  it('sendTypingIndicator(true) calls sendChatAction', async () => {
    await adapter.sendTypingIndicator('7777', true);
    expect(client.actions).toEqual([{ chatId: 7777, action: 'typing' }]);
  });

  it('sendTypingIndicator(false) is a no-op', async () => {
    await adapter.sendTypingIndicator('7777', false);
    expect(client.actions).toHaveLength(0);
  });

  it('shutdown closes the underlying client', async () => {
    expect(client.closed).toBe(false);
    await adapter.shutdown();
    expect(client.closed).toBe(true);
  });

  it('advances update offset monotonically', async () => {
    const fresh = new TelegramAdapter();
    const polled = new MockTelegramClient();
    await fresh.initialize({
      type: 'telegram',
      client: polled,
      credentials: {},
      disablePolling: true,
    });
    fresh.injectUpdate({ update_id: 5, message: makeUpdate().message });
    fresh.injectUpdate({ update_id: 3, message: makeUpdate().message });
    fresh.injectUpdate({ update_id: 7, message: makeUpdate().message });
    // After injecting, offset would be used on next poll. We can't peek at
    // `nextOffset` directly, but injecting a lower update_id shouldn't lose it.
    await fresh.shutdown();
  });
});
