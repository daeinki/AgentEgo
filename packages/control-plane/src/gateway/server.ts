import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve as resolvePath } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Contracts, Phase, PhaseEventDetail, StandardMessage } from '@agent-platform/core';
import { generateTraceId } from '@agent-platform/core';
import { RateLimiter, type RateLimiterConfig } from './rate-limiter.js';
import { TokenAuth, type AuthConfig } from './auth.js';
import { DeviceAuthStore } from './device-auth.js';
import {
  encodeOutbound,
  parseInbound,
  type OutboundEnvelope,
} from './envelope.js';
import { SessionStore } from '../session/store.js';

/**
 * A WebSocket mount point registered on the gateway. The gateway authenticates
 * the upgrade request (Bearer token) and then hands off the raw socket to the
 * mount. Used by e.g. the JSON-RPC RpcServer in `@agent-platform/gateway-cli`.
 */
export interface UpgradeMount {
  readonly path: string;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
}

export interface MessageHandlerContext {
  sessionId: string;
  agentId: string;
  traceId: string;
  /**
   * Streams a delta to the calling WebSocket client (if connected). For REST
   * submissions, deltas are buffered and returned in the HTTP response body.
   */
  emit(text: string): void;
  /**
   * ADR-010: emit a phase-transition notification for the TUI (JSON-RPC
   * `chat.phase`). Optional — callers that don't care (legacy REST/WS) leave
   * this undefined. Handlers MUST tolerate the absence.
   *
   * Detail is sanitized by the caller against the §3.1.4.7 whitelist — no
   * tool args, thought text, plan rationale, or raw error messages.
   */
  emitPhase?(phase: Phase, detail?: PhaseEventDetail): void;
  /**
   * Optional per-turn debug-trace logger. Blocks that participate in the
   * pipeline (G3/P1/E1/W1/…) record structured events through this; consumers
   * query them back via the `agent trace` CLI.
   */
  traceLogger?: Contracts.TraceLogger;
}

/**
 * A caller-supplied handler invoked for each accepted inbound message.
 * Responsible for running EGO + agent worker and emitting response deltas.
 * Throws to signal failure; the gateway converts to an error envelope.
 */
export type MessageHandler = (
  msg: StandardMessage,
  ctx: MessageHandlerContext,
) => Promise<{
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}>;

export interface WebappServeConfig {
  /** Absolute path to a built Vite dist/ directory. */
  dir: string;
  /** Feature flag. Defaults to true when `dir` is provided. */
  enabled?: boolean;
}

export interface GatewayConfig {
  port: number;
  /**
   * Host/interface to bind the HTTP server on. Default `'127.0.0.1'`.
   *
   * Explicitly defaulting to IPv4 loopback matches ADR-004 (single-owner
   * local-only gateway) and sidesteps a Node.js-on-Windows quirk where
   * `listen(port)` without a host occasionally binds only to `[::1]`,
   * causing `http://127.0.0.1:<port>` browser connects to be refused.
   *
   * Set `'::1'` for IPv6 loopback, `'0.0.0.0'` to expose on all IPv4
   * interfaces, or `'::'` for all interfaces (dualstack when supported).
   * Can be overridden via `AGENT_GATEWAY_HOST` at the CLI layer.
   */
  host?: string;
  auth: AuthConfig;
  rateLimit: RateLimiterConfig;
  router: Contracts.Router;
  sessions: SessionStore;
  handler: MessageHandler;
  /**
   * When supplied, `TokenAuth` falls back to device-session tokens and the
   * HTTP layer exposes `/device/enroll`, `/device/challenge`, `/device/assert`.
   */
  devices?: DeviceAuthStore;
  /** Optional Vite-built SPA to serve at `/ui/*`. */
  webapp?: WebappServeConfig;
}

export class ApiGateway {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly auth: TokenAuth;
  private readonly rateLimiter: RateLimiter;
  private readonly config: GatewayConfig;
  private readonly mounts = new Map<string, UpgradeMount>();
  private readonly startedAt = Date.now();

  constructor(config: GatewayConfig) {
    this.config = config;
    this.auth = new TokenAuth(config.auth, config.devices);
    this.rateLimiter = new RateLimiter(config.rateLimit);
    this.http = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true });

    this.http.on('upgrade', (req, socket, head) => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (path !== '/ws' && !this.mounts.has(path)) {
        socket.destroy();
        return;
      }
      const authHeader = req.headers['authorization'];
      let decision = this.auth.verifyBearer(
        Array.isArray(authHeader) ? authHeader[0] : authHeader,
      );
      if (!decision.ok) {
        // Browser WebSocket API can't set Authorization; accept a fallback
        // carried via Sec-WebSocket-Protocol as `bearer.<token>`. We then
        // echo the subprotocol back so the upgrade succeeds.
        const subprotos = parseSubprotocols(req.headers['sec-websocket-protocol']);
        const bearer = subprotos.find((s) => s.startsWith('bearer.'));
        if (bearer) {
          decision = this.auth.verifyToken(bearer.slice('bearer.'.length));
          if (decision.ok) {
            // `ws` picks the accepted subprotocol from the handshake for us.
            // We just ensure it's in the offered list, which it already is.
          }
        }
      }
      if (!decision.ok) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      if (path === '/ws') {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.handleWebSocket(ws, req);
        });
        return;
      }
      const mount = this.mounts.get(path)!;
      mount.handleUpgrade(req, socket, head);
    });
  }

  /**
   * Register an additional WebSocket mount at a specific path (e.g. `/rpc`).
   * The gateway handles Bearer auth; the mount owns the upgraded socket.
   * Call before {@link start} to avoid racing incoming upgrades.
   */
  mount(mount: UpgradeMount): void {
    if (this.mounts.has(mount.path) || mount.path === '/ws') {
      throw new Error(`Upgrade path already in use: ${mount.path}`);
    }
    this.mounts.set(mount.path, mount);
  }

  /** Milliseconds since the gateway was instantiated. */
  uptimeMs(): number {
    return Date.now() - this.startedAt;
  }

  async start(): Promise<number> {
    const host = this.config.host ?? '127.0.0.1';
    return new Promise((resolve) => {
      this.http.listen(this.config.port, host, () => {
        const addr = this.http.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : this.config.port;
        resolve(actualPort);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      for (const client of this.wss.clients) client.close();
      this.wss.close(() => {
        this.http.close((err) => (err ? reject(err) : resolve()));
      });
    });
  }

  // ─── HTTP ────────────────────────────────────────────────────────────────

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    if (method === 'GET' && pathname === '/healthz') {
      return sendJson(res, 200, { ok: true, service: 'control-plane' });
    }

    // ── Public: browser device-auth handshake (challenge/assert) ─────────
    // `/device/enroll` still requires master Bearer, but challenge & assert
    // are the bootstrap that issues a session token so they must be reachable
    // before auth succeeds.
    if (this.config.devices) {
      if (method === 'POST' && pathname === '/device/challenge') {
        return this.handleDeviceChallenge(req, res);
      }
      if (method === 'POST' && pathname === '/device/assert') {
        return this.handleDeviceAssert(req, res);
      }
    }

    // ── Public: static webapp assets (`/ui/*`) ───────────────────────────
    // The SPA authenticates itself via `/device/*` once loaded. Static
    // assets stay unauthenticated — same posture as OpenClaw's dashboard.
    if (method === 'GET' && this.isWebappEnabled() && isUiPath(pathname)) {
      return this.handleUiAsset(pathname, res);
    }

    const authHeader = Array.isArray(req.headers['authorization'])
      ? req.headers['authorization'][0]
      : req.headers['authorization'];
    const authz = this.auth.verifyBearer(authHeader);
    if (!authz.ok) {
      return sendJson(res, 401, { error: authz.reason ?? 'unauthorized' });
    }

    if (method === 'POST' && pathname === '/device/enroll' && this.config.devices) {
      return this.handleDeviceEnroll(req, res);
    }

    // Sessions
    const sessionMatch = /^\/sessions\/([^/]+)$/.exec(pathname);
    if (sessionMatch && method === 'GET') {
      const sessionId = sessionMatch[1]!;
      const session = this.config.sessions.getSession(sessionId);
      return session
        ? sendJson(res, 200, session)
        : sendJson(res, 404, { error: 'session not found' });
    }

    const eventsMatch = /^\/sessions\/([^/]+)\/events$/.exec(pathname);
    if (eventsMatch && method === 'GET') {
      const sessionId = eventsMatch[1]!;
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const events = this.config.sessions.getEvents(sessionId, limit);
      return sendJson(res, 200, { events });
    }

    const hibernateMatch = /^\/sessions\/([^/]+)\/hibernate$/.exec(pathname);
    if (hibernateMatch && method === 'POST') {
      const sessionId = hibernateMatch[1]!;
      try {
        this.config.sessions.hibernateSession(sessionId);
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 404, { error: (err as Error).message });
      }
    }

    const compactMatch = /^\/sessions\/([^/]+)\/compact$/.exec(pathname);
    if (compactMatch && method === 'POST') {
      const sessionId = compactMatch[1]!;
      try {
        const result = this.config.sessions.compactSession(sessionId);
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 404, { error: (err as Error).message });
      }
    }

    if (method === 'POST' && pathname === '/messages') {
      return this.handleHttpSubmit(req, res);
    }

    return sendJson(res, 404, { error: `no route: ${method} ${pathname}` });
  }

  private async handleHttpSubmit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    let msg: StandardMessage;
    try {
      msg = JSON.parse(body) as StandardMessage;
    } catch {
      return sendJson(res, 400, { error: 'invalid JSON' });
    }

    const rlKey = `${msg.channel.type}:${msg.sender.id}`;
    if (!this.rateLimiter.take(rlKey)) {
      return sendJson(res, 429, { error: 'rate limit exceeded', key: rlKey });
    }

    try {
      const route = await this.config.router.route(msg);
      const chunks: string[] = [];
      const meta = await this.config.handler(msg, {
        sessionId: route.sessionId,
        agentId: route.agentId,
        traceId: msg.traceId || generateTraceId(),
        emit: (text) => chunks.push(text),
      });
      return sendJson(res, 200, {
        accepted: true,
        routedTo: { agentId: route.agentId, sessionId: route.sessionId },
        responseText: chunks.join(''),
        usage: meta,
      });
    } catch (err) {
      return sendJson(res, 500, { error: (err as Error).message });
    }
  }

  // ─── WebSocket ───────────────────────────────────────────────────────────

  private handleWebSocket(ws: WebSocket, _req: IncomingMessage): void {
    ws.on('message', (data) => {
      const raw = data.toString('utf-8');
      const parsed = parseInbound(raw);
      if ('error' in parsed) {
        ws.send(encodeOutbound({ type: 'error', code: 'bad_envelope', message: parsed.error }));
        return;
      }
      if (parsed.type === 'ping') {
        ws.send(encodeOutbound({ type: 'pong', sentAt: parsed.sentAt, receivedAt: Date.now() }));
        return;
      }
      if (parsed.type === 'close') {
        ws.close();
        return;
      }
      void this.runSubmission(ws, parsed.message);
    });
  }

  private async runSubmission(ws: WebSocket, msg: StandardMessage): Promise<void> {
    const rlKey = `${msg.channel.type}:${msg.sender.id}`;
    if (!this.rateLimiter.take(rlKey)) {
      this.safeSend(ws, {
        type: 'error',
        traceId: msg.traceId,
        code: 'rate_limited',
        message: `rate limit exceeded for ${rlKey}`,
      });
      return;
    }

    try {
      const route = await this.config.router.route(msg);
      this.safeSend(ws, {
        type: 'accepted',
        messageId: msg.id,
        traceId: msg.traceId,
        routedTo: { agentId: route.agentId, sessionId: route.sessionId },
      });
      const meta = await this.config.handler(msg, {
        sessionId: route.sessionId,
        agentId: route.agentId,
        traceId: msg.traceId,
        emit: (text) => {
          this.safeSend(ws, { type: 'response_delta', traceId: msg.traceId, text });
        },
      });
      this.safeSend(ws, {
        type: 'response_done',
        traceId: msg.traceId,
        ...(meta.inputTokens !== undefined ? { inputTokens: meta.inputTokens } : {}),
        ...(meta.outputTokens !== undefined ? { outputTokens: meta.outputTokens } : {}),
        ...(meta.costUsd !== undefined ? { costUsd: meta.costUsd } : {}),
      });
    } catch (err) {
      this.safeSend(ws, {
        type: 'error',
        traceId: msg.traceId,
        code: 'handler_error',
        message: (err as Error).message,
      });
    }
  }

  private safeSend(ws: WebSocket, env: OutboundEnvelope): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(encodeOutbound(env));
    }
  }

  // ─── Device-auth routes ───────────────────────────────────────────────

  private async handleDeviceEnroll(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await readBody(req);
    let parsed: { publicKeyHex?: unknown; name?: unknown };
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      return sendJson(res, 400, { error: 'invalid JSON' });
    }
    const publicKeyHex =
      typeof parsed.publicKeyHex === 'string' ? parsed.publicKeyHex : '';
    const name = typeof parsed.name === 'string' ? parsed.name : 'browser';
    try {
      const device = this.config.devices!.enroll(publicKeyHex, name);
      return sendJson(res, 200, {
        deviceId: device.deviceId,
        name: device.name,
        enrolledAt: device.enrolledAt,
      });
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
  }

  private async handleDeviceChallenge(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await readBody(req);
    let parsed: { deviceId?: unknown };
    try {
      parsed = body ? (JSON.parse(body) as typeof parsed) : {};
    } catch {
      return sendJson(res, 400, { error: 'invalid JSON' });
    }
    const deviceId = typeof parsed.deviceId === 'string' ? parsed.deviceId : undefined;
    const issued = this.config.devices!.issueChallenge(deviceId);
    return sendJson(res, 200, issued);
  }

  private async handleDeviceAssert(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const body = await readBody(req);
    let parsed: {
      deviceId?: unknown;
      challenge?: unknown;
      signature?: unknown;
    };
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      return sendJson(res, 400, { error: 'invalid JSON' });
    }
    const deviceId = typeof parsed.deviceId === 'string' ? parsed.deviceId : '';
    const challenge = typeof parsed.challenge === 'string' ? parsed.challenge : '';
    const signatureHex = typeof parsed.signature === 'string' ? parsed.signature : '';
    if (!deviceId || !challenge || !signatureHex) {
      return sendJson(res, 400, {
        error: 'deviceId, challenge, signature required',
      });
    }
    try {
      const { device } = this.config.devices!.consumeChallenge(challenge, deviceId);
      const ok = verifyEd25519(
        device.publicKeyHex,
        Buffer.from(challenge, 'hex'),
        Buffer.from(signatureHex, 'hex'),
      );
      if (!ok) return sendJson(res, 401, { error: 'bad signature' });
      const { token, expiresAt } = this.config.devices!.issueSessionToken(deviceId);
      return sendJson(res, 200, { token, expiresAt });
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
  }

  // ─── Static webapp ────────────────────────────────────────────────────

  private isWebappEnabled(): boolean {
    const w = this.config.webapp;
    if (!w) return false;
    if (w.enabled === false) return false;
    return existsSync(w.dir);
  }

  private handleUiAsset(pathname: string, res: ServerResponse): void {
    const dir = this.config.webapp!.dir;
    if (pathname === '/ui' || pathname === '/ui/') {
      return sendFile(res, join(dir, 'index.html'));
    }
    // Strip the `/ui/` prefix and resolve under dir. `normalize` + prefix
    // check defuses `..` traversal attempts.
    const rel = pathname.slice('/ui/'.length);
    const candidate = normalize(join(dir, rel));
    const dirResolved = resolvePath(dir);
    if (!candidate.startsWith(dirResolved)) {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return sendFile(res, candidate);
    }
    // SPA fallback: serve index.html so Lit's hash router can take over.
    return sendFile(res, join(dir, 'index.html'));
  }
}

function parseSubprotocols(header: string | string[] | undefined): string[] {
  if (!header) return [];
  const flat = Array.isArray(header) ? header.join(',') : header;
  return flat
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isUiPath(pathname: string): boolean {
  return pathname === '/ui' || pathname.startsWith('/ui/');
}

// Raw ed25519 pubkey → Node KeyObject via SPKI DER wrapper. The 12-byte
// prefix is the fixed SPKI SubjectPublicKeyInfo for ed25519.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function verifyEd25519(pubHex: string, message: Buffer, signature: Buffer): boolean {
  try {
    const raw = Buffer.from(pubHex, 'hex');
    if (raw.length !== 32) return false;
    const spki = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return cryptoVerify(null, message, key, signature);
  } catch {
    return false;
  }
}

function sendFile(res: ServerResponse, path: string): void {
  if (!existsSync(path)) {
    return sendJson(res, 404, { error: 'not found' });
  }
  res.writeHead(200, {
    'Content-Type': contentTypeFor(path),
    'Cache-Control': 'no-cache',
  });
  createReadStream(path).pipe(res);
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function contentTypeFor(path: string): string {
  const ext = extname(path).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
