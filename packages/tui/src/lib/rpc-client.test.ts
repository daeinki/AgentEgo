import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { RpcClient } from './rpc-client.js';

/**
 * Stand up a stub JSON-RPC 2.0 server that lets tests script method responses
 * and notifications. We don't reuse `@agent-platform/gateway-cli`'s RpcServer
 * here to avoid a circular workspace dep — these tests exercise the client's
 * correlation, reconnect, and notification dispatch in isolation.
 */
interface StubOptions {
  requireAuth?: boolean;
  methods: Record<
    string,
    (
      params: unknown,
      ctx: { notify: (method: string, params: unknown) => void },
    ) => Promise<unknown>
  >;
}

async function startStub(options: StubOptions): Promise<{
  url: string;
  close: () => Promise<void>;
  disconnectAll: () => void;
}> {
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    if (options.requireAuth !== false) {
      const h = req.headers['authorization'];
      const token = Array.isArray(h) ? h[0] : h;
      if (token !== 'Bearer good-token') {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws));
  });

  const attach = (ws: WebSocket): void => {
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString('utf-8')) as {
        id?: string | number;
        method: string;
        params: unknown;
      };
      const handler = options.methods[frame.method];
      const send = (obj: unknown) => ws.send(JSON.stringify(obj));
      if (!handler) {
        send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'method not found' } });
        return;
      }
      handler(frame.params, {
        notify: (method, params) =>
          send({ jsonrpc: '2.0', method, params }),
      })
        .then((result) => send({ jsonrpc: '2.0', id: frame.id, result }))
        .catch((err: Error) =>
          send({ jsonrpc: '2.0', id: frame.id, error: { code: -32000, message: err.message } }),
        );
    });
  };

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
  const addr = http.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    url: `ws://127.0.0.1:${port}/rpc`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.close();
        wss.close(() => http.close(() => resolve()));
      }),
    disconnectAll: () => {
      for (const c of wss.clients) c.close();
    },
  };
}

describe('RpcClient', () => {
  let stub: Awaited<ReturnType<typeof startStub>>;

  afterEach(async () => {
    await stub?.close();
  });

  it('resolves a simple call', async () => {
    stub = await startStub({
      methods: {
        'gateway.health': async () => ({ ok: true, version: 't' }),
      },
    });
    const client = new RpcClient({ url: stub.url, authToken: 'good-token' });
    const res = await client.call<{ ok: boolean; version: string }>('gateway.health', {});
    expect(res).toEqual({ ok: true, version: 't' });
    client.close();
  });

  it('surfaces a 401 on bad auth as a connection error', async () => {
    stub = await startStub({
      methods: { 'x.y': async () => ({}) },
    });
    const client = new RpcClient({
      url: stub.url,
      authToken: 'bad',
      maxReconnectAttempts: 0,
    });
    await expect(client.connect()).rejects.toThrow(/401|upgrade/i);
    client.close();
  });

  it('routes per-request notifications to the originating call', async () => {
    stub = await startStub({
      methods: {
        'chat.send': async (params, ctx) => {
          const p = params as { text: string };
          ctx.notify('chat.delta', { requestId: 1, text: `echo:${p.text}` });
          ctx.notify('chat.delta', { requestId: 1, text: '!' });
          return { ok: true };
        },
      },
    });
    const client = new RpcClient({ url: stub.url, authToken: 'good-token' });
    const deltas: string[] = [];
    await client.call('chat.send', { text: 'hi' }, {
      onNotification: (method, p) => {
        if (method === 'chat.delta') deltas.push((p as { text: string }).text);
      },
    });
    expect(deltas).toEqual(['echo:hi', '!']);
    client.close();
  });

  it('times out if no response arrives', async () => {
    stub = await startStub({
      methods: {
        'slow.op': () => new Promise(() => {}), // never resolves
      },
    });
    const client = new RpcClient({ url: stub.url, authToken: 'good-token' });
    await expect(client.call('slow.op', {}, { timeoutMs: 150 })).rejects.toThrow(/timed out/i);
    client.close();
  });
});
