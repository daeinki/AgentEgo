import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

/**
 * Abstract container runtime. Docker is the primary target but anything that
 * can run a one-shot command in an isolated process with resource limits can
 * implement this (podman, gVisor, nerdctl, …). Tests use `MockContainerRuntime`.
 */
export interface ContainerRuntime {
  runOnce(opts: RunOptions): Promise<ContainerResult>;
}

export interface ResourceLimits {
  /**
   * CPU quota in "cores" (e.g. 0.5 = half a core). Converts to `--cpus` for Docker.
   */
  cpus?: number;
  /**
   * Memory in MB. Converts to `--memory`.
   */
  memoryMb?: number;
  /**
   * Whether the container has network access. Default: disabled.
   */
  networkEnabled?: boolean;
  /**
   * Read-only root filesystem.
   */
  readOnly?: boolean;
}

export interface RunOptions {
  image: string;
  command: string[];
  env?: Record<string, string>;
  cwd?: string;
  limits?: ResourceLimits;
  stdinData?: string;
  timeoutMs: number;
  /**
   * Docker `--security-opt` list, e.g. ['no-new-privileges:true'] or
   * ['seccomp=...']. gVisor users set the runtime via `runtime`.
   */
  securityOpts?: string[];
  /**
   * Container runtime to use (`runsc` for gVisor). Omit to use Docker default.
   */
  runtime?: string;
}

export interface ContainerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Default implementation shelling out to `docker run`. Each call spawns a
 * throwaway container with `--rm`. Safe for low-to-medium volume; high-volume
 * deployments would switch to a container pool.
 */
export class DockerContainerRuntime implements ContainerRuntime {
  constructor(private readonly dockerBinary = 'docker') {}

  async runOnce(opts: RunOptions): Promise<ContainerResult> {
    const args = buildDockerArgs(opts);
    return runChild(this.dockerBinary, args, opts.stdinData, opts.timeoutMs);
  }
}

export function buildDockerArgs(opts: RunOptions): string[] {
  const args = ['run', '--rm', '-i'];

  if (opts.runtime) args.push('--runtime', opts.runtime);

  const limits = opts.limits ?? {};
  if (limits.cpus !== undefined) args.push('--cpus', String(limits.cpus));
  if (limits.memoryMb !== undefined) args.push('--memory', `${limits.memoryMb}m`);
  if (limits.networkEnabled === false || limits.networkEnabled === undefined) {
    args.push('--network', 'none');
  }
  if (limits.readOnly !== false) {
    args.push('--read-only');
  }

  for (const so of opts.securityOpts ?? ['no-new-privileges:true']) {
    args.push('--security-opt', so);
  }

  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      args.push('-e', `${k}=${v}`);
    }
  }

  if (opts.cwd) args.push('-w', opts.cwd);

  args.push(opts.image, ...opts.command);
  return args;
}

async function runChild(
  bin: string,
  args: string[],
  stdinData: string | undefined,
  timeoutMs: number,
): Promise<ContainerResult> {
  const started = performance.now();
  return new Promise<ContainerResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({
        exitCode: -1,
        stdout: '',
        stderr: (err as Error).message,
        durationMs: performance.now() - started,
        timedOut: false,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout?.on('data', (buf: Buffer) => {
      stdout += buf.toString('utf-8');
    });
    child.stderr?.on('data', (buf: Buffer) => {
      stderr += buf.toString('utf-8');
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
        durationMs: performance.now() - started,
        timedOut,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        stdout,
        stderr: `${stderr}\n${err.message}`,
        durationMs: performance.now() - started,
        timedOut,
      });
    });

    if (stdinData !== undefined) {
      child.stdin?.end(stdinData);
    } else {
      child.stdin?.end();
    }
  });
}
