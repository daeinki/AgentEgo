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
}

export class TokenAuth {
  private readonly tokens: Uint8Array[];

  constructor(config: AuthConfig) {
    this.tokens = config.tokens.map((t) => Buffer.from(t, 'utf-8'));
    if (this.tokens.length === 0) {
      throw new Error('TokenAuth requires at least one token');
    }
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
        return { ok: true };
      }
    }
    return { ok: false, reason: 'invalid token' };
  }
}
