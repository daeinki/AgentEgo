import type { ApiGateway } from '@agent-platform/control-plane';
import { RpcServer } from '../rpc/server.js';
import { buildRpcMethods, type RpcDeps } from '../rpc/methods.js';

export interface MountedGateway {
  rpc: RpcServer;
  /** Resolves when the gateway begins shutting down (e.g. SIGINT or RPC). */
  waitForShutdown(): Promise<void>;
  /**
   * Explicitly trigger shutdown — closes RPC first so no more calls arrive,
   * then runs the caller-supplied `onShutdown` (typically PlatformHandles.shutdown).
   */
  stop(): Promise<void>;
}

export interface MountRpcOptions {
  gateway: ApiGateway;
  deps: Omit<RpcDeps, 'shutdown'>;
  /** Called when RPC or a signal initiates shutdown. Must be idempotent. */
  onShutdown: () => Promise<void>;
  /** RPC WebSocket path. Default: `/rpc`. */
  path?: string;
  /** If true, wires SIGINT/SIGTERM handlers on the current process. Default: true. */
  installSignalHandlers?: boolean;
}

/**
 * Build an RpcServer wired to the supplied deps, mount it on the ApiGateway,
 * and optionally install SIGINT/SIGTERM handlers that trigger graceful
 * shutdown. Returns a handle that resolves `waitForShutdown()` once shutdown
 * begins — callers typically `await handle.waitForShutdown()` in their
 * command's main function to keep the process alive.
 */
export function mountRpcOnGateway(options: MountRpcOptions): MountedGateway {
  const path = options.path ?? '/rpc';

  let stopping = false;
  let resolveShutdown: () => void = () => {};
  const shutdownPromise = new Promise<void>((r) => {
    resolveShutdown = r;
  });

  const triggerShutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await rpc.close();
    } catch {
      // best-effort
    }
    try {
      await options.onShutdown();
    } finally {
      resolveShutdown();
    }
  };

  const rpcDeps: RpcDeps = {
    ...options.deps,
    shutdown: triggerShutdown,
  };

  const rpc = new RpcServer({
    path,
    methods: buildRpcMethods(rpcDeps),
    onShutdownRequested: triggerShutdown,
  });

  options.gateway.mount(rpc);

  if (options.installSignalHandlers !== false) {
    const onSignal = (sig: NodeJS.Signals) => {
      process.stderr.write(`\n[gateway] received ${sig}, shutting down...\n`);
      void triggerShutdown();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }

  return {
    rpc,
    waitForShutdown: () => shutdownPromise,
    stop: triggerShutdown,
  };
}
