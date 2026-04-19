import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { StandardMessage } from '@agent-platform/core';
import { DiscordAdapter } from './adapter.js';
import type {
  DiscordClient,
  DiscordCreateMessageParams,
  DiscordMessage,
} from './discord-client.js';

class MockDiscordClient implements DiscordClient {
  public sent: DiscordCreateMessageParams[] = [];
  public shouldFail = false;
  public closed = false;
  async createMessage(params: DiscordCreateMessageParams): Promise<DiscordMessage> {
    if (this.shouldFail) throw new Error('API 403 Forbidden');
    this.sent.push(params);
    return {
      id: `m-${this.sent.length}`,
      channel_id: params.channelId,
      author: { id: 'bot', username: 'agent', bot: true },
      content: params.content,
      timestamp: new Date().toISOString(),
    };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

function makeMessage(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: '101',
    channel_id: 'C-1',
    author: { id: 'U-1', username: 'alice' },
    content: 'hi',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('DiscordAdapter', () => {
  let client: MockDiscordClient;
  let adapter: DiscordAdapter;

  beforeEach(async () => {
    client = new MockDiscordClient();
    adapter = new DiscordAdapter();
    await adapter.initialize({
      type: 'discord',
      client,
      credentials: {},
      ownerIds: ['U-owner'],
    });
  });

  afterEach(async () => {
    await adapter.shutdown();
  });

  it('requires botToken or client', async () => {
    const a = new DiscordAdapter();
    await expect(a.initialize({ type: 'discord', credentials: {} })).rejects.toThrow(
      /botToken.*client/,
    );
  });

  it('translates a DM message into StandardMessage with isOwner=true', async () => {
    let got: StandardMessage | undefined;
    adapter.onMessage((m) => {
      got = m;
    });
    adapter.injectMessage(makeMessage({ author: { id: 'U-owner', username: 'boss' } }), true);
    expect(got).toBeDefined();
    expect(got!.channel.type).toBe('discord');
    expect(got!.conversation.type).toBe('dm');
    expect(got!.sender.isOwner).toBe(true);
  });

  it('guild messages never have isOwner=true', async () => {
    let got: StandardMessage | undefined;
    adapter.onMessage((m) => {
      got = m;
    });
    adapter.injectMessage(makeMessage({ author: { id: 'U-owner', username: 'boss' } }), false);
    expect(got!.sender.isOwner).toBe(false);
    expect(got!.conversation.type).toBe('group');
  });

  it('ignores bot-authored messages', async () => {
    let called = false;
    adapter.onMessage(() => {
      called = true;
    });
    adapter.injectMessage(
      makeMessage({ author: { id: 'B-1', username: 'bot', bot: true } }),
      true,
    );
    expect(called).toBe(false);
  });

  it('sendMessage forwards text', async () => {
    const res = await adapter.sendMessage('C-42', { type: 'text', text: 'hello' });
    expect(res.status).toBe('sent');
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]?.content).toBe('hello');
  });

  it('sendMessage reports failed on client error', async () => {
    client.shouldFail = true;
    const res = await adapter.sendMessage('C-42', { type: 'text', text: 'hi' });
    expect(res.status).toBe('failed');
    expect(res.error).toContain('403');
  });

  it('sendMessage rejects non-text content', async () => {
    const res = await adapter.sendMessage('C-42', {
      type: 'media',
      mimeType: 'image/png',
      url: 'https://x/y.png',
    });
    expect(res.status).toBe('failed');
  });

  it('isAllowed enforces ownerIds', async () => {
    expect(await adapter.isAllowed('U-owner', 'dm')).toBe(true);
    expect(await adapter.isAllowed('U-random', 'dm')).toBe(false);
  });

  it('shutdown closes the client', async () => {
    expect(client.closed).toBe(false);
    await adapter.shutdown();
    expect(client.closed).toBe(true);
  });
});
