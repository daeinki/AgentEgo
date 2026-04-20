import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Device-identity authentication (OpenClaw-style) for browser clients.
 *
 * Flow:
 *  1. Admin provides a one-time bootstrap Bearer token (the master token from
 *     `AuthConfig.tokens`). Browser POSTs its ed25519 pubkey to `/device/enroll`.
 *  2. On reconnect, browser requests a nonce from `/device/challenge`, signs it
 *     with its ed25519 private key (held in IndexedDB), then POSTs to
 *     `/device/assert`. Server returns a short-lived session token that is
 *     accepted by `TokenAuth.verifyBearer` alongside the master token.
 *
 * Signature verification is performed by callers (the HTTP route layer) using
 * `@noble/ed25519` — kept out of this module so the control-plane doesn't take
 * a new dependency. This store only handles persistence, challenge issuance,
 * and session-token signing.
 */

export interface DeviceRecord {
  deviceId: string;
  publicKeyHex: string;
  name: string;
  enrolledAt: number;
  lastSeenAt?: number;
}

interface ChallengeRecord {
  challenge: string; // hex
  deviceId?: string; // optional pinning (if requester supplied deviceId)
  expiresAt: number;
}

export interface DeviceAuthStoreOptions {
  /** Path to JSON file. Parent directory is created on first write. */
  filePath: string;
  /**
   * HMAC key for signing session tokens. 32 bytes recommended. If omitted, a
   * random key is generated on first use and persisted alongside devices.
   */
  sessionSecret?: Buffer;
  /** Session token TTL in ms. Default 1 hour. */
  sessionTtlMs?: number;
  /** Challenge TTL in ms. Default 2 minutes. */
  challengeTtlMs?: number;
  /** Now function — overridable for tests. */
  now?: () => number;
}

interface FileShape {
  version: 1;
  sessionSecretHex: string;
  devices: DeviceRecord[];
}

export interface ChallengeIssue {
  challenge: string;
  expiresAt: number;
}

export interface SessionTokenVerifyResult {
  ok: boolean;
  deviceId?: string;
  reason?: string;
}

const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;
const DEFAULT_CHALLENGE_TTL_MS = 2 * 60 * 1000;

export class DeviceAuthStore {
  private readonly filePath: string;
  private readonly sessionTtlMs: number;
  private readonly challengeTtlMs: number;
  private readonly now: () => number;
  private sessionSecret: Buffer;
  private devices: Map<string, DeviceRecord>;
  private readonly challenges = new Map<string, ChallengeRecord>();

  constructor(opts: DeviceAuthStoreOptions) {
    this.filePath = opts.filePath;
    this.sessionTtlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.challengeTtlMs = opts.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS;
    this.now = opts.now ?? (() => Date.now());

    const loaded = this.loadFromDisk();
    this.sessionSecret = opts.sessionSecret ?? loaded.secret;
    this.devices = new Map(loaded.devices.map((d) => [d.deviceId, d]));
    if (!loaded.persistedSecret && !opts.sessionSecret) {
      this.persist();
    }
  }

  listDevices(): readonly DeviceRecord[] {
    return [...this.devices.values()];
  }

  getDevice(deviceId: string): DeviceRecord | undefined {
    return this.devices.get(deviceId);
  }

  /**
   * Register a new device given its ed25519 public key (64 hex chars = 32B).
   * Returns the assigned deviceId. The caller is responsible for enforcing
   * that the request carried a valid bootstrap (master) Bearer token.
   */
  enroll(publicKeyHex: string, name: string): DeviceRecord {
    if (!/^[0-9a-f]{64}$/i.test(publicKeyHex)) {
      throw new Error('publicKeyHex must be 32 bytes (64 hex chars)');
    }
    const trimmedName = name.trim().slice(0, 64) || 'unnamed';
    const existing = [...this.devices.values()].find(
      (d) => d.publicKeyHex.toLowerCase() === publicKeyHex.toLowerCase(),
    );
    if (existing) {
      existing.name = trimmedName;
      existing.lastSeenAt = this.now();
      this.persist();
      return existing;
    }
    const record: DeviceRecord = {
      deviceId: randomUUID(),
      publicKeyHex: publicKeyHex.toLowerCase(),
      name: trimmedName,
      enrolledAt: this.now(),
    };
    this.devices.set(record.deviceId, record);
    this.persist();
    return record;
  }

  revoke(deviceId: string): boolean {
    const removed = this.devices.delete(deviceId);
    if (removed) this.persist();
    return removed;
  }

  /**
   * Issue a fresh challenge. If `deviceId` is provided the challenge is
   * pinned to that device — `/device/assert` must then be called with the
   * same deviceId. Unpinned challenges can be used by any enrolled device
   * that can produce a valid signature.
   */
  issueChallenge(deviceId?: string): ChallengeIssue {
    this.gcChallenges();
    const challenge = randomBytes(32).toString('hex');
    const rec: ChallengeRecord = {
      challenge,
      expiresAt: this.now() + this.challengeTtlMs,
    };
    if (deviceId) rec.deviceId = deviceId;
    this.challenges.set(challenge, rec);
    return { challenge, expiresAt: rec.expiresAt };
  }

  /**
   * Consume a challenge, asserting that it was issued recently and matches
   * the deviceId (if pinned). Returns the record — caller must still verify
   * the ed25519 signature against device.publicKeyHex.
   */
  consumeChallenge(
    challenge: string,
    deviceId: string,
  ): { device: DeviceRecord } {
    const rec = this.challenges.get(challenge);
    if (!rec) throw new Error('unknown or expired challenge');
    this.challenges.delete(challenge);
    if (rec.expiresAt < this.now()) throw new Error('challenge expired');
    if (rec.deviceId && rec.deviceId !== deviceId) {
      throw new Error('challenge not issued for this device');
    }
    const device = this.devices.get(deviceId);
    if (!device) throw new Error('device not enrolled');
    return { device };
  }

  /**
   * Mint a signed session token. Format:
   *   `v1.<deviceIdB64>.<expiryB64>.<rand>.<hmacHex>`
   * All components are URL-safe base64 except hmac (lowercase hex).
   */
  issueSessionToken(deviceId: string): { token: string; expiresAt: number } {
    const device = this.devices.get(deviceId);
    if (!device) throw new Error('device not enrolled');
    device.lastSeenAt = this.now();
    this.persist();

    const expiresAt = this.now() + this.sessionTtlMs;
    const payload = [
      'v1',
      b64(Buffer.from(deviceId)),
      b64(Buffer.from(String(expiresAt))),
      b64(randomBytes(8)),
    ];
    const mac = this.sign(payload.join('.'));
    return { token: `${payload.join('.')}.${mac}`, expiresAt };
  }

  /**
   * Verify a session token. Returns `{ok: true, deviceId}` when valid, else
   * `{ok: false, reason}`. Intended to be called from
   * `TokenAuth.verifyBearer` as a fallback after master-token matching.
   */
  verifySessionToken(token: string): SessionTokenVerifyResult {
    const parts = token.split('.');
    if (parts.length !== 5 || parts[0] !== 'v1') {
      return { ok: false, reason: 'malformed' };
    }
    const [, deviceB64, expiryB64, , macHex] = parts as [
      string,
      string,
      string,
      string,
      string,
    ];
    const body = parts.slice(0, 4).join('.');
    const expected = this.sign(body);
    const a = Buffer.from(macHex, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, reason: 'bad signature' };
    }
    const expiresAt = Number(unb64(expiryB64).toString('utf8'));
    if (!Number.isFinite(expiresAt) || expiresAt < this.now()) {
      return { ok: false, reason: 'expired' };
    }
    const deviceId = unb64(deviceB64).toString('utf8');
    if (!this.devices.has(deviceId)) {
      return { ok: false, reason: 'device revoked' };
    }
    return { ok: true, deviceId };
  }

  // ── internals ──────────────────────────────────────────────────────────

  private sign(body: string): string {
    return createHmac('sha256', this.sessionSecret).update(body).digest('hex');
  }

  private gcChallenges(): void {
    const now = this.now();
    for (const [k, rec] of this.challenges) {
      if (rec.expiresAt < now) this.challenges.delete(k);
    }
  }

  private loadFromDisk(): {
    secret: Buffer;
    devices: DeviceRecord[];
    persistedSecret: boolean;
  } {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as FileShape;
      if (parsed?.version !== 1 || typeof parsed.sessionSecretHex !== 'string') {
        throw new Error('unexpected shape');
      }
      return {
        secret: Buffer.from(parsed.sessionSecretHex, 'hex'),
        devices: Array.isArray(parsed.devices) ? parsed.devices : [],
        persistedSecret: true,
      };
    } catch {
      return {
        secret: randomBytes(32),
        devices: [],
        persistedSecret: false,
      };
    }
  }

  private persist(): void {
    const shape: FileShape = {
      version: 1,
      sessionSecretHex: this.sessionSecret.toString('hex'),
      devices: [...this.devices.values()],
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(shape, null, 2), {
      mode: 0o600,
    });
  }
}

function b64(buf: Buffer): string {
  return buf.toString('base64url');
}

function unb64(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}
