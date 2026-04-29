import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as ServerWs } from 'ws';
import { DiscordGatewayClient, DiscordShardManager, type GatewayLifecycleEvent } from './gateway-client.js';
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

    it('Reconnect opcode does not throw when no socket is present', () => {
      const client = new DiscordGatewayClient({ token: 't' });
      expect(() => client._inject({ op: GatewayOp.Reconnect })).not.toThrow();
    });

    it('captures session_id and resume_gateway_url from READY', () => {
      const client = new DiscordGatewayClient({ token: 't' });
      client._inject({
        op: GatewayOp.Dispatch,
        t: 'READY',
        s: 1,
        d: {
          session_id: 'sess-abc',
          resume_gateway_url: 'wss://resume.example/?v=10',
        },
      });
      expect(client.sessionState().sessionId).toBe('sess-abc');
      expect(client.sessionState().lastSeq).toBe(1);
    });

    it('InvalidSession with d=false drops the cached session', () => {
      const client = new DiscordGatewayClient({ token: 't' });
      client._inject({
        op: GatewayOp.Dispatch,
        t: 'READY',
        s: 5,
        d: { session_id: 'sess-1', resume_gateway_url: 'wss://r/' },
      });
      expect(client.sessionState().sessionId).toBe('sess-1');
      const lifecycle: GatewayLifecycleEvent[] = [];
      // Replace via direct call into the handler by re-creating client with onLifecycle
      const tracked = new DiscordGatewayClient({
        token: 't',
        onLifecycle: (e) => lifecycle.push(e),
      });
      tracked._inject({
        op: GatewayOp.Dispatch,
        t: 'READY',
        s: 7,
        d: { session_id: 's', resume_gateway_url: null },
      });
      tracked._inject({ op: GatewayOp.InvalidSession, d: false });
      expect(tracked.sessionState().sessionId).toBeNull();
      expect(lifecycle.find((e) => e.type === 'invalid_session')).toEqual({
        type: 'invalid_session',
        resumable: false,
      });
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
        autoReconnect: false,
      });
      await client.connect();

      const identify = await identifyFramePromise;
      expect(identify.op).toBe(GatewayOp.Identify);
      const d = identify.d as { token: string; intents: number };
      expect(d.token).toBe('bot-token');
      expect(d.intents & Intent.GuildMessages).toBe(Intent.GuildMessages);

      await client.close();
    });

    it('IDENTIFY includes shard array when shard option is set', async () => {
      const identifyFramePromise = new Promise<Record<string, unknown>>((resolve) => {
        gw.onConnection((ws) => {
          ws.send(JSON.stringify({ op: GatewayOp.Hello, d: { heartbeat_interval: 30_000 } }));
          ws.once('message', (data: Buffer) => {
            resolve(JSON.parse(data.toString('utf-8')) as Record<string, unknown>);
          });
        });
      });

      const client = new DiscordGatewayClient({
        url: gw.url,
        token: 't',
        shard: [1, 4],
        autoReconnect: false,
      });
      await client.connect();

      const identify = await identifyFramePromise;
      const d = identify.d as { shard?: [number, number] };
      expect(d.shard).toEqual([1, 4]);

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
              ws.send(JSON.stringify({ op: GatewayOp.Heartbeat, d: null }));
              return;
            }
            if (frame.op === GatewayOp.Heartbeat) resolve();
          });
        });
      });

      const client = new DiscordGatewayClient({
        url: gw.url,
        token: 't',
        autoReconnect: false,
      });
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

      const client = new DiscordGatewayClient({
        url: gw.url,
        token: 't',
        autoReconnect: false,
      });
      client.onMessage((m) => {
        received = { id: m.id };
      });
      await client.connect();
      await messagePromise;
      await new Promise((r) => setTimeout(r, 20));
      expect(received).not.toBeNull();
      expect((received as unknown as { id: string }).id).toBe('server-msg-1');
      await client.close();
    });

    it('RESUMEs with cached session after a transient close', async () => {
      let connectionCount = 0;
      let resumeFrame: Record<string, unknown> | null = null;
      const resumeReceived = new Promise<void>((resolveResume) => {
        gw.onConnection((ws) => {
          connectionCount += 1;
          if (connectionCount === 1) {
            ws.send(JSON.stringify({ op: GatewayOp.Hello, d: { heartbeat_interval: 60_000 } }));
            ws.once('message', () => {
              // Reply with a READY (so client caches sessionId/seq) then drop with code 4000.
              ws.send(
                JSON.stringify({
                  op: GatewayOp.Dispatch,
                  t: 'READY',
                  s: 7,
                  d: { session_id: 'sess-resume', resume_gateway_url: gw.url },
                }),
              );
              setTimeout(() => ws.close(4000, 'transient drop'), 5);
            });
            return;
          }
          // Second connection — expect RESUME, not IDENTIFY.
          ws.send(JSON.stringify({ op: GatewayOp.Hello, d: { heartbeat_interval: 60_000 } }));
          ws.once('message', (data: Buffer) => {
            const frame = JSON.parse(data.toString('utf-8')) as Record<string, unknown>;
            resumeFrame = frame;
            resolveResume();
          });
        });
      });

      const client = new DiscordGatewayClient({
        url: gw.url,
        token: 'bot',
        // Keep backoff small so the test is quick.
        maxReconnectDelayMs: 50,
      });
      await client.connect();

      // Wait for the second connection's frame.
      await resumeReceived;
      // Give the close handler a tick to settle.
      await new Promise((r) => setTimeout(r, 20));

      expect(connectionCount).toBe(2);
      expect(resumeFrame).not.toBeNull();
      const rf = resumeFrame as unknown as { op: number; d: { session_id: string; seq: number } };
      expect(rf.op).toBe(GatewayOp.Resume);
      const d = rf.d;
      expect(d.session_id).toBe('sess-resume');
      expect(d.seq).toBe(7);

      await client.close();
    });

    it('re-IDENTIFIES after a non-resumable close (4007)', async () => {
      let connectionCount = 0;
      let secondFrame: Record<string, unknown> | null = null;
      const secondFrameReceived = new Promise<void>((resolve) => {
        gw.onConnection((ws) => {
          connectionCount += 1;
          if (connectionCount === 1) {
            ws.send(JSON.stringify({ op: GatewayOp.Hello, d: { heartbeat_interval: 60_000 } }));
            ws.once('message', () => {
              ws.send(
                JSON.stringify({
                  op: GatewayOp.Dispatch,
                  t: 'READY',
                  s: 11,
                  d: { session_id: 'sess-doomed', resume_gateway_url: gw.url },
                }),
              );
              setTimeout(() => ws.close(4007, 'invalid seq'), 5);
            });
            return;
          }
          ws.send(JSON.stringify({ op: GatewayOp.Hello, d: { heartbeat_interval: 60_000 } }));
          ws.once('message', (data: Buffer) => {
            secondFrame = JSON.parse(data.toString('utf-8')) as Record<string, unknown>;
            resolve();
          });
        });
      });

      const client = new DiscordGatewayClient({
        url: gw.url,
        token: 'bot',
        maxReconnectDelayMs: 50,
      });
      await client.connect();
      await secondFrameReceived;
      await new Promise((r) => setTimeout(r, 20));

      expect((secondFrame as unknown as { op: number }).op).toBe(GatewayOp.Identify);
      // Session was dropped before reconnect.
      expect(client.sessionState().sessionId).toBeNull();

      await client.close();
    });

    it('does not reconnect after a fatal close (4004)', async () => {
      let connectionCount = 0;
      const lifecycle: GatewayLifecycleEvent[] = [];
      gw.onConnection((ws) => {
        connectionCount += 1;
        ws.send(JSON.stringify({ op: GatewayOp.Hello, d: { heartbeat_interval: 60_000 } }));
        ws.once('message', () => {
          setTimeout(() => ws.close(4004, 'auth failed'), 5);
        });
      });

      const client = new DiscordGatewayClient({
        url: gw.url,
        token: 'bad',
        maxReconnectDelayMs: 50,
        onLifecycle: (e) => lifecycle.push(e),
      });
      await client.connect();
      // Wait long enough to confirm no second connection happens.
      await new Promise((r) => setTimeout(r, 150));
      expect(connectionCount).toBe(1);
      expect(lifecycle.some((e) => e.type === 'fatal' && e.code === 4004)).toBe(true);

      await client.close();
    });
  });

  describe('DiscordShardManager', () => {
    let gw: FakeGateway;
    beforeEach(async () => {
      gw = await startFakeGateway();
    });
    afterEach(async () => {
      await gw.stop();
    });

    it('connects N shards with shard=[i,N] in IDENTIFY', async () => {
      const identifies: Record<string, unknown>[] = [];
      const allReceived = new Promise<void>((resolve) => {
        gw.onConnection((ws) => {
          ws.send(JSON.stringify({ op: GatewayOp.Hello, d: { heartbeat_interval: 60_000 } }));
          ws.once('message', (data: Buffer) => {
            identifies.push(JSON.parse(data.toString('utf-8')) as Record<string, unknown>);
            if (identifies.length === 3) resolve();
          });
        });
      });

      const mgr = new DiscordShardManager({
        url: gw.url,
        token: 't',
        shardCount: 3,
        autoReconnect: false,
      });
      await mgr.connect(0);
      await allReceived;

      const shards = identifies.map((f) => (f.d as { shard?: [number, number] }).shard);
      expect(shards).toEqual([
        [0, 3],
        [1, 3],
        [2, 3],
      ]);

      await mgr.close();
    });

    it('rejects shardCount < 1', () => {
      expect(() => new DiscordShardManager({ token: 't', shardCount: 0 })).toThrow(/shardCount/);
    });
  });
});
