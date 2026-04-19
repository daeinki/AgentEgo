import { execFile } from 'node:child_process';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { InstallOptions, ServiceAdapter, ServiceStatus } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * macOS launchd (per-user LaunchAgent) adapter.
 *
 * Creates ~/Library/LaunchAgents/<label>.plist and bootstraps it into the
 * user's GUI domain. `RunAtLoad=true` + `KeepAlive=true` make the daemon
 * start at login and respawn on crash.
 */
export class LaunchdAdapter implements ServiceAdapter {
  readonly platform = 'darwin' as const;

  async install(opts: InstallOptions): Promise<void> {
    await mkdir(opts.workingDir, { recursive: true });
    const plistPath = this.plistPath(opts.label);
    await mkdir(dirname(plistPath), { recursive: true });
    await writeFile(plistPath, buildPlist(opts), 'utf-8');

    // Replace any existing one — bootout is best-effort.
    await this.bootout(opts.label).catch(() => {});
    await run('launchctl', ['bootstrap', this.domain(), plistPath]);
    await run('launchctl', ['enable', `${this.domain()}/${opts.label}`]);
  }

  async uninstall(label: string): Promise<void> {
    await this.bootout(label).catch(() => {});
    try {
      await unlink(this.plistPath(label));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  async start(label: string): Promise<void> {
    await run('launchctl', ['kickstart', `${this.domain()}/${label}`]);
  }

  async stop(label: string): Promise<void> {
    // kill sends SIGTERM; the daemon's SIGTERM handler triggers graceful shutdown.
    await run('launchctl', ['kill', 'SIGTERM', `${this.domain()}/${label}`]).catch(() => {});
  }

  async restart(label: string): Promise<void> {
    await run('launchctl', ['kickstart', '-k', `${this.domain()}/${label}`]);
  }

  async status(label: string): Promise<ServiceStatus> {
    try {
      const { stdout } = await execFileAsync('launchctl', ['print', `${this.domain()}/${label}`]);
      const state = /state\s*=\s*(\w+)/.exec(stdout)?.[1];
      const pidMatch = /pid\s*=\s*(\d+)/.exec(stdout);
      const status: ServiceStatus = {
        installed: true,
        running: state === 'running',
      };
      if (state) status.raw = state;
      if (pidMatch?.[1]) status.pid = Number(pidMatch[1]);
      return status;
    } catch {
      return { installed: false, running: false };
    }
  }

  private async bootout(label: string): Promise<void> {
    await run('launchctl', ['bootout', `${this.domain()}/${label}`]);
  }

  private plistPath(label: string): string {
    return join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  }

  private domain(): string {
    return `gui/${userInfo().uid}`;
  }
}

export function buildPlist(opts: InstallOptions): string {
  const envEntries = Object.entries(opts.env)
    .map(
      ([k, v]) =>
        `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`,
    )
    .join('\n');
  const argsXml = [opts.nodeBinary, opts.entrypoint, ...opts.entrypointArgs]
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(opts.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(opts.workingDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(opts.stdoutLog)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(opts.stderrLog)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&'
      ? '&amp;'
      : c === '<'
        ? '&lt;'
        : c === '>'
          ? '&gt;'
          : c === '"'
            ? '&quot;'
            : '&apos;',
  );
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
