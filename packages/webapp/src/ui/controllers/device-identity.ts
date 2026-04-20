import * as ed from '@noble/ed25519';
import { readJSON, writeJSON, writeString, readString } from '../../local-storage.js';

/**
 * Device identity (OpenClaw-style). Generates an ed25519 keypair on first
 * run, persists the private key in IndexedDB (never localStorage), and
 * handles challenge/assert against the gateway's `/device/*` endpoints.
 *
 * Public handshake:
 *   1. `enroll(bootstrapToken)` — called once when the user has the gateway's
 *      master Bearer token. Registers the pubkey; server returns a deviceId.
 *   2. `assert()` — called before every WebSocket connect. Fetches a
 *      challenge, signs it, posts the signature, receives a session token.
 *      The token is cached in-memory (NOT localStorage) until expiry.
 */

const LS_KEY_DEVICE_ID = 'deviceId';
const LS_KEY_PUBKEY = 'devicePubKeyHex';
const IDB_NAME = 'agent-platform';
const IDB_STORE = 'keys';
const IDB_PRIV_KEY_ID = 'devicePrivKey';

export interface EnrollResult {
  deviceId: string;
  name: string;
  enrolledAt: number;
}

export interface SessionToken {
  token: string;
  expiresAt: number;
}

export class DeviceIdentity {
  private cachedToken: SessionToken | null = null;
  private keyPair: { privKey: Uint8Array; pubKey: Uint8Array } | null = null;

  get deviceId(): string | null {
    return readString(LS_KEY_DEVICE_ID);
  }

  /** True iff this browser has completed enrollment. */
  async isEnrolled(): Promise<boolean> {
    return Boolean(this.deviceId) && Boolean(await this.loadPrivKey());
  }

  /**
   * Register this device with the gateway. Must be called once with the
   * master Bearer token before any other gateway calls can be authenticated.
   */
  async enroll(bootstrapToken: string, name = 'browser'): Promise<EnrollResult> {
    const pair = await this.ensureKeyPair();
    const publicKeyHex = toHex(pair.pubKey);

    const res = await fetch('/device/enroll', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bootstrapToken}`,
      },
      body: JSON.stringify({ publicKeyHex, name }),
    });
    if (!res.ok) {
      const body = await safeText(res);
      throw new Error(`enroll failed (${res.status}): ${body}`);
    }
    const data = (await res.json()) as EnrollResult;
    writeString(LS_KEY_DEVICE_ID, data.deviceId);
    writeString(LS_KEY_PUBKEY, publicKeyHex);
    return data;
  }

  /** Drop keys and the deviceId pointer. User must re-enroll next time. */
  async reset(): Promise<void> {
    this.cachedToken = null;
    this.keyPair = null;
    try {
      window.localStorage.removeItem(`ap:${LS_KEY_DEVICE_ID}`);
      window.localStorage.removeItem(`ap:${LS_KEY_PUBKEY}`);
    } catch {
      // ignore
    }
    await this.deletePrivKey();
  }

  /**
   * Return a valid session token, minting a new one if the current one is
   * expired or absent. Throws if the device isn't enrolled.
   */
  async assert(): Promise<SessionToken> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt - 30_000 > now) {
      return this.cachedToken;
    }
    const deviceId = this.deviceId;
    if (!deviceId) throw new Error('device not enrolled');
    const pair = await this.ensureKeyPair();

    const challengeRes = await fetch('/device/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId }),
    });
    if (!challengeRes.ok) {
      throw new Error(`challenge failed (${challengeRes.status})`);
    }
    const { challenge } = (await challengeRes.json()) as { challenge: string };

    const challengeBytes = fromHex(challenge);
    const signature = await ed.signAsync(challengeBytes, pair.privKey);
    const signatureHex = toHex(signature);

    const assertRes = await fetch('/device/assert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, challenge, signature: signatureHex }),
    });
    if (!assertRes.ok) {
      const body = await safeText(assertRes);
      throw new Error(`assert failed (${assertRes.status}): ${body}`);
    }
    const token = (await assertRes.json()) as SessionToken;
    this.cachedToken = token;
    return token;
  }

  // ── Key management ────────────────────────────────────────────────────

  private async ensureKeyPair(): Promise<{ privKey: Uint8Array; pubKey: Uint8Array }> {
    if (this.keyPair) return this.keyPair;
    const existing = await this.loadPrivKey();
    if (existing) {
      const pubKey = await ed.getPublicKeyAsync(existing);
      this.keyPair = { privKey: existing, pubKey };
      return this.keyPair;
    }
    const privKey = ed.utils.randomPrivateKey();
    const pubKey = await ed.getPublicKeyAsync(privKey);
    await this.savePrivKey(privKey);
    this.keyPair = { privKey, pubKey };
    return this.keyPair;
  }

  private async openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = window.indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
    });
  }

  private async loadPrivKey(): Promise<Uint8Array | null> {
    try {
      const db = await this.openDB();
      return await new Promise<Uint8Array | null>((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const store = tx.objectStore(IDB_STORE);
        const req = store.get(IDB_PRIV_KEY_ID);
        req.onsuccess = () => {
          const val = req.result as Uint8Array | undefined;
          resolve(val ?? null);
        };
        req.onerror = () => reject(req.error);
      });
    } catch {
      // Fallback path for environments without IndexedDB (tests). Read from
      // localStorage in that case — less secure but keeps enrollment usable.
      const raw = readJSON<string>('devicePrivKeyHex');
      return raw ? fromHex(raw) : null;
    }
  }

  private async savePrivKey(privKey: Uint8Array): Promise<void> {
    try {
      const db = await this.openDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        const req = store.put(privKey, IDB_PRIV_KEY_ID);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch {
      writeJSON('devicePrivKeyHex', toHex(privKey));
    }
  }

  private async deletePrivKey(): Promise<void> {
    try {
      const db = await this.openDB();
      await new Promise<void>((resolve) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(IDB_PRIV_KEY_ID);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    } catch {
      // ignore
    }
  }
}

function toHex(buf: Uint8Array): string {
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
