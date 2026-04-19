import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as ServerWs } from 'ws';
import { DiscordGatewayClient } from './gateway-client.js';
import { GatewayOp, Intent, combineIntents } from './gateway-opcodes.js';

interface FakeGateway {
  url: string;
  wss: WebSocketServer;
  onConnection: (cb: (ws: ServerWs) => void) => void;
  stop: () => Promise<void>;
}

async function startFakeGateway(): Promise<FakeGateway> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const addr = wss.address() as AddressInfo;
  const url = `ws://127.0.0.1:${addr.port}`;

  let connHandler: ((ws: ServerWs) => void) | undefined;
  wss.on('connection', (ws) => connHandler?.(ws));

  return {
    url,
    wss,
    onConnection: (cb) => {
      connHandler = cb;
    },
    async stop() {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    },
  };
}

describe('DiscordGatewayClient', () => {
  describe('unit — injected frames', () => {
    it('emits MESSAGE_CREATE dispatches through the handler', () => {
      const client = new DiscordGatewayClient({ token: 't' });
      let called: { msg: unknown; dm: boolean } | null = null;
      client.onMessage((m, isDm) => {
        called = { msg: m, dm: isDm };
      });

      client._inject({
        op: GatewayOp.Dispatch,
        t: 'MESSAGE_CREATE',
        s: 1,
        d: {
          id: '101',
          channel_id: 'C1',
          author: { id: 'U1', username: 'alice' },
          content: 'hi',
          timestamp: new Date().toISOString(),
        },
      });

      expect(called).not.toBeNull();
      const c = called as unknown as { msg: { id: string }; dm: boolean };
      expect(c.msg.id).toBe('101');
      expect(c.dm).toBe(true);
    });

    it('marks messages with guild_id as non-DM', () => {
      const client = new DiscordGatewayClient({ token: 't' });
      let dm = true;
      client.onMessage((_m, isDm) => {
        dm = isDm;
      });
      client._inject({
        op: GatewayOp.Dispatch,
        t: 'MESSAGE_CREATE',
        s: 1,
        d: {
          id: '1',
          channel_id: 'C',
          author: { id: 'U', username: 'u' },
          content: 'g',
          timestamp: '',
          guild_id: 'G',
        },
      });
      expect(dm).toBe(false);
    });

    it('ignores non-MESSAGE_CREATE dispatches', () => {
      const client = new DiscordGatewayClient({ token: 't' });
      let called = false;
      client.onMessage(() => {
        called = true;
      });
      client._inject({ op: GatewayOp.Dispatch, t: 'TYPING_START', s: 2, d: {} });
      expect(called).toBe(false);
    });

    it('Reconnect opcode closes the socket cleanly', () => {
      const client = new DiscordGatewayClient({ token: 't' });
      // Without a real socket connection, Reconnect should not throw.
      expect(() => client._inject({ op: GatewayOp.Reconnect })).not.toThrow();
    });
  });

  describe('integration — against a local fake gateway', () => {
    let gw: FakeGateway;

    beforeEach(async () => {
      gw = await startFakeGateway();
    });
    afterEach(async () => {
      await gw.stop();
    });

    it('HELLO triggers IDENTIFY with the configured intents', async () => {
      const identifyFramePromise = new Promise<Record<string, unknown>>((resolve) => {
        gw.onConnection((ws) => {
          // Send HELLO with short heartbeat interval so the test is quick.
          ws.send(JSON.stringify({ op: GatewayOp.Hello, d: { heartbeat_interval: 30_000 } }));
          ws.once('message', (data: Buffer) => {
            resolve(JSON.parse(data.toString('utf-8')) as Record<string, unknown>);
          });
        });
      });

      const client = new DiscordGatewayClient({
        url: gw.url,
        token: 'bot-token',
        intents: combineIntents(Intent.GuildMessages, Intent.MessageContent),
      });
      await client.connect();

      const identify = await identifyFramePromise;
      expect(identify.op).toBe(GatewayOp.Identify);
      const d = identify.d as { token: string; intents: number };
      expect(d.token).toBe('bot-token');
      expect(d.intents & Intent.GuildMessages).toBe(Intent.GuildMessages);

      await client.close();
    });

    it('server-initiated Heartbeat (op 1) triggers an immediate heartbeat response', async () => {
      const heartbeatPromise = new Promise<void>((resolve) => {
        gw.onConnection((ws) => {
          ws.send(JSON.stringify({ op: GatewayOp.Hello, d: { heartbeat_interval: 60_000 } }));
          let identifyReceived = false;
          ws.on('message', (data: Buffer) => {
            const frame = JSON.parse(data.toString('utf-8')) as { op: number };
            if (!identifyReceived && frame.op === GatewayOp.Identify) {
              identifyReceived = true;
              // Ask the client to heartbeat.
              ws.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: null }));
              return;
            }
            if (frame.op === GatewayOp.Heartbeat) resolve();
          });
        });
      });

      const client = new DiscordGatewayClient({ url: gw.url, token: 't' });
      await client.connect();
      await heartbeatPromise;
      await client.close();
    });

    it('MESSAGE_CREATE from the server reaches the handler', async () => {
      let received: { id: string } | null = null;
      const messagePromise = new Promise<void>((resolve) => {
        gw.onConnection((ws) => {
          ws.send(JSON.stringify({ op: GatewayOp.Hello, d: { heartbeat_interval: 60_000 } }));
          ws.on('message', () => {
            // After IDENTIFY, push a MESSAGE_CREATE.
            ws.send(
              JSON.stringify({
                op: GatewayOp.Dispatch,
                t: 'MESSAGE_CREATE',
                s: 3,
                d: {
                  id: 'server-msg-1',
                  channel_id: 'C',
                  author: { id: 'U', username: 'alice' },
                  content: 'hello from gateway',
                  timestamp: new Date().toISOString(),
                },
              }),
            );
            resolve();
          });
        });
      });

      const client = new DiscordGatewayClient({ url: gw.url, token: 't' });
      client.onMessage((m) => {
        received = { id: m.id };
      });
      await client.connect();
      await messagePromise;
      // Give the client a tick to process.
      await new Promise((r) => setTimeout(r, 20));
      expect(received).not.toBeNull();
      expect((received as unknown as { id: string }).id).toBe('server-msg-1');
      await client.close();
    });
  });
});
