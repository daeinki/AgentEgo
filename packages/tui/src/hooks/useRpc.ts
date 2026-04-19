import { useEffect, useRef, useState } from 'react';
import { RpcClient } from '../lib/rpc-client.js';

export type RpcStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface UseRpcOptions {
  url: string;
  authToken: string;
}

export interface UseRpcResult {
  client: RpcClient | null;
  status: RpcStatus;
  error: string | null;
}

/**
 * Opens a single RpcClient for the lifetime of the component tree and
 * exposes its connection status. Reconnects are handled inside the client;
 * we just surface them as status transitions.
 */
export function useRpc({ url, authToken }: UseRpcOptions): UseRpcResult {
  const [status, setStatus] = useState<RpcStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const clientRef = useRef<RpcClient | null>(null);

  useEffect(() => {
    const client = new RpcClient({
      url,
      authToken,
      onOpen: () => setStatus('open'),
      onClose: ({ willReconnect }) => {
        setStatus(willReconnect ? 'reconnecting' : 'closed');
      },
    });
    clientRef.current = client;
    client.connect().catch((err: Error) => {
      setError(err.message);
      setStatus('closed');
    });
    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [url, authToken]);

  return { client: clientRef.current, status, error };
}
