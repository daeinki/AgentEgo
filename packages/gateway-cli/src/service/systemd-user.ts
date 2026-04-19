import { execFile } from 'node:child_process';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { InstallOptions, ServiceAdapter, ServiceStatus } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * systemd --user adapter (Linux).
 *
 * Emits ~/.config/systemd/user/<label>.service, reloads the user daemon,
 * then enables + starts the unit. `Restart=on-failure` keeps it alive.
 *
 * Requires systemd user sessions (`loginctl enable-linger <user>` for units
 * that should run without an active login). We don't auto-run linger to
 * avoid surprising side effects — callers are expected to run it manually
 * if they want headless operation.
 */
export class SystemdUserAdapter implements ServiceAdapter {
  readonly platform = 'linux' as const;

  async install(opts: InstallOptions): Promise<void> {
    await mkdir(opts.workingDir, { recursive: true });
    const unitPath = this.unitPath(opts.label);
    await mkdir(dirname(unitPath), { recursive: true });
    await writeFile(unitPath, buildUnit(opts), 'utf-8');
    await run('systemctl', ['--user', 'daemon-reload']);
    await run('systemctl', ['--user', 'enable', '--now', this.unitName(opts.label)]);
  }

  async uninstall(label: string): Promise<void> {
    const unit = this.unitName(label);
    await run('systemctl', ['--user', 'disable', '--now', unit]).catch(() => {});
    await run('systemctl', ['--user', 'daemon-reload']).catch(() => {});
    try {
      await unlink(this.unitPath(label));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async start(label: string): Promise<void> {
    await run('systemctl', ['--user', 'start', this.unitName(label)]);
  }

  async stop(label: string): Promise<void> {
    await run('systemctl', ['--user', 'stop', this.unitName(label)]);
  }

  async restart(label: string): Promise<void> {
    await run('systemctl', ['--user', 'restart', this.unitName(label)]);
  }

  async status(label: string): Promise<ServiceStatus> {
    const unit = this.unitName(label);
    try {
      const { stdout } = await execFileAsync('systemctl', [
        '--user',
        'show',
        unit,
        '--property=LoadState,ActiveState,MainPID,SubState',
      ]);
      const props = Object.fromEntries(
        stdout
          .trim()
          .split('\n')
          .map((line) => {
            const i = line.indexOf('=');
            return [line.slice(0, i), line.slice(i + 1)];
          }),
      );
      const installed = props['LoadState'] === 'loaded';
      const running = props['ActiveState'] === 'active';
      const pid = Number(props['MainPID']);
      const status: ServiceStatus = { installed, running };
      const raw = props['SubState'];
      if (raw) status.raw = raw;
      if (Number.isFinite(pid) && pid > 0) status.pid = pid;
      return status;
    } catch {
      return { installed: false, running: false };
    }
  }

  private unitName(label: string): string {
    return `${label}.service`;
  }

  private unitPath(label: string): string {
    return join(homedir(), '.config', 'systemd', 'user', this.unitName(label));
  }
}

export function buildUnit(opts: InstallOptions): string {
  const envLines = Object.entries(opts.env)
    .map(([k, v]) => `Environment=${k}=${shellEscape(v)}`)
    .join('\n');
  const execArgs = [opts.nodeBinary, opts.entrypoint, ...opts.entrypointArgs]
    .map(shellEscape)
    .join(' ');

  return `[Unit]
Description=Agent Platform gateway (${opts.label})
After=default.target

[Service]
Type=simple
WorkingDirectory=${opts.workingDir}
${envLines}
ExecStart=${execArgs}
Restart=on-failure
RestartSec=5
StandardOutput=append:${opts.stdoutLog}
StandardError=append:${opts.stderrLog}

[Install]
WantedBy=default.target
`;
}

function shellEscape(v: string): string {
  if (/^[A-Za-z0-9_./=:-]+$/.test(v)) return v;
  return `"${v.replace(/(["\\$`])/g, '\\$1')}"`;
}

async function run(bin: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(bin, args);
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    throw new Error(`${bin} ${args.join(' ')} failed: ${e.stderr ?? e.message}`);
  }
}
