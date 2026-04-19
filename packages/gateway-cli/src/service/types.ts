/**
 * OS service adapters. Each platform has its own native supervisor
 * (launchd/systemd/schtasks); this module abstracts the minimal surface CLI
 * callers need: install a unit, remove it, start/stop/restart it, and query
 * whether it's currently running.
 *
 * Design notes:
 *  - PID files are NOT used in service mode. The OS supervisor owns the PID.
 *    `status()` therefore queries the supervisor directly (not our pidfile).
 *  - Each adapter writes log files the supervisor redirects stdio into — but
 *    these are distinct from the detach-mode log paths (we don't want the
 *    service and a manually-detached daemon to both append to the same file).
 *  - Install is idempotent: installing over an existing unit replaces it.
 */

export type ServicePlatform = 'windows' | 'darwin' | 'linux';

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  pid?: number;
  /** Native state label from the supervisor (e.g. 'Running', 'active (running)'). */
  raw?: string;
}

export interface InstallOptions {
  /** Canonical label used by the supervisor. Platform-specific conventions:
   *  - macOS: reverse-DNS (e.g. 'com.agent-platform.gateway')
   *  - Linux: systemd unit stem (e.g. 'agent-platform-gateway')
   *  - Windows: task name (e.g. 'AgentPlatformGateway')
   */
  label: string;
  /** Absolute path to the node binary. Usually `process.execPath`. */
  nodeBinary: string;
  /** Absolute path to the CLI entrypoint + the args to pass (e.g. `gateway start --foreground`). */
  entrypoint: string;
  entrypointArgs: string[];
  /** Env vars injected into the supervised process. */
  env: Record<string, string>;
  /** Stdout/stderr log targets for the supervisor to redirect into. */
  stdoutLog: string;
  stderrLog: string;
  /** Absolute path the supervisor should chdir into before exec. */
  workingDir: string;
}

export interface ServiceAdapter {
  readonly platform: ServicePlatform;
  install(opts: InstallOptions): Promise<void>;
  uninstall(label: string): Promise<void>;
  start(label: string): Promise<void>;
  stop(label: string): Promise<void>;
  restart(label: string): Promise<void>;
  status(label: string): Promise<ServiceStatus>;
}
