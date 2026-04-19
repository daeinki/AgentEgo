import { execFile } from 'node:child_process';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { InstallOptions, ServiceAdapter, ServiceStatus } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Windows Task Scheduler adapter.
 *
 * We use schtasks /Create with an ONLOGON trigger so the gateway starts when
 * the user signs in — matching the single-user design. schtasks cannot
 * redirect stdio, so we wrap the node invocation in a small batch script
 * that redirects stdout/stderr itself. The script is emitted under the
 * task's working directory during install and deleted on uninstall.
 *
 * Limitations:
 *  - ONLOGON tasks do not run when the user is signed out (that would need
 *    a SERVICE + /RU SYSTEM, which requires admin). This is intentional —
 *    the gateway operates on behalf of a single logged-in owner.
 *  - /End only kills the top-level process; the wrapped node instance is
 *    terminated via taskkill /F on stop().
 */
export class SchtasksAdapter implements ServiceAdapter {
  readonly platform = 'windows' as const;

  async install(opts: InstallOptions): Promise<void> {
    await mkdir(opts.workingDir, { recursive: true });
    const wrapperPath = wrapperPathFor(opts);
    const wrapperContent = buildBatchWrapper(opts);
    await writeFile(wrapperPath, wrapperContent, { encoding: 'utf-8' });

    // /F = force overwrite, /RL HIGHEST so we don't trip UAC prompts on
    // invocation, /SC ONLOGON so it starts at user sign-in.
    await run('schtasks', [
      '/Create',
      '/F',
      '/TN',
      opts.label,
      '/TR',
      `"${wrapperPath}"`,
      '/SC',
      'ONLOGON',
      '/RL',
      'HIGHEST',
    ]);
  }

  async uninstall(label: string): Promise<void> {
    try {
      await run('schtasks', ['/Delete', '/F', '/TN', label]);
    } catch (err) {
      if (!/cannot find/i.test((err as Error).message)) throw err;
    }
    const wrapper = join(defaultWrapperDir(), `${sanitize(label)}.cmd`);
    try {
      await unlink(wrapper);
    } catch {
      // best-effort
    }
  }

  async start(label: string): Promise<void> {
    await run('schtasks', ['/Run', '/TN', label]);
  }

  async stop(label: string): Promise<void> {
    const status = await this.status(label);
    if (status.pid) {
      try {
        await run('taskkill', ['/PID', String(status.pid), '/T', '/F']);
      } catch {
        // fall through to /End as a last resort
      }
    }
    try {
      await run('schtasks', ['/End', '/TN', label]);
    } catch {
      // acceptable — /End fails if nothing is running
    }
  }

  async restart(label: string): Promise<void> {
    await this.stop(label);
    await this.start(label);
  }

  async status(label: string): Promise<ServiceStatus> {
    try {
      const { stdout } = await execFileAsync('schtasks', [
        '/Query',
        '/TN',
        label,
        '/FO',
        'LIST',
        '/V',
      ]);
      const raw = stdout.trim();
      const state = /Status:\s*(.+)/i.exec(raw)?.[1]?.trim();
      const pidMatch = /PID:\s*(\d+)/i.exec(raw);
      const status: ServiceStatus = {
        installed: true,
        running: /running/i.test(state ?? ''),
      };
      if (state) status.raw = state;
      if (pidMatch?.[1]) status.pid = Number(pidMatch[1]);
      return status;
    } catch (err) {
      if (/cannot find/i.test((err as Error).message)) {
        return { installed: false, running: false };
      }
      throw err;
    }
  }
}

export function buildBatchWrapper(opts: InstallOptions): string {
  const envLines = Object.entries(opts.env)
    .map(([k, v]) => `set "${k}=${v}"`)
    .join('\r\n');
  // Double-quote only paths that might contain spaces.
  const argList = [opts.entrypoint, ...opts.entrypointArgs]
    .map((a) => (a.includes(' ') ? `"${a}"` : a))
    .join(' ');
  return [
    '@echo off',
    `cd /d "${opts.workingDir}"`,
    envLines,
    `"${opts.nodeBinary}" ${argList} 1>>"${opts.stdoutLog}" 2>>"${opts.stderrLog}"`,
  ]
    .filter((l) => l.length > 0)
    .join('\r\n');
}

function wrapperPathFor(opts: InstallOptions): string {
  return join(defaultWrapperDir(), `${sanitize(opts.label)}.cmd`);
}

function defaultWrapperDir(): string {
  // Place wrappers under the user's LOCALAPPDATA or tmp, both writable
  // without admin. Scheduler must be able to read from here.
  return join(process.env['LOCALAPPDATA'] ?? tmpdir(), 'agent-platform', 'service-wrappers');
}

function sanitize(label: string): string {
  return label.replace(/[^A-Za-z0-9._-]/g, '_');
}

async function run(bin: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(bin, args);
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const stderr = e.stderr ?? '';
    throw new Error(`${bin} ${args.join(' ')} failed: ${stderr || e.message}`);
  }
}

// Re-export for type narrowing / DI
export function defaultSchtasksWrapperDir(): string {
  return defaultWrapperDir();
}

// Ensure dirname import isn't pruned (used in future for staging wrappers).
void dirname;
