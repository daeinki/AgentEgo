export {
  JSONRPC_VERSION,
  RpcError,
  RpcErrorCode,
  encodeFrame,
  errorFrame,
  notification,
  parseInbound,
  successFrame,
} from './rpc/protocol.js';
export type {
  JsonRpcErrorFrame,
  JsonRpcErrorPayload,
  JsonRpcId,
  JsonRpcInbound,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccess,
  ParseResult,
  ParsedInbound,
  RpcErrorCodeValue,
} from './rpc/protocol.js';

export { RpcServer } from './rpc/server.js';
export type { RpcContext, RpcHandler, RpcServerOptions } from './rpc/server.js';

export { buildRpcMethods } from './rpc/methods.js';
export type { RpcDeps } from './rpc/methods.js';

export { mountRpcOnGateway } from './lifecycle/foreground.js';
export type { MountedGateway, MountRpcOptions } from './lifecycle/foreground.js';

export { resolveStateDir, resolveGatewayPaths } from './lifecycle/paths.js';
export type { GatewayPaths } from './lifecycle/paths.js';

export {
  clearPidFile,
  isProcessAlive,
  readPidFile,
  readPortFile,
  resolveRunning,
  writePidFile,
  writePortFile,
} from './lifecycle/pidfile.js';
export type { PidRecord } from './lifecycle/pidfile.js';

export {
  AlreadyRunningError,
  defaultDaemonCommand,
  detachGateway,
} from './lifecycle/detach.js';
export type { DetachOptions, DetachResult } from './lifecycle/detach.js';

export {
  currentPlatform,
  defaultServiceLabel,
  resolveServiceAdapter,
} from './service/resolve.js';
export type {
  InstallOptions,
  ServiceAdapter,
  ServicePlatform,
  ServiceStatus,
} from './service/types.js';
export { SchtasksAdapter } from './service/schtasks.js';
export { LaunchdAdapter } from './service/launchd.js';
export { SystemdUserAdapter } from './service/systemd-user.js';
