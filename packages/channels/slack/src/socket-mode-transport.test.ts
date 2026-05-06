import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as ServerWs } from 'ws';
import { SocketModeTransport, type SocketLifecycleEvent } from './socket-mode-transport.js';
import type { SlackEventsRequest } from './slack-events.js';

interface FakeSocket {
  url: string;
  wss: WebSocketServer;
  onConnection: (cb: (ws: ServerWs) => void) => void;
  stop: () => Promise<void>;
}

async function startFakeSocket(): Promise<FakeSocket> {
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

describe('SocketModeTransport', () => {
  let fake: FakeSocket;
  beforeEach(async () => {
    fake = await startFakeSocket();
  });
  afterEach(async () => {
    await fake.stop();
  });

  it('reads HELLO from the server and reports `open`/`hello` lifecycle events', async () => {
    const lifecycle: SocketLifecycleEvent[] = [];
    fake.onConnection((ws) => {
      ws.send(JSON.stringify({ type: 'hello', num_connections: 2 }));
    });

    const transport = new SocketModeTransport({
      appToken: 'xapp-test',
      socketUrlOverride: fake.url,
      autoReconnect: false,
      onEvent: () => undefined,
      onLifecycle: (e) => lifecycle.push(e),
    });
    await transport.start();
    await new Promise((r) => setTimeout(r, 30));

    expect(lifecycle.find((e) => e.type === 'open')).toBeTruthy();
    const hello = lifecycle.find((e) => e.type === 'hello');
    expect(hello).toEqual({ type: 'hello', numConnections: 2 });

    await transport.stop();
  });

  it('acks events_api envelopes and dispatches their payload', async () => {
    let ackPayload: { envelope_id?: string } | null = null;
    fake.onConnection((ws) => {
      ws.send(JSON.stringify({ type: 'hello', num_connections: 1 }));
      ws.send(
        JSON.stringify({
          type: 'events_api',
          envelope_id: 'env-42',
          accepts_response_payload: false,
          payload: {
            type: 'event_callback',
            event: {
              type: 'message',
              user: 'U-1',
              text: 'hi from slack',
              ts: '1700000000.000001',
              channel: 'C-1',
              channel_type: 'channel',
            },
          },
        }),
      );
      ws.on('message', (data: Buffer) => {
        ackPayload = JSON.parse(data.toString('utf-8')) as { envelope_id?: string };
      });
    });

    let received: SlackEventsRequest | null = null;
    const transport = new SocketModeTransport({
      appToken: 'xapp-test',
      socketUrlOverride: fake.url,
      autoReconnect: false,
      onEvent: (p) => {
        received = p;
      },
    });
    await transport.start();
    await new Promise((r) => setTimeout(r, 50));

    expect(ackPayload).not.toBeNull();
    expect((ackPayload as unknown as { envelope_id?: string }).envelope_id).toBe('env-42');
    expect(received).not.toBeNull();
    expect((received as unknown as SlackEventsRequest).event?.text).toBe('hi from slack');

    await transport.stop();
  });

  it('does not crash on non-events envelope kinds (interactive/slash)', async () => {
    let onEventCalls = 0;
    fake.onConnection((ws) => {
      ws.send(JSON.stringify({ type: 'hello', num_connections: 1 }));
      ws.send(
        JSON.stringify({
          type: 'interactive',
          envelope_id: 'i-1',
          payload: {
            /* opaque */
          },
        }),
      );
    });
    const transport = new SocketModeTransport({
      appToken: 'xapp-test',
      socketUrlOverride: fake.url,
      autoReconnect: false,
      onEvent: () => {
        onEventCalls += 1;
      },
    });
    await transport.start();
    await new Promise((r) => setTimeout(r, 30));
    expect(onEventCalls).toBe(0);
    await transport.stop();
  });

  it('reconnects when Slack sends disconnect{reason: refresh_requested}', async () => {
    let connections = 0;
    const secondConnection = new Promise<void>((resolve) => {
      fake.onConnection((ws) => {
        connections += 1;
        ws.send(JSON.stringify({ type: 'hello', num_connections: 1 }));
        if (connections === 1) {
          // Send disconnect to force a reconnect.
          setTimeout(
            () => ws.send(JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' })),
            10,
          );
        } else {
          resolve();
        }
      });
    });

    const transport = new SocketModeTransport({
      appToken: 'xapp-test',
      socketUrlOverride: fake.url,
      maxReconnectDelayMs: 50,
      onEvent: () => undefined,
    });
    await transport.start();
    await secondConnection;
    expect(connections).toBe(2);
    await transport.stop();
  });

  it('does not reconnect after stop()', async () => {
    let connections = 0;
    fake.onConnection((ws) => {
      connections += 1;
      ws.send(JSON.stringify({ type: 'hello', num_connections: 1 }));
    });
    const transport = new SocketModeTransport({
      appToken: 'xapp-test',
      socketUrlOverride: fake.url,
      maxReconnectDelayMs: 30,
      onEvent: () => undefined,
    });
    await transport.start();
    await transport.stop();
    // Force-close any lingering server socket and wait long enough that a
    // bug-y reconnect loop would have fired.
    await new Promise((r) => setTimeout(r, 150));
    expect(connections).toBe(1);
  });
});
