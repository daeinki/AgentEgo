import { describe, expect, it } from 'vitest';
import { buildBatchWrapper } from './schtasks.js';
import { buildPlist } from './launchd.js';
import { buildUnit } from './systemd-user.js';
import type { InstallOptions } from './types.js';

function sampleOpts(overrides: Partial<InstallOptions> = {}): InstallOptions {
  return {
    label: 'AgentPlatformGateway',
    nodeBinary: '/usr/bin/node',
    entrypoint: '/opt/agent/dist/program.js',
    entrypointArgs: ['gateway', 'start', '--foreground'],
    env: { AGENT_STATE_DIR: '/home/u/.agent', OPENAI_API_KEY: 'sk-xxx' },
    stdoutLog: '/home/u/.agent/logs/gateway.log',
    stderrLog: '/home/u/.agent/logs/gateway.err.log',
    workingDir: '/home/u/.agent',
    ...overrides,
  };
}

describe('buildBatchWrapper (Windows schtasks)', () => {
  it('emits a CRLF batch file with chdir, env, and stdio redirection', () => {
    const out = buildBatchWrapper(
      sampleOpts({ nodeBinary: 'C:/Program Files/nodejs/node.exe' }),
    );
    expect(out).toContain('@echo off');
    expect(out).toContain('cd /d "/home/u/.agent"');
    expect(out).toContain('set "AGENT_STATE_DIR=/home/u/.agent"');
    expect(out).toContain('set "OPENAI_API_KEY=sk-xxx"');
    // Node binary path contains a space → must be quoted.
    expect(out).toContain('"C:/Program Files/nodejs/node.exe"');
    // Entrypoint should be referenced with its args.
    expect(out).toContain('/opt/agent/dist/program.js gateway start --foreground');
    // stdout/stderr redirection with append.
    expect(out).toContain('1>>"/home/u/.agent/logs/gateway.log"');
    expect(out).toContain('2>>"/home/u/.agent/logs/gateway.err.log"');
    expect(out).toContain('\r\n');
  });
});

describe('buildPlist (macOS launchd)', () => {
  it('renders RunAtLoad/KeepAlive and escapes XML entities', () => {
    const plist = buildPlist(sampleOpts({ label: 'com.a&b.gateway' }));
    expect(plist).toContain('<key>Label</key>');
    expect(plist).toContain('<string>com.a&amp;b.gateway</string>');
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toContain('<key>WorkingDirectory</key>');
    expect(plist).toContain('<string>/home/u/.agent</string>');
    // ProgramArguments should include node + entrypoint + args in order.
    const order = plist.indexOf('/usr/bin/node');
    const order2 = plist.indexOf('/opt/agent/dist/program.js');
    const order3 = plist.indexOf('--foreground');
    expect(order).toBeGreaterThan(-1);
    expect(order2).toBeGreaterThan(order);
    expect(order3).toBeGreaterThan(order2);
    // Env block carries the API key.
    expect(plist).toContain('<key>OPENAI_API_KEY</key>');
    expect(plist).toContain('<string>sk-xxx</string>');
  });
});

describe('buildUnit (Linux systemd --user)', () => {
  it('renders a [Service] block with Restart=on-failure and Environment=', () => {
    const unit = buildUnit(sampleOpts());
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('Type=simple');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WorkingDirectory=/home/u/.agent');
    expect(unit).toContain('Environment=AGENT_STATE_DIR=/home/u/.agent');
    expect(unit).toContain('Environment=OPENAI_API_KEY=sk-xxx');
    expect(unit).toContain(
      'ExecStart=/usr/bin/node /opt/agent/dist/program.js gateway start --foreground',
    );
    expect(unit).toContain('StandardOutput=append:/home/u/.agent/logs/gateway.log');
    expect(unit).toContain('StandardError=append:/home/u/.agent/logs/gateway.err.log');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('quotes env values with shell metacharacters', () => {
    const unit = buildUnit(
      sampleOpts({ env: { TRICKY: 'has spaces and "quotes"' } }),
    );
    // The value should be wrapped in quotes and inner quotes escaped.
    expect(unit).toMatch(/Environment=TRICKY="has spaces and \\"quotes\\""/);
  });
});
