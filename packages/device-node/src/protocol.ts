/**
 * Device-node protocol (platform ↔ device envelope format).
 *
 * Devices (macOS, iOS, Android shells) pair once with a platform instance via
 * an out-of-band pairing code, then establish a persistent WebSocket. The
 * envelope below models the common events — pairing, heartbeat, push
 * notifications, user-initiated relay of an inbound message.
 *
 * Kept plain JSON + tagged unions so any language on the device side can
 * implement it without a code-gen tool.
 */

export interface DeviceInfo {
  deviceId: string;
  platform: 'macos' | 'ios' | 'android' | 'linux' | 'windows';
  osVersion?: string;
  appVersion?: string;
  displayName?: string;
}

export type DeviceInbound =
  | {
      type: 'hello';
      deviceId: string;
      pairingCode: string;
      info: DeviceInfo;
    }
  | {
      type: 'heartbeat';
      sentAt: number;
      batteryLevel?: number;
    }
  | {
      type: 'message';
      /**
       * Opaque payload from the user (e.g. they typed something in the
       * device-side shell) to be relayed into the agent platform.
       */
      text: string;
      clientMessageId?: string;
    }
  | {
      type: 'ack';
      /**
       * Acknowledges a previously-sent `DeviceOutbound.push` with the given id.
       */
      pushId: string;
      receivedAt: number;
    };

export type DeviceOutbound =
  | {
      type: 'paired';
      deviceId: string;
      /**
       * Platform-issued long-lived token the device stores locally and
       * includes in subsequent WS reconnects (in the initial `hello`).
       */
      sessionToken: string;
    }
  | {
      type: 'pair_failed';
      reason: string;
    }
  | {
      type: 'heartbeat_ack';
      sentAt: number;
      serverTime: number;
    }
  | {
      type: 'push';
      pushId: string;
      /**
       * Human-readable notification body. Clients render this in the OS
       * notification center.
       */
      title: string;
      body: string;
      /**
       * Optional action hint — the client may show a primary button.
       */
      action?: { label: string; payload: string };
    }
  | {
      type: 'error';
      code: string;
      message: string;
    };

export function parseInbound(raw: string): DeviceInbound | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: 'invalid JSON' };
  }
  if (!isObject(parsed)) return { error: 'envelope not an object' };
  const rec = parsed as Record<string, unknown>;
  const t = rec['type'];
  if (t === 'hello') {
    if (
      typeof rec['deviceId'] !== 'string' ||
      typeof rec['pairingCode'] !== 'string' ||
      !isObject(rec['info'])
    ) {
      return { error: 'hello: missing fields' };
    }
    const info = rec['info'] as Record<string, unknown>;
    if (typeof info['deviceId'] !== 'string' || typeof info['platform'] !== 'string') {
      return { error: 'hello.info: missing deviceId/platform' };
    }
    return {
      type: 'hello',
      deviceId: rec['deviceId'],
      pairingCode: rec['pairingCode'],
      info: info as unknown as DeviceInfo,
    };
  }
  if (t === 'heartbeat' && typeof rec['sentAt'] === 'number') {
    const out: DeviceInbound = { type: 'heartbeat', sentAt: rec['sentAt'] };
    if (typeof rec['batteryLevel'] === 'number') {
      (out as { batteryLevel?: number }).batteryLevel = rec['batteryLevel'];
    }
    return out;
  }
  if (t === 'message' && typeof rec['text'] === 'string') {
    const out: DeviceInbound = { type: 'message', text: rec['text'] };
    if (typeof rec['clientMessageId'] === 'string') {
      (out as { clientMessageId?: string }).clientMessageId = rec['clientMessageId'];
    }
    return out;
  }
  if (
    t === 'ack' &&
    typeof rec['pushId'] === 'string' &&
    typeof rec['receivedAt'] === 'number'
  ) {
    return { type: 'ack', pushId: rec['pushId'], receivedAt: rec['receivedAt'] };
  }
  return { error: `unknown or malformed envelope type: ${String(t)}` };
}

export function encodeOutbound(msg: DeviceOutbound): string {
  return JSON.stringify(msg);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
