import type {
  WhatsAppClient,
  WhatsAppMessage,
  WhatsAppSendParams,
} from './whatsapp-client.js';

/**
 * baileys-backed WhatsApp client.
 *
 * baileys ships heavy native deps (QR auth, libsignal, proto files) and
 * doesn't belong in the default runtime. We declare it as an optional peer
 * dependency and load it via dynamic `import()` the first time someone calls
 * `createBaileysClient`. If the package isn't installed, we throw a clear
 * error pointing at the install command.
 *
 * Tests stay on the abstract `WhatsAppClient` interface (see
 * `adapter.test.ts`) so the CI pipeline doesn't need baileys installed.
 */

export interface BaileysOptions {
  /**
   * Directory that will hold baileys' auth state (QR scan credentials, etc).
   * baileys writes JSON files here; back it up to restore a session.
   */
  authDir: string;
  /**
   * Forward baileys' internal logs to your logger. Default: silent.
   */
  logger?: (level: string, msg: unknown) => void;
  /**
   * Print the pairing QR code to stdout. Default: true for dev; set to false
   * in headless deployments where a linked-devices pairing code is preferred.
   */
  printQrInTerminal?: boolean;
}

type BaileysModule = {
  default: (opts: unknown) => Promise<BaileysSocket> | BaileysSocket;
  useMultiFileAuthState: (dir: string) => Promise<{
    state: unknown;
    saveCreds: () => Promise<void>;
  }>;
  DisconnectReason?: Record<string, unknown>;
  makeWASocket?: (opts: unknown) => BaileysSocket;
};

interface BaileysSocket {
  ev: {
    on: (event: string, handler: (update: unknown) => void) => void;
    off?: (event: string, handler: (update: unknown) => void) => void;
  };
  sendMessage: (
    jid: string,
    content: { text: string },
  ) => Promise<{ key?: { id?: string }; messageTimestamp?: number }>;
  end: (err?: Error) => void;
  logout?: () => Promise<void>;
}

interface BaileysMessageShape {
  key: { id?: string; remoteJid?: string; fromMe?: boolean; participant?: string };
  messageTimestamp?: number;
  message?: {
    conversation?: string;
    extendedTextMessage?: { text?: string };
    imageMessage?: { caption?: string };
    videoMessage?: { caption?: string };
  };
}

async function loadBaileys(): Promise<BaileysModule> {
  try {
    // Using a variable to defeat TS2307 on machines without baileys.
    const name = '@whiskeysockets/baileys';
    const mod = (await import(/* @vite-ignore */ name)) as BaileysModule;
    return mod;
  } catch (err) {
    throw new Error(
      `BaileysWhatsAppClient requires @whiskeysockets/baileys. Install it with:\n` +
        `  pnpm add @whiskeysockets/baileys\n` +
        `Original error: ${(err as Error).message}`,
    );
  }
}

export async function createBaileysClient(options: BaileysOptions): Promise<WhatsAppClient> {
  const mod = await loadBaileys();
  const factory = mod.makeWASocket ?? mod.default;
  const { state, saveCreds } = await mod.useMultiFileAuthState(options.authDir);

  const sock = await factory({
    auth: state,
    printQRInTerminal: options.printQrInTerminal ?? true,
  });

  sock.ev.on('creds.update', () => {
    void saveCreds();
  });

  return new BaileysWhatsAppClient(sock, options);
}

class BaileysWhatsAppClient implements WhatsAppClient {
  private onMessage?: (m: WhatsAppMessage) => void;
  private closed = false;

  constructor(
    private readonly sock: BaileysSocket,
    private readonly options: BaileysOptions,
  ) {}

  async listen(handler: (m: WhatsAppMessage) => void): Promise<void> {
    this.onMessage = handler;
    this.sock.ev.on('messages.upsert', (upsertRaw) => {
      const upsert = upsertRaw as { type: string; messages: BaileysMessageShape[] };
      if (upsert.type !== 'notify' && upsert.type !== 'append') return;
      for (const msg of upsert.messages ?? []) {
        const translated = translateBaileysMessage(msg);
        if (translated) handler(translated);
      }
    });
  }

  async sendText(params: WhatsAppSendParams): Promise<{ id: string; timestamp: number }> {
    const result = await this.sock.sendMessage(params.chatId, { text: params.text });
    return {
      id: result.key?.id ?? `out-${Date.now()}`,
      timestamp: result.messageTimestamp ?? Math.floor(Date.now() / 1000),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.sock.logout?.();
    } catch {
      // best-effort
    }
    this.sock.end();
    this.options.logger?.('info', 'baileys socket closed');
  }
}

export function translateBaileysMessage(raw: BaileysMessageShape): WhatsAppMessage | null {
  if (!raw.key.remoteJid) return null;
  const text =
    raw.message?.conversation ??
    raw.message?.extendedTextMessage?.text ??
    undefined;
  const caption =
    raw.message?.imageMessage?.caption ?? raw.message?.videoMessage?.caption ?? undefined;
  if (!text && !caption) return null;

  const isGroup = raw.key.remoteJid.endsWith('@g.us');
  // For groups baileys sets `key.participant`; for 1:1 chats `remoteJid` is the sender.
  const from = isGroup ? raw.key.participant ?? raw.key.remoteJid : raw.key.remoteJid;

  const msg: WhatsAppMessage = {
    id: raw.key.id ?? `in-${Date.now()}`,
    from,
    chatId: raw.key.remoteJid,
    isGroup,
    timestamp: raw.messageTimestamp ?? Math.floor(Date.now() / 1000),
    fromMe: raw.key.fromMe === true,
  };
  if (text !== undefined) msg.text = text;
  if (caption !== undefined) msg.mediaCaption = caption;
  return msg;
}
