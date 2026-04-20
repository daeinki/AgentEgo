import type { ReactiveController, ReactiveControllerHost } from 'lit';
import { createContext } from '@lit/context';
import { BrowserRpcClient, type ConnectionStatus } from './rpc-client.js';
import { DeviceIdentity } from './device-identity.js';

/**
 * Owns the `/rpc` WebSocket connection and shared device-identity. Exposes
 * `call(method, params)` to everyone (views + other controllers) via the
 * `@lit/context` provider `gatewayContext`.
 */
export class GatewayController implements ReactiveController {
  readonly identity = new DeviceIdentity();
  readonly rpc: BrowserRpcClient;

  private host: ReactiveControllerHost;
  private unsubStatus: (() => void) | null = null;
  private _status: ConnectionStatus = 'idle';
  private _enrolled = false;
  private _lastError: string | null = null;

  private readonly notifListeners = new Map<
    string,
    Set<(params: unknown) => void>
  >();

  constructor(host: ReactiveControllerHost) {
    this.host = host;
    host.addController(this);
    this.rpc = new BrowserRpcClient({
      url: this.wsUrl(),
      getToken: async () => (await this.identity.assert()).token,
      onNotification: (method, params) => this.dispatch(method, params),
    });
  }

  hostConnected(): void {
    this.unsubStatus = this.rpc.onStatus((s) => {
      this._status = s;
      this.host.requestUpdate();
    });
    void this.identity.isEnrolled().then((ok) => {
      this._enrolled = ok;
      this.host.requestUpdate();
    });
  }

  hostDisconnected(): void {
    this.unsubStatus?.();
    this.unsubStatus = null;
    this.rpc.close();
  }

  get status(): ConnectionStatus {
    return this._status;
  }

  get enrolled(): boolean {
    return this._enrolled;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  async enroll(bootstrapToken: string, name?: string): Promise<void> {
    try {
      await this.identity.enroll(bootstrapToken, name);
      this._enrolled = true;
      this._lastError = null;
      this.host.requestUpdate();
      await this.rpc.connect();
    } catch (err) {
      this._lastError = (err as Error).message;
      this.host.requestUpdate();
      throw err;
    }
  }

  async resetIdentity(): Promise<void> {
    this.rpc.close();
    await this.identity.reset();
    this._enrolled = false;
    this.host.requestUpdate();
  }

  async call<R = unknown>(
    method: string,
    params?: unknown,
    options?: Parameters<BrowserRpcClient['call']>[2],
  ): Promise<R> {
    try {
      return await this.rpc.call<R>(method, params, options);
    } catch (err) {
      this._lastError = (err as Error).message;
      this.host.requestUpdate();
      throw err;
    }
  }

  onNotification(method: string, fn: (params: unknown) => void): () => void {
    let bucket = this.notifListeners.get(method);
    if (!bucket) {
      bucket = new Set();
      this.notifListeners.set(method, bucket);
    }
    bucket.add(fn);
    return () => {
      bucket!.delete(fn);
      if (bucket!.size === 0) this.notifListeners.delete(method);
    };
  }

  private dispatch(method: string, params: unknown): void {
    const bucket = this.notifListeners.get(method);
    if (!bucket) return;
    for (const fn of bucket) fn(params);
  }

  private wsUrl(): string {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${proto}://${window.location.host}/rpc`;
  }
}

export const gatewayContext = createContext<GatewayController>(
  Symbol('gateway-controller'),
);
