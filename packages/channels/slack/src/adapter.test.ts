import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { StandardMessage } from '@agent-platform/core';
import { SlackAdapter } from './adapter.js';
import type {
  SlackClient,
  SlackPostMessageParams,
  SlackPostMessageResult,
} from './slack-client.js';

class MockSlackClient implements SlackClient {
  public posts: SlackPostMessageParams[] = [];
  public closed = false;
  public nextResult: SlackPostMessageResult = { ok: true, ts: '1700000000.000001' };
  async postMessage(params: SlackPostMessageParams): Promise<SlackPostMessageResult> {
    this.posts.push(params);
    return this.nextResult;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

function sign(body: string, secret: string): { timestamp: string; signature: string } {
  const ts = String(Math.floor(Date.now() / 1000));
  const mac = createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
  return { timestamp: ts, signature: `v0=${mac}` };
}

describe('SlackAdapter', () => {
  let adapter: SlackAdapter;
  let client: MockSlackClient;

  beforeEach(async () => {
    client = new MockSlackClient();
    adapter = new SlackAdapter();
    await adapter.initialize({
      type: 'slack',
      client,
      credentials: {},
      signingSecret: 'test-sig',
      port: 0,
      ownerIds: ['U-owner'],
    });
  });

  afterEach(async () => {
    await adapter.shutdown();
  });

  it('starts and reports healthy', async () => {
    expect(adapter.listeningPort()).toBeGreaterThan(0);
    expect((await adapter.healthCheck()).healthy).toBe(true);
  });

  it('rejects unsigned Events API posts', async () => {
    const res = await fetch(`http://127.0.0.1:${adapter.listeningPort()}/`, {
      method: 'POST',
      body: JSON.stringify({ type: 'url_verification', challenge: 'x' }),
    });
    expect(res.status).toBe(401);
  });

  it('responds to Slack url_verification with the challenge', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'xyz' });
    const { timestamp, signature } = sign(body, 'test-sig');
    const res = await fetch(`http://127.0.0.1:${adapter.listeningPort()}/`, {
      method: 'POST',
      headers: {
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': signature,
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('xyz');
  });

  it('translates an event_callback message into StandardMessage', async () => {
    let got: StandardMessage | undefined;
    adapter.onMessage((m) => {
      got = m;
    });

    const payload = {
      type: 'event_callback' as const,
      event: {
        type: 'message' as const,
        user: 'U-owner',
        ts: '1700000100.000002',
        channel: 'D12345',
        channel_type: 'im' as const,
        text: '안녕 Slack',
      },
    };
    const body = JSON.stringify(payload);
    const { timestamp, signature } = sign(body, 'test-sig');
    await fetch(`http://127.0.0.1:${adapter.listeningPort()}/`, {
      method: 'POST',
      headers: {
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': signature,
        'content-type': 'application/json',
      },
      body,
    });

    // Event loop handoff — give the dispatch a moment.
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toBeDefined();
    expect(got!.channel.type).toBe('slack');
    expect(got!.conversation.type).toBe('dm');
    expect(got!.sender.isOwner).toBe(true);
  });

  it('ignores bot messages', async () => {
    let called = false;
    adapter.onMessage(() => {
      called = true;
    });
    adapter.injectEvent({
      type: 'event_callback',
      event: {
        type: 'message',
        bot_id: 'B123',
        ts: '1',
        channel: 'C1',
        text: 'hi',
      } as never,
    });
    expect(called).toBe(false);
  });

  it('sendMessage forwards text to the client', async () => {
    const res = await adapter.sendMessage('C-42', { type: 'text', text: 'hello' });
    expect(res.status).toBe('sent');
    expect(client.posts).toHaveLength(1);
    expect(client.posts[0]?.channel).toBe('C-42');
  });

  it('sendMessage reports failed for non-text content', async () => {
    const res = await adapter.sendMessage('C-42', {
      type: 'media',
      mimeType: 'image/png',
      url: 'https://x/y.png',
    });
    expect(res.status).toBe('failed');
  });

  it('sendMessage propagates Slack-side failure', async () => {
    client.nextResult = { ok: false, error: 'channel_not_found' };
    const res = await adapter.sendMessage('C-bad', { type: 'text', text: 'x' });
    expect(res.status).toBe('failed');
    expect(res.error).toContain('channel_not_found');
  });

  it('isAllowed enforces ownerIds', async () => {
    expect(await adapter.isAllowed('U-owner', 'dm')).toBe(true);
    expect(await adapter.isAllowed('U-stranger', 'dm')).toBe(false);
  });

  it('requires botToken or client at initialize', async () => {
    const a = new SlackAdapter();
    await expect(
      a.initialize({ type: 'slack', credentials: {}, signingSecret: 'x', port: 0 } as never),
    ).rejects.toThrow(/botToken.*client/);
  });
});
