import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type {
  WhatsAppClient,
  WhatsAppMessage,
  WhatsAppSendParams,
} from './whatsapp-client.js';

/**
 * WhatsApp Cloud API (Meta-hosted) client. Different transport from baileys —
 * outbound goes through Graph API, inbound arrives via a webhook HTTP server
 * that this client owns. Auth model:
 *
 * - `accessToken`: short- or long-lived Graph token (Bearer) for outbound.
 * - `appSecret`: WhatsApp Business app secret; used to verify the
 *   `X-Hub-Signature-256` HMAC on every inbound POST.
 * - `verifyToken`: free-form string Meta echoes back during webhook
 *   subscription via `hub.verify_token` query param on GET.
 *
 * The webhook payload schema and HMAC scheme are documented at
 * https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 *
 * Group chats are not surfaced by the Cloud API — all inbound messages are
 * DMs, so `isGroup` is always false on this transport.
 */

export interface CloudApiOptions {
  /** Phone-Number ID issued by Meta (the integer string in graph URLs). */
  phoneNumberId: string;
  /** Graph API bearer token. */
  accessToken: string;
  /** App secret used for HMAC signature verification. */
  appSecret: string;
  /** Verify token echoed on subscription GET. */
  verifyToken: string;
  /** HTTP port for the webhook server. 0 = OS-assigned. */
  port: number;
  /** Webhook URL path (default `/`). */
  path?: string;
  /** Override Graph API base (tests). Default `https://graph.facebook.com/v20.0`. */
  apiBase?: string;
  /** Reject requests where the `X-Hub-Signature-256` header is missing (default true). */
  requireSignature?: boolean;
}

interface CloudApiInboundEvent {
  object?: string;
  entry?: Array<{
    id?: string;
    changes?: Array<{
      value?: CloudApiChangeValue;
      field?: string;
    }>;
  }>;
}

interface CloudApiChangeValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  messages?: CloudApiMessage[];
  statuses?: unknown[];
}

interface CloudApiMessage {
  from: string;
  id: string;
  timestamp: string;
  type:
    | 'text'
    | 'image'
    | 'video'
    | 'audio'
    | 'document'
    | 'sticker'
    | 'button'
    | 'interactive'
    | 'reaction'
    | 'location'
    | string;
  text?: { body?: string };
  image?: { caption?: string; id?: string };
  video?: { caption?: string; id?: string };
  audio?: { id?: string };
  document?: { caption?: string; filename?: string; id?: string };
  button?: { text?: string };
  interactive?: {
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
  reaction?: { emoji?: string };
}

interface CloudApiSendResponse {
  messages?: Array<{ id: string }>;
  error?: { message?: string };
}

export class CloudApiWhatsAppClient implements WhatsAppClient {
  private http?: Server;
  private port = 0;
  private onMessage?: (m: WhatsAppMessage) => void;
  private readonly apiBase: string;
  private readonly path: string;
  private readonly requireSignature: boolean;

  constructor(private readonly options: CloudApiOptions) {
    this.apiBase = options.apiBase ?? 'https://graph.facebook.com/v20.0';
    this.path = options.path ?? '/';
    this.requireSignature = options.requireSignature ?? true;
  }

  async listen(handler: (m: WhatsAppMessage) => void): Promise<void> {
    this.onMessage = handler;
    this.http = createServer((req, res) => this.handleHttp(req, res));
    await new Promise<void>((resolve) => {
      this.http!.listen(this.options.port, () => {
        const addr = this.http!.address();
        this.port = typeof addr === 'object' && addr ? addr.port : this.options.port;
        resolve();
      });
    });
  }

  async sendText(params: WhatsAppSendParams): Promise<{ id: string; timestamp: number }> {
    const to = stripJidSuffix(params.chatId);
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: params.text },
    };
    const res = await fetch(`${this.apiBase}/${this.options.phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`whatsapp cloud sendText HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as CloudApiSendResponse;
    if (json.error || !json.messages?.[0]) {
      throw new Error(json.error?.message ?? 'cloud api: no message id returned');
    }
    return { id: json.messages[0].id, timestamp: Math.floor(Date.now() / 1000) };
  }

  async close(): Promise<void> {
    if (!this.http) return;
    await new Promise<void>((resolve, reject) => {
      this.http!.close((err) => (err ? reject(err) : resolve()));
    });
    this.http = undefined;
  }

  /**
   * Test entry — feed a pre-verified webhook payload directly. Bypasses
   * signature verification.
   */
  injectWebhook(payload: CloudApiInboundEvent): void {
    this.dispatchInbound(payload);
  }

  listeningPort(): number {
    return this.port;
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!req.url || !req.url.startsWith(this.path)) {
      res.writeHead(404).end();
      return;
    }
    if (req.method === 'GET') {
      this.handleVerification(req, res);
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const raw = await readBody(req);
    if (!this.verifySignature(raw, req)) {
      res.writeHead(401).end('bad signature');
      return;
    }
    let parsed: CloudApiInboundEvent;
    try {
      parsed = JSON.parse(raw) as CloudApiInboundEvent;
    } catch {
      res.writeHead(400).end('invalid json');
      return;
    }
    this.dispatchInbound(parsed);
    res.writeHead(200).end('ok');
  }

  private handleVerification(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://placeholder');
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge') ?? '';
    if (mode === 'subscribe' && token === this.options.verifyToken) {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end(challenge);
      return;
    }
    res.writeHead(403).end('verify failed');
  }

  private verifySignature(rawBody: string, req: IncomingMessage): boolean {
    const sig = headerValue(req, 'x-hub-signature-256');
    if (!sig) return !this.requireSignature;
    const expected =
      'sha256=' + createHmac('sha256', this.options.appSecret).update(rawBody).digest('hex');
    if (sig.length !== expected.length) return false;
    try {
      return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  private dispatchInbound(event: CloudApiInboundEvent): void {
    if (event.object && event.object !== 'whatsapp_business_account') return;
    for (const entry of event.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field && change.field !== 'messages') continue;
        const value = change.value;
        if (!value?.messages) continue;
        for (const m of value.messages) {
          const translated = translateCloudApiMessage(m);
          if (translated) this.onMessage?.(translated);
        }
      }
    }
  }
}

export function translateCloudApiMessage(raw: CloudApiMessage): WhatsAppMessage | null {
  const text = extractText(raw);
  const caption = extractCaption(raw);
  if (!text && !caption) return null;
  const ts = Number(raw.timestamp);
  const msg: WhatsAppMessage = {
    id: raw.id,
    from: raw.from,
    chatId: raw.from, // Cloud API does not surface group chats; sender == chat.
    isGroup: false,
    timestamp: Number.isFinite(ts) ? ts : Math.floor(Date.now() / 1000),
    fromMe: false,
  };
  if (text !== undefined) msg.text = text;
  if (caption !== undefined) msg.mediaCaption = caption;
  return msg;
}

function extractText(raw: CloudApiMessage): string | undefined {
  if (raw.type === 'text') return raw.text?.body;
  if (raw.type === 'button') return raw.button?.text;
  if (raw.type === 'interactive') {
    return (
      raw.interactive?.button_reply?.title ?? raw.interactive?.list_reply?.title ?? undefined
    );
  }
  return undefined;
}

function extractCaption(raw: CloudApiMessage): string | undefined {
  switch (raw.type) {
    case 'image':
      return raw.image?.caption;
    case 'video':
      return raw.video?.caption;
    case 'document':
      return raw.document?.caption;
    default:
      return undefined;
  }
}

function stripJidSuffix(s: string): string {
  const at = s.indexOf('@');
  const base = at >= 0 ? s.slice(0, at) : s;
  return base.replace(/^\+/, '');
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const h = req.headers[name.toLowerCase()];
  return Array.isArray(h) ? h[0] : h;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}
