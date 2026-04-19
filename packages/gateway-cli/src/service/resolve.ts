import { platform as osPlatform } from 'node:os';
import { LaunchdAdapter } from './launchd.js';
import { SchtasksAdapter } from './schtasks.js';
import { SystemdUserAdapter } from './systemd-user.js';
import type { ServiceAdapter, ServicePlatform } from './types.js';

/**
 * Pick the right ServiceAdapter for the current OS. Throws on unsupported
 * platforms (e.g. FreeBSD, AIX) rather than guessing.
 */
export function resolveServiceAdapter(override?: ServicePlatform): ServiceAdapter {
  const target = override ?? currentPlatform();
  switch (target) {
    case 'windows':
      return new SchtasksAdapter();
    case 'darwin':
      return new LaunchdAdapter();
    case 'linux':
      return new SystemdUserAdapter();
    default:
      throw new Error(`unsupported platform: ${target}`);
  }
}

export function currentPlatform(): ServicePlatform {
  const p = osPlatform();
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'darwin';
  if (p === 'linux') return 'linux';
  throw new Error(`unsupported OS for service installation: ${p}`);
}

/** Canonical service label per platform (follows OS naming conventions). */
export function defaultServiceLabel(target: ServicePlatform = currentPlatform()): string {
  switch (target) {
    case 'windows':
      return 'AgentPlatformGateway';
    case 'darwin':
      return 'com.agent-platform.gateway';
    case 'linux':
      return 'agent-platform-gateway';
  }
}
