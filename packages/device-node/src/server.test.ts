import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { DeviceNodeServer, type PairingRequest } from './server.js';

async function waitFor<T>(predicate: () => T | undefined, timeoutMs = 1500): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = predicate();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor timed out');
}

describe('DeviceNodeServer', () => {
  let server: DeviceNodeServer;
  let pairingAttempts: PairingRequest[];
  let acceptPairing = true;

  beforeEach(async () => {
    pairingAttempts = [];
    acceptPairing = true;
    server = new DeviceNodeServer({
      port: 0,
      tokenSecret: 'secret',
      verifyPairing: async (req) => {
        pairingAttempts.push(req);
        return acceptPairing;
      },
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  async function openDevice(): Promise<{ ws: WebSocket; inbox: unknown[] }> {
    const ws = new WebSocket(`ws://127.0.0.1:${server.listeningPort()}/device`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const inbox: unknown[] = [];
    ws.on('message', (data: Buffer) => inbox.push(JSON.parse(data.toString('utf-8'))));
    return { ws, inbox };
  }

  it('starts and exposes a port', () => {
    expect(server.listeningPort()).toBeGreaterThan(0);
  });

  it('rejects unknown paths', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.listeningPort()}/other`);
    await new Promise<void>((resolve) => {
      ws.once('error', () => resolve());
      ws.once('unexpected-response', () => resolve());
    });
  });

  it('accepts a valid pairing handshake and returns a session token', async () => {
    const { ws, inbox } = await openDevice();
    ws.send(
      JSON.stringify({
        type: 'hello',
        deviceId: 'd-1',
        pairingCode: 'CODE12',
        info: { deviceId: 'd-1', platform: 'macos' },
      }),
    );
    const paired = (await waitFor(() =>
      inbox.find((m) => (m as { type: string }).type === 'paired'),
    )) as { deviceId: string; sessionToken: string };
    expect(paired.deviceId).toBe('d-1');
    expect(paired.sessionToken).toMatch(/^\d+\.[0-9a-f]+$/);
    expect(server.connectedDevices().some((c) => c.deviceId === 'd-1')).toBe(true);
    ws.close();
  });

  it('rejects a failed pairing and closes the socket', async () => {
    acceptPairing = false;
    const { ws, inbox } = await openDevice();
    ws.send(
      JSON.stringify({
        type: 'hello',
        deviceId: 'd-2',
        pairingCode: 'BAD',
        info: { deviceId: 'd-2', platform: 'android' },
      }),
    );
    await waitFor(() => inbox.find((m) => (m as { type: string }).type === 'pair_failed'));
    // Socket should close shortly after.
    await new Promise((r) => setTimeout(r, 50));
    expect(server.connectedDevices().some((c) => c.deviceId === 'd-2')).toBe(false);
  });

  it('heartbeat exchange works', async () => {
    const { ws, inbox } = await openDevice();
    ws.send(
      JSON.stringify({
        type: 'hello',
        deviceId: 'd-3',
        pairingCode: 'X',
        info: { deviceId: 'd-3', platform: 'ios' },
      }),
    );
    await waitFor(() => inbox.find((m) => (m as { type: string }).type === 'paired'));

    ws.send(JSON.stringify({ type: 'heartbeat', sentAt: 999 }));
    const ack = (await waitFor(() =>
      inbox.find((m) => (m as { type: string }).type === 'heartbeat_ack'),
    )) as { sentAt: number; serverTime: number };
    expect(ack.sentAt).toBe(999);
    expect(ack.serverTime).toBeGreaterThan(0);
    ws.close();
  });

  it('relays device messages via onDeviceMessage callback', async () => {
    const relayed: string[] = [];
    await server.stop();
    server = new DeviceNodeServer({
      port: 0,
      tokenSecret: 's',
      verifyPairing: async () => true,
      onDeviceMessage: (_id, text) => relayed.push(text),
    });
    await server.start();

    const { ws, inbox } = await openDevice();
    ws.send(
      JSON.stringify({
        type: 'hello',
        deviceId: 'd-4',
        pairingCode: 'Y',
        info: { deviceId: 'd-4', platform: 'linux' },
      }),
    );
    await waitFor(() => inbox.find((m) => (m as { type: string }).type === 'paired'));

    ws.send(JSON.stringify({ type: 'message', text: 'hello platform' }));
    await waitFor(() => (relayed.length > 0 ? true : undefined));
    expect(relayed).toEqual(['hello platform']);
    ws.close();
  });

  it('refuses message before pairing', async () => {
    const { ws, inbox } = await openDevice();
    ws.send(JSON.stringify({ type: 'message', text: 'leaked' }));
    await waitFor(() => inbox.find((m) => (m as { type: string }).type === 'error'));
    const err = inbox.find((m) => (m as { type: string }).type === 'error') as { code: string };
    expect(err.code).toBe('unpaired');
    ws.close();
  });

  it('pushTo delivers a notification to a connected device', async () => {
    const { ws, inbox } = await openDevice();
    ws.send(
      JSON.stringify({
        type: 'hello',
        deviceId: 'd-5',
        pairingCode: 'Z',
        info: { deviceId: 'd-5', platform: 'windows' },
      }),
    );
    await waitFor(() => inbox.find((m) => (m as { type: string }).type === 'paired'));

    const sent = server.pushTo('d-5', {
      pushId: 'p-1',
      title: 'Done',
      body: 'Your agent finished',
    });
    expect(sent).toBe(true);
    const push = (await waitFor(() =>
      inbox.find((m) => (m as { type: string }).type === 'push'),
    )) as { pushId: string; title: string };
    expect(push.pushId).toBe('p-1');
    ws.close();
  });

  it('pushTo returns false for unknown device', () => {
    expect(server.pushTo('nope', { pushId: 'x', title: 't', body: 'b' })).toBe(false);
  });

  it('bad envelope produces an error frame', async () => {
    const { ws, inbox } = await openDevice();
    ws.send('{not json');
    await waitFor(() => inbox.find((m) => (m as { type: string }).type === 'error'));
    ws.close();
  });
});
