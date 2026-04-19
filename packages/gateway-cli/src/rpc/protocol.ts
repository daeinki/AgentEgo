/**
 * JSON-RPC 2.0 envelope types + parsing helpers.
 *
 * Spec: https://www.jsonrpc.org/specification
 *
 * Scope: Request / Response / Error / Notification frames over a single
 * WebSocket connection. Batch requests are NOT supported by this server
 * (MVP). Notifications flow server→client (e.g. streaming `chat.delta`).
 */

export const JSONRPC_VERSION = '2.0' as const;

export type JsonRpcId = string | number;

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  method: string;
  params?: P;
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  result: R;
}

export interface JsonRpcErrorFrame {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId | null;
  error: JsonRpcErrorPayload;
}

export interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccess<R> | JsonRpcErrorFrame;

export type JsonRpcInbound = JsonRpcRequest | JsonRpcNotification;

/** Standard JSON-RPC 2.0 error codes. */
export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // Implementation-defined (-32000 to -32099):
  Unauthorized: -32001,
  RateLimited: -32002,
  NotFound: -32003,
  Aborted: -32004,
} as const;
export type RpcErrorCodeValue = (typeof RpcErrorCode)[keyof typeof RpcErrorCode];

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }

  toPayload(): JsonRpcErrorPayload {
    const payload: JsonRpcErrorPayload = { code: this.code, message: this.message };
    if (this.data !== undefined) payload.data = this.data;
    return payload;
  }
}

// ─── Parsing ────────────────────────────────────────────────────────────────

export interface ParsedInbound {
  frame: JsonRpcInbound;
  isNotification: boolean;
}

export type ParseResult =
  | { ok: true; parsed: ParsedInbound }
  | { ok: false; error: JsonRpcErrorFrame };

/** Parse a raw WebSocket text frame into a JSON-RPC request or notification. */
export function parseInbound(raw: string): ParseResult {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: errorFrame(null, RpcErrorCode.ParseError, 'invalid JSON'),
    };
  }
  if (!isPlainObject(obj)) {
    return {
      ok: false,
      error: errorFrame(null, RpcErrorCode.InvalidRequest, 'request must be an object'),
    };
  }
  if (obj['jsonrpc'] !== JSONRPC_VERSION) {
    return {
      ok: false,
      error: errorFrame(null, RpcErrorCode.InvalidRequest, 'jsonrpc must be "2.0"'),
    };
  }
  if (typeof obj['method'] !== 'string') {
    return {
      ok: false,
      error: errorFrame(pickId(obj), RpcErrorCode.InvalidRequest, 'method must be a string'),
    };
  }
  const id = obj['id'];
  const isNotification = id === undefined;
  if (!isNotification && typeof id !== 'string' && typeof id !== 'number') {
    return {
      ok: false,
      error: errorFrame(null, RpcErrorCode.InvalidRequest, 'id must be string or number'),
    };
  }

  const frame: JsonRpcInbound = isNotification
    ? {
        jsonrpc: JSONRPC_VERSION,
        method: obj['method'],
        ...(obj['params'] !== undefined ? { params: obj['params'] } : {}),
      }
    : {
        jsonrpc: JSONRPC_VERSION,
        id: id as JsonRpcId,
        method: obj['method'],
        ...(obj['params'] !== undefined ? { params: obj['params'] } : {}),
      };

  return { ok: true, parsed: { frame, isNotification } };
}

export function encodeFrame(frame: JsonRpcResponse | JsonRpcNotification): string {
  return JSON.stringify(frame);
}

export function successFrame<R>(id: JsonRpcId, result: R): JsonRpcSuccess<R> {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function errorFrame(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcErrorFrame {
  const err: JsonRpcErrorPayload = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: JSONRPC_VERSION, id, error: err };
}

export function notification<P>(method: string, params: P): JsonRpcNotification<P> {
  return { jsonrpc: JSONRPC_VERSION, method, ...(params !== undefined ? { params } : {}) };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pickId(obj: Record<string, unknown>): JsonRpcId | null {
  const id = obj['id'];
  if (typeof id === 'string' || typeof id === 'number') return id;
  return null;
}
