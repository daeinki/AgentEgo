import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceAuthStore } from './device-auth.js';
import { TokenAuth } from './auth.js';

const PUBKEY_A = 'a'.repeat(64);
const PUBKEY_B = 'b'.repeat(64);

describe('DeviceAuthStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'device-auth-'));
    filePath = join(dir, 'devices.json');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('enrolls a device and returns a stable deviceId', () => {
    const store = new DeviceAuthStore({ filePath });
    const a = store.enroll(PUBKEY_A, 'laptop');
    const b = store.enroll(PUBKEY_A, 'laptop (renamed)');
    expect(a.deviceId).toBe(b.deviceId);
    expect(b.name).toBe('laptop (renamed)');
  });

  it('rejects a malformed pubkey', () => {
    const store = new DeviceAuthStore({ filePath });
    expect(() => store.enroll('short', 'x')).toThrow();
  });

  it('issues and verifies a session token', () => {
    const store = new DeviceAuthStore({ filePath });
    const dev = store.enroll(PUBKEY_A, 'laptop');
    const { token } = store.issueSessionToken(dev.deviceId);
    const res = store.verifySessionToken(token);
    expect(res).toEqual({ ok: true, deviceId: dev.deviceId });
  });

  it('rejects an expired session token', () => {
    let clock = 1_000_000;
    const store = new DeviceAuthStore({
      filePath,
      sessionTtlMs: 10,
      now: () => clock,
    });
    const dev = store.enroll(PUBKEY_A, 'laptop');
    const { token } = store.issueSessionToken(dev.deviceId);
    clock += 1000;
    const res = store.verifySessionToken(token);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('expired');
  });

  it('rejects a tampered session token', () => {
    const store = new DeviceAuthStore({ filePath });
    const dev = store.enroll(PUBKEY_A, 'laptop');
    const { token } = store.issueSessionToken(dev.deviceId);
    const parts = token.split('.');
    parts[parts.length - 1] =
      parts[parts.length - 1]!.slice(0, -2) + '00';
    const res = store.verifySessionToken(parts.join('.'));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('bad signature');
  });

  it('rejects a session token after device revoke', () => {
    const store = new DeviceAuthStore({ filePath });
    const dev = store.enroll(PUBKEY_A, 'laptop');
    const { token } = store.issueSessionToken(dev.deviceId);
    store.revoke(dev.deviceId);
    const res = store.verifySessionToken(token);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('device revoked');
  });

  it('issues unique challenges and rejects replay', () => {
    const store = new DeviceAuthStore({ filePath });
    const dev = store.enroll(PUBKEY_A, 'laptop');
    const c1 = store.issueChallenge(dev.deviceId);
    const c2 = store.issueChallenge(dev.deviceId);
    expect(c1.challenge).not.toBe(c2.challenge);

    const ok = store.consumeChallenge(c1.challenge, dev.deviceId);
    expect(ok.device.deviceId).toBe(dev.deviceId);
    expect(() => store.consumeChallenge(c1.challenge, dev.deviceId)).toThrow();
  });

  it('pins a challenge to a specific deviceId when issued that way', () => {
    const store = new DeviceAuthStore({ filePath });
    const a = store.enroll(PUBKEY_A, 'a');
    const b = store.enroll(PUBKEY_B, 'b');
    const c = store.issueChallenge(a.deviceId);
    expect(() => store.consumeChallenge(c.challenge, b.deviceId)).toThrow();
  });

  it('persists devices across instances', () => {
    const s1 = new DeviceAuthStore({ filePath });
    const dev = s1.enroll(PUBKEY_A, 'laptop');
    const s2 = new DeviceAuthStore({ filePath });
    expect(s2.getDevice(dev.deviceId)?.name).toBe('laptop');
  });

  it('persists the session secret across instances (tokens survive restart)', () => {
    const s1 = new DeviceAuthStore({ filePath });
    const dev = s1.enroll(PUBKEY_A, 'laptop');
    const { token } = s1.issueSessionToken(dev.deviceId);
    const s2 = new DeviceAuthStore({ filePath });
    expect(s2.verifySessionToken(token).ok).toBe(true);
  });
});

describe('TokenAuth × DeviceAuthStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'device-auth-token-'));
    filePath = join(dir, 'devices.json');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('master token still works when a secondary verifier is attached', () => {
    const store = new DeviceAuthStore({ filePath });
    const auth = new TokenAuth({ tokens: ['master-secret'] }, store);
    const res = auth.verifyBearer('Bearer master-secret');
    expect(res.ok).toBe(true);
    expect(res.source).toBe('master');
  });

  it('falls back to device session token when master mismatches', () => {
    const store = new DeviceAuthStore({ filePath });
    const dev = store.enroll(PUBKEY_A, 'laptop');
    const { token } = store.issueSessionToken(dev.deviceId);

    const auth = new TokenAuth({ tokens: ['master-secret'] }, store);
    const res = auth.verifyBearer(`Bearer ${token}`);
    expect(res.ok).toBe(true);
    expect(res.source).toBe('device');
    expect(res.deviceId).toBe(dev.deviceId);
  });

  it('rejects both unknown token and unknown device token', () => {
    const store = new DeviceAuthStore({ filePath });
    const auth = new TokenAuth({ tokens: ['master-secret'] }, store);
    expect(auth.verifyBearer('Bearer nope').ok).toBe(false);
    expect(auth.verifyBearer('Bearer v1.aaa.bbb.ccc.ddd').ok).toBe(false);
  });
});

