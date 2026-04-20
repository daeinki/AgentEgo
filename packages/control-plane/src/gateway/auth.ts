import { timingSafeEqual } from 'node:crypto';

export interface AuthConfig {
  /**
   * Shared secret tokens. Any of these is accepted as bearer token. Devices
   * are pre-provisioned with a token; full JWT/paring protocol comes in Phase 4.
   */
  tokens: readonly string[];
}

export interface AuthDecision {
  ok: boolean;
  reason?: string;
  /** When the token is a device-session token, the enrolled deviceId. */
  deviceId?: string;
  /** Source of the successful match — useful for audit logs. */
  source?: 'master' | 'device';
}

/**
 * Optional secondary verifier. When configured, tokens that don't match the
 * master token list are passed to `verifySessionToken`. Used to plug in
 * DeviceAuthStore without forcing a dep from auth.ts → device-auth.ts.
 */
export interface SecondaryVerifier {
  verifySessionToken(token: string): {
    ok: boolean;
    deviceId?: string;
    reason?: string;
  };
}

export class TokenAuth {
  private readonly tokens: Uint8Array[];
  private secondary: SecondaryVerifier | undefined;

  constructor(config: AuthConfig, secondary?: SecondaryVerifier) {
    this.tokens = config.tokens.map((t) => Buffer.from(t, 'utf-8'));
    if (this.tokens.length === 0) {
      throw new Error('TokenAuth requires at least one token');
    }
    this.secondary = secondary;
  }

  /** Attach a secondary verifier (e.g. DeviceAuthStore) after construction. */
  setSecondaryVerifier(verifier: SecondaryVerifier | undefined): void {
    this.secondary = verifier;
  }

  verifyBearer(authorizationHeader: string | undefined | null): AuthDecision {
    if (!authorizationHeader) return { ok: false, reason: 'missing Authorization header' };
    const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
    if (!match || !match[1]) return { ok: false, reason: 'bearer token malformed' };
    return this.verifyToken(match[1]);
  }

  verifyToken(token: string): AuthDecision {
    const candidate = Buffer.from(token, 'utf-8');
    for (const known of this.tokens) {
      if (candidate.length === known.length && timingSafeEqual(candidate, known)) {
        return { ok: true, source: 'master' };
      }
    }
    if (this.secondary) {
      const res = this.secondary.verifySessionToken(token);
      if (res.ok) {
        const decision: AuthDecision = { ok: true, source: 'device' };
        if (res.deviceId) decision.deviceId = res.deviceId;
        return decision;
      }
    }
    return { ok: false, reason: 'invalid token' };
  }
}
