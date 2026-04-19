import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  readPidFile,
  readPortFile,
  resolveRunning,
  type PidRecord,
} from './pidfile.js';
import type { GatewayPaths } from './paths.js';

export interface DetachOptions {
  paths: GatewayPaths;
  /**
   * Command to exec for the daemon. Example:
   *   { command: '/usr/bin/node', args: ['/app/dist/program.js', 'gateway', 'start', '--foreground'] }
   * The CLI is responsible for resolving the right node + entrypoint (tsx
   * vs built .js). See `resolveDaemonCommand` for the default heuristic.
   */
  command: { command: string; args: string[] };
  /** Environment overrides merged with process.env. */
  env?: Record<string, string>;
  /** How long to wait for the child to publish its port (ms). Default 15_000. */
  readyTimeoutMs?: number;
}

export interface DetachResult {
  pid: number;
  port: number;
}

/**
 * Fork a detached daemon that outlives the calling CLI. Writes a PID file and
 * waits for the child to publish its port file (which foreground mode writes
 * on boot). Throws if a gateway is already running.
 *
 * stdio is piped to log files under `paths.logsDir` (the foreground entry
 * inherits these fds). Stdin is ignored.
 */
export async function detachGateway(options: DetachOptions): Promise<DetachResult> {
  const existing = await resolveRunning(options.paths);
  if (existing) {
    throw new AlreadyRunningError(existing);
  }

  await mkdir(options.paths.logsDir, { recursive: true });
  await mkdir(dirname(options.paths.pidFile), { recursive: true });

  const outHandle = await open(options.paths.stdoutLog, 'a');
  const errHandle = await open(options.paths.stderrLog, 'a');

  try {
    const child = spawn(options.command.command, options.command.args, {
      detached: true,
      stdio: ['ignore', outHandle.fd, errHandle.fd],
      env: { ...process.env, ...options.env },
      windowsHide: true,
    });

    if (!child.pid) {
      throw new Error('failed to spawn gateway daemon (no pid returned)');
    }

    // Detach so we don't keep the child tied to this event loop. The child's
    // foreground entry is responsible for writing the PID + port files —
    // doing it here from the parent would race the child's resolveRunning()
    // check and cause a false "already running" exit.
    child.unref();

    const port = await waitForPort(
      options.paths,
      options.readyTimeoutMs ?? 15_000,
    );

    // After the port file shows up, the child has also written the PID file.
    // Read it back so we return what the supervisor actually recorded.
    const record = await readPidFile(options.paths);
    return { pid: record?.pid ?? child.pid, port };
  } finally {
    // Closing our handles is safe — the child keeps them open via fd dup.
    await outHandle.close().catch(() => {});
    await errHandle.close().catch(() => {});
  }
}

export class AlreadyRunningError extends Error {
  constructor(public readonly record: PidRecord) {
    super(`gateway already running at pid ${record.pid} on port ${record.port}`);
    this.name = 'AlreadyRunningError';
  }
}

async function waitForPort(paths: GatewayPaths, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    const p = await readPortFile(paths);
    if (p && p > 0) return p;
    last = p ?? 0;
    await delay(200);
  }
  throw new Error(
    `gateway did not publish its port within ${timeoutMs}ms (last=${last}). ` +
      `Check ${paths.stderrLog} for startup errors.`,
  );
}

/**
 * Best-effort resolver for the daemon command. CLI callers that want custom
 * behavior should build their own {command, args} instead.
 *
 * Strategy:
 *  - If argv[1] is a .ts file → `tsx <argv[1]>` (dev mode)
 *  - Otherwise → `process.execPath <argv[1]>` (built mode)
 */
export function defaultDaemonCommand(extraArgs: string[] = []): {
  command: string;
  args: string[];
} {
  const entry = process.argv[1] ?? '';
  const isTs = entry.endsWith('.ts') || entry.endsWith('.tsx');
  if (isTs) {
    // Use `npx tsx` so we don't have to guess the tsx path. Spawning through
    // a resolver shell on Windows is unreliable, so we rely on `process.execPath`
    // + the tsx CLI file resolved via require.resolve.
    // NOTE: dev-mode detach is brittle. Prefer running `pnpm --filter cli build`
    // and invoking the built entry. We warn in the CLI.
    return { command: process.execPath, args: ['--import', 'tsx/esm', entry, ...extraArgs] };
  }
  return { command: process.execPath, args: [entry, ...extraArgs] };
}
