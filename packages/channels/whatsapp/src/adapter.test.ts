import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { StandardMessage } from '@agent-platform/core';
import { WhatsAppAdapter } from './adapter.js';
import type {
  WhatsAppClient,
  WhatsAppMessage,
  WhatsAppSendParams,
} from './whatsapp-client.js';

class MockWhatsAppClient implements WhatsAppClient {
  private onMessage?: (m: WhatsAppMessage) => void;
  public sent: WhatsAppSendParams[] = [];
  public closed = false;
  public shouldFail = false;
  async listen(on: (m: WhatsAppMessage) => void): Promise<void> {
    this.onMessage = on;
  }
  emit(m: WhatsAppMessage): void {
    this.onMessage?.(m);
  }
  async sendText(params: WhatsAppSendParams): Promise<{ id: string; timestamp: number }> {
    if (this.shouldFail) throw new Error('network down');
    this.sent.push(params);
    return { id: `wa-${this.sent.length}`, timestamp: Math.floor(Date.now() / 1000) };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

function makeRaw(overrides: Partial<WhatsAppMessage> = {}): WhatsAppMessage {
  return {
    id: 'wa-inbound-1',
    from: '821012345678@s.whatsapp.net',
    chatId: '821012345678@s.whatsapp.net',
    isGroup: false,
    timestamp: Math.floor(Date.now() / 1000),
    text: 'hi',
    fromMe: false,
    ...overrides,
  };
}

describe('WhatsAppAdapter', () => {
  let client: MockWhatsAppClient;
  let adapter: WhatsAppAdapter;

  beforeEach(async () => {
    client = new MockWhatsAppClient();
    adapter = new WhatsAppAdapter();
    await adapter.initialize({
      type: 'whatsapp',
      client,
      credentials: {},
      ownerIds: ['821012345678'],
    });
  });

  afterEach(async () => {
    await adapter.shutdown();
  });

  it('wires listen on initialize', async () => {
    let got: StandardMessage | undefined;
    adapter.onMessage((m) => {
      got = m;
    });
    client.emit(makeRaw());
    expect(got).toBeDefined();
    expect(got!.channel.type).toBe('whatsapp');
  });

  it('private chat with owner sender → isOwner=true', async () => {
    let got: StandardMessage | undefined;
    adapter.onMessage((m) => {
      got = m;
    });
    client.emit(makeRaw());
    expect(got!.sender.isOwner).toBe(true);
    expect(got!.conversation.type).toBe('dm');
  });

  it('group chat is never isOwner=true', async () => {
    let got: StandardMessage | undefined;
    adapter.onMessage((m) => {
      got = m;
    });
    client.emit(
      makeRaw({ isGroup: true, chatId: '123-1700000000@g.us' }),
    );
    expect(got!.sender.isOwner).toBe(false);
    expect(got!.conversation.type).toBe('group');
  });

  it('fromMe messages are ignored', async () => {
    let called = false;
    adapter.onMessage(() => {
      called = true;
    });
    client.emit(makeRaw({ fromMe: true }));
    expect(called).toBe(false);
  });

  it('empty-text messages are ignored', async () => {
    let called = false;
    adapter.onMessage(() => {
      called = true;
    });
    client.emit(makeRaw({ text: '', mediaCaption: '' }));
    expect(called).toBe(false);
  });

  it('sendMessage forwards text', async () => {
    const res = await adapter.sendMessage('821099999999@s.whatsapp.net', {
      type: 'text',
      text: 'hi there',
    });
    expect(res.status).toBe('sent');
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]?.text).toBe('hi there');
  });

  it('sendMessage reports failure on client error', async () => {
    client.shouldFail = true;
    const res = await adapter.sendMessage('chat', { type: 'text', text: 'x' });
    expect(res.status).toBe('failed');
  });

  it('isAllowed normalizes JIDs and + prefixes', async () => {
    expect(await adapter.isAllowed('+821012345678', 'dm')).toBe(true);
    expect(await adapter.isAllowed('821012345678@s.whatsapp.net', 'dm')).toBe(true);
    expect(await adapter.isAllowed('821099999999', 'dm')).toBe(false);
  });

  it('shutdown closes the underlying client', async () => {
    expect(client.closed).toBe(false);
    await adapter.shutdown();
    expect(client.closed).toBe(true);
  });
});
