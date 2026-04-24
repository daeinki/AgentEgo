export { SessionStore } from './session/store.js';
export { ControlPlaneSessionManager } from './session/manager.js';
export type { SessionManagerConfig } from './session/manager.js';
export { Router, RuleRouter } from './session/router.js';
export type { RouterOptions } from './session/router.js';
export { RateLimiter } from './gateway/rate-limiter.js';
export type { RateLimiterConfig } from './gateway/rate-limiter.js';
export { TokenAuth } from './gateway/auth.js';
export type { AuthConfig, AuthDecision, SecondaryVerifier } from './gateway/auth.js';
export { DeviceAuthStore } from './gateway/device-auth.js';
export type {
  DeviceRecord,
  DeviceAuthStoreOptions,
  ChallengeIssue,
  SessionTokenVerifyResult,
} from './gateway/device-auth.js';
export { ApiGateway } from './gateway/server.js';
export type {
  GatewayConfig,
  MessageHandler,
  MessageHandlerContext,
  UpgradeMount,
  WebappServeConfig,
} from './gateway/server.js';
export {
  InboundEnvelope,
  OutboundEnvelope,
  parseInbound,
  encodeOutbound,
} from './gateway/envelope.js';
export { PlatformChannelRegistry } from './gateway/platform-channel-registry.js';
export type { ChannelDescriptor } from './gateway/platform-channel-registry.js';
