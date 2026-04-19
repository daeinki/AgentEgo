import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { nowMs } from '@agent-platform/core';
import { createTokenMint, type TokenMint } from './pairing.js';
import {
  encodeOutbound,
  parseInbound,
  type DeviceInbound,
  type DeviceInfo,
  type DeviceOutbound,
} from './protocol.js';

export interface PairingRequest {
  deviceId: string;
  pairingCode: string;
  info: DeviceInfo;
}

export interface DeviceNodeServerOptions {
  port: number;
  tokenSecret: string;
  /**
   * Verify a pairing attempt. Return true to accept and issue a session
   * token. The caller typically checks `pairingCode` against a short-lived
   * code shown to the user.
   */
  verifyPairing: (req: PairingRequest) => Promise<boolean>;
  /**
   * Handler called for every inbound `message` from a paired device.
   */
  onDeviceMessage?: (deviceId: string, text: string, clientMessageId?: string) => void;
}

interface Connection {
  ws: WebSocket;
  deviceId?: string;
  info?: DeviceInfo;
  pairedAt?: number;
  lastHeartbeatMs?: number;
}

/**
 * Device-node WebSocket server. Accepts connections on `/device`, runs
 * the pairing handshake, then relays inbound messages + pushes notifications
 * back to connected devices.
 */
export class DeviceNodeServer {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly tokens: TokenMint;
  private readonly connections = new Map<string, Connection>();
  private port = 0;
  private running = false;

  constructor(private readonly options: DeviceNodeServerOptions) {
    this.tokens = createTokenMint(options.tokenSecret);
    this.http = createServer();
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on('upgrade', (req, socket, head) => {
      if (req.url !== '/device') {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.handleConnection(ws));
    });
  }

  async start(): Promise<number> {
    await new Promise<void>((resolve) => {
      this.http.listen(this.options.port, () => {
        const addr = this.http.address();
        this.port = typeof addr === 'object' && addr ? addr.port : this.options.port;
        resolve();
      });
    });
    this.running = true;
    return this.port;
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const conn of this.connections.values()) conn.ws.close();
    this.connections.clear();
    await new Promise<void>((resolve, reject) => {
      this.wss.close(() => {
        this.http.close((err) => (err ? reject(err) : resolve()));
      });
    });
  }

  listeningPort(): number {
    return this.port;
  }

  /**
   * Send a push notification to a paired device. Returns false if the device
   * isn't currently connected.
   */
  pushTo(deviceId: string, notification: Omit<Extract<DeviceOutbound, { type: 'push' }>, 'type'>): boolean {
    const conn = this.connections.get(deviceId);
    if (!conn || conn.ws.readyState !== conn.ws.OPEN) return false;
    conn.ws.send(encodeOutbound({ type: 'push', ...notification }));
    return true;
  }

  /**
   * Snapshot of currently-connected devices. Useful for a "paired devices" UI.
   */
  connectedDevices(): Array<{ deviceId: string; info: DeviceInfo | undefined; pairedAt?: number; lastHeartbeatMs?: number }> {
    const out: Array<{ deviceId: string; info: DeviceInfo | undefined; pairedAt?: number; lastHeartbeatMs?: number }> = [];
    for (const [deviceId, conn] of this.connections) {
      const entry: { deviceId: string; info: DeviceInfo | undefined; pairedAt?: number; lastHeartbeatMs?: number } = {
        deviceId,
        info: conn.info,
      };
      if (conn.pairedAt !== undefined) entry.pairedAt = conn.pairedAt;
      if (conn.lastHeartbeatMs !== undefined) entry.lastHeartbeatMs = conn.lastHeartbeatMs;
      out.push(entry);
    }
    return out;
  }

  // ─── internals ───────────────────────────────────────────────────────────

  private handleConnection(ws: WebSocket): void {
    const conn: Connection = { ws };
    ws.on('message', (raw: Buffer) => {
      void this.dispatch(conn, raw.toString('utf-8'));
    });
    ws.on('close', () => {
      if (conn.deviceId) this.connections.delete(conn.deviceId);
    });
  }

  private async dispatch(conn: Connection, raw: string): Promise<void> {
    const parsed = parseInbound(raw);
    if ('error' in parsed) {
      this.safeSend(conn.ws, { type: 'error', code: 'bad_envelope', message: parsed.error });
      return;
    }
    switch (parsed.type) {
      case 'hello':
        await this.handleHello(conn, parsed);
        break;
      case 'heartbeat':
        this.handleHeartbeat(conn, parsed);
        break;
      case 'message':
        this.handleMessage(conn, parsed);
        break;
      case 'ack':
        // Caller-supplied hook would go here. Not tracked for now.
        break;
    }
  }

  private async handleHello(
    conn: Connection,
    env: Extract<DeviceInbound, { type: 'hello' }>,
  ): Promise<void> {
    const ok = await this.options.verifyPairing(env);
    if (!ok) {
      this.safeSend(conn.ws, { type: 'pair_failed', reason: 'pairing code invalid or expired' });
      conn.ws.close();
      return;
    }
    conn.deviceId = env.deviceId;
    conn.info = env.info;
    conn.pairedAt = nowMs();
    this.connections.set(env.deviceId, conn);

    const sessionToken = this.tokens.mint(env.deviceId);
    this.safeSend(conn.ws, {
      type: 'paired',
      deviceId: env.deviceId,
      sessionToken,
    });
  }

  private handleHeartbeat(
    conn: Connection,
    env: Extract<DeviceInbound, { type: 'heartbeat' }>,
  ): void {
    conn.lastHeartbeatMs = nowMs();
    this.safeSend(conn.ws, {
      type: 'heartbeat_ack',
      sentAt: env.sentAt,
      serverTime: nowMs(),
    });
  }

  private handleMessage(
    conn: Connection,
    env: Extract<DeviceInbound, { type: 'message' }>,
  ): void {
    if (!conn.deviceId) {
      this.safeSend(conn.ws, { type: 'error', code: 'unpaired', message: 'pair first' });
      return;
    }
    this.options.onDeviceMessage?.(conn.deviceId, env.text, env.clientMessageId);
  }

  private safeSend(ws: WebSocket, env: DeviceOutbound): void {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(encodeOutbound(env));
  }

  // ─── test helpers ─────────────────────────────────────────────────────────

  /** Expose running flag for tests. */
  _isRunning(): boolean {
    return this.running;
  }
}
