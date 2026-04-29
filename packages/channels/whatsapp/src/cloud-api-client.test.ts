import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  CloudApiWhatsAppClient,
  translateCloudApiMessage,
} from './cloud-api-client.js';
import type { WhatsAppMessage } from './whatsapp-client.js';

function sign(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

describe('translateCloudApiMessage', () => {
  it('translates a text message', () => {
    const m = translateCloudApiMessage({
      from: '821012345678',
      id: 'wamid.123',
      timestamp: '1700000000',
      type: 'text',
      text: { body: 'hi cloud' },
    });
    expect(m).toEqual<WhatsAppMessage>({
      id: 'wamid.123',
      from: '821012345678',
      chatId: '821012345678',
      isGroup: false,
      timestamp: 1700000000,
      text: 'hi cloud',
      fromMe: false,
    });
  });

  it('translates an image with caption', () => {
    const m = translateCloudApiMessage({
      from: '821012345678',
      id: 'wamid.456',
      timestamp: '1700000100',
      type: 'image',
      image: { caption: 'a photo' },
    });
    expect(m?.mediaCaption).toBe('a photo');
    expect(m?.text).toBeUndefined();
  });

  it('translates an interactive button reply', () => {
    const m = translateCloudApiMessage({
      from: '8210',
      id: 'wamid.7',
      timestamp: '1700000200',
      type: 'interactive',
      interactive: { button_reply: { id: 'b1', title: 'Yes' } },
    });
    expect(m?.text).toBe('Yes');
  });

  it('returns null for empty/unsupported types', () => {
    expect(
      translateCloudApiMessage({
        from: '8210',
        id: 'wamid.x',
        timestamp: '1700000300',
        type: 'reaction',
        reaction: { emoji: '👍' },
      }),
    ).toBeNull();
  });
});

describe('CloudApiWhatsAppClient — webhook server', () => {
  let client: CloudApiWhatsAppClient;
  let received: WhatsAppMessage[] = [];

  beforeEach(async () => {
    received = [];
    client = new CloudApiWhatsAppClient({
      phoneNumberId: '12345',
      accessToken: 'token',
      appSecret: 'secret',
      verifyToken: 'verifyme',
      port: 0,
    });
    await client.listen((m) => received.push(m));
  });

  afterEach(async () => {
    await client.close();
  });

  it('GET /?hub.mode=subscribe with matching token echoes the challenge', async () => {
    const url = `http://127.0.0.1:${client.listeningPort()}/?hub.mode=subscribe&hub.verify_token=verifyme&hub.challenge=42`;
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('42');
  });

  it('GET with wrong verify_token returns 403', async () => {
    const url = `http://127.0.0.1:${client.listeningPort()}/?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42`;
    const res = await fetch(url);
    expect(res.status).toBe(403);
  });

  it('POST without signature returns 401', async () => {
    const res = await fetch(`http://127.0.0.1:${client.listeningPort()}/`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('POST with bad signature returns 401', async () => {
    const res = await fetch(`http://127.0.0.1:${client.listeningPort()}/`, {
      method: 'POST',
      headers: { 'x-hub-signature-256': 'sha256=deadbeef' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('POST with valid HMAC dispatches messages', async () => {
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'wba-1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '12345' },
                messages: [
                  {
                    from: '821011112222',
                    id: 'wamid.A',
                    timestamp: '1700001000',
                    type: 'text',
                    text: { body: 'hello cloud' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const signature = sign(body, 'secret');
    const res = await fetch(`http://127.0.0.1:${client.listeningPort()}/`, {
      method: 'POST',
      headers: {
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      body,
    });
    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.text).toBe('hello cloud');
    expect(received[0]?.from).toBe('821011112222');
  });

  it('ignores webhooks for non-message fields (statuses)', async () => {
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'statuses',
              value: { statuses: [{ status: 'delivered' }] },
            },
          ],
        },
      ],
    });
    const signature = sign(body, 'secret');
    await fetch(`http://127.0.0.1:${client.listeningPort()}/`, {
      method: 'POST',
      headers: {
        'x-hub-signature-256': signature,
        'content-type': 'application/json',
      },
      body,
    });
    expect(received).toHaveLength(0);
  });

  it('injectWebhook bypasses signature check', () => {
    client.injectWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    from: '8210',
                    id: 'wamid.B',
                    timestamp: '1700001500',
                    type: 'text',
                    text: { body: 'injected' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.text).toBe('injected');
  });
});

describe('CloudApiWhatsAppClient — outbound sendText', () => {
  let originalFetch: typeof fetch;
  let calls: { url: string; init?: RequestInit }[] = [];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('POSTs to graph.facebook.com with bearer auth and returns the message id', async () => {
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.OUT' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const c = new CloudApiWhatsAppClient({
      phoneNumberId: '12345',
      accessToken: 'token-abc',
      appSecret: 'secret',
      verifyToken: 'v',
      port: 0,
      apiBase: 'https://graph.test/v20.0',
    });
    const res = await c.sendText({ chatId: '+821011112222@s.whatsapp.net', text: 'hi' });
    expect(res.id).toBe('wamid.OUT');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://graph.test/v20.0/12345/messages');
    const body = JSON.parse((calls[0]?.init?.body as string) ?? '{}') as Record<string, unknown>;
    expect(body['to']).toBe('821011112222');
    expect(body['type']).toBe('text');
    expect((body['text'] as { body: string }).body).toBe('hi');
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer token-abc');
  });

  it('throws on Graph API error response', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: 'invalid token' } }), {
          status: 401,
        }),
    ) as unknown as typeof fetch;

    const c = new CloudApiWhatsAppClient({
      phoneNumberId: '12345',
      accessToken: 't',
      appSecret: 's',
      verifyToken: 'v',
      port: 0,
    });
    await expect(c.sendText({ chatId: '8210', text: 'x' })).rejects.toThrow(/HTTP 401/);
  });
});
