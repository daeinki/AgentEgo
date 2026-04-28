#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
loadEnvFromAncestors();

import { Command } from 'commander';
import { sendCommand } from './commands/send.js';
import { statusCommand } from './commands/status.js';
import { egoCommand } from './commands/ego.js';
import {
  gatewayHealthCommand,
  gatewayInstallCommand,
  gatewayLogsCommand,
  gatewayRestartCommand,
  gatewayStartCommand,
  gatewayStatusCommand,
  gatewayStopCommand,
  gatewayUninstallCommand,
} from './commands/gateway.js';
import { tuiCommand } from './commands/tui.js';
import {
  traceExportCommand,
  traceLastCommand,
  traceListCommand,
  traceShowCommand,
} from './commands/trace.js';
import { deviceListCommand, deviceRevokeCommand } from './commands/device.js';

const program = new Command();

program
  .name('agent')
  .description('AI Agent Platform CLI')
  .version('0.1.0');

program
  .command('send')
  .description('Send a message to the agent and get a response')
  .argument('<message>', 'Message text to send')
  .option('-s, --session <id>', 'Session ID (auto-created if omitted)')
  .option('-a, --agent <id>', 'Agent ID', 'default')
  .option('--db <path>', 'Session database path (default: ~/.agent/state/sessions.db, or ./agent-sessions.db if it exists)')
  .action(sendCommand);

program
  .command('status')
  .description('Show platform status')
  .option('--db <path>', 'Session database path (default: ~/.agent/state/sessions.db, or ./agent-sessions.db if it exists)')
  .action(statusCommand);

program
  .command('ego')
  .description('EGO layer management')
  .argument('<action>', 'Action: off | passive | active | on (alias for active) | status')
  .option('--config <path>', 'EGO config file path')
  .action(egoCommand);

const gateway = program
  .command('gateway')
  .description('Long-running agent daemon (JSON-RPC 2.0 over WebSocket)');

gateway
  .command('start')
  .description('Start the gateway (Ctrl+C to stop) — add --detach to background it')
  .option('-p, --port <n>', 'Port to listen on', String(process.env['AGENT_GATEWAY_PORT'] ?? 18790))
  .option('-H, --host <host>', 'Host to bind to', '127.0.0.1')
  .option('--auth-token <token>', 'Bearer token required by clients')
  .option('--detach', 'Fork a background daemon and return (foreground otherwise)')
  .option('--foreground', 'Explicitly run in foreground (default; used by detach children)')
  .option(
    '--webapp-dir <path>',
    'Directory of a built webapp SPA to serve at /ui/* (defaults to auto-detecting packages/webapp/dist; also honours AGENT_WEBAPP_DIR)',
  )
  .option('--no-webapp', 'Do not serve the webapp at /ui/* even if a built dist is available')
  .action(gatewayStartCommand);

gateway
  .command('status')
  .description('Show whether a gateway is running, plus health details')
  .option('-H, --host <host>', 'Gateway host', '127.0.0.1')
  .option('-p, --port <n>', 'Override the port from pidfile', '')
  .option('--auth-token <token>', 'Bearer token')
  .action(gatewayStatusCommand);

gateway
  .command('health')
  .description('Query a running gateway for its health status (RPC)')
  .option('-H, --host <host>', 'Gateway host', '127.0.0.1')
  .option('-p, --port <n>', 'Gateway port', String(process.env['AGENT_GATEWAY_PORT'] ?? 18790))
  .option('--auth-token <token>', 'Bearer token')
  .action(gatewayHealthCommand);

gateway
  .command('stop')
  .description('Ask a running gateway to shut down gracefully')
  .option('-H, --host <host>', 'Gateway host', '127.0.0.1')
  .option('-p, --port <n>', 'Gateway port', String(process.env['AGENT_GATEWAY_PORT'] ?? 18790))
  .option('--auth-token <token>', 'Bearer token')
  .action(gatewayStopCommand);

gateway
  .command('logs')
  .description('Tail the detached gateway log file')
  .option('--stderr', 'Show stderr log instead of stdout')
  .option('-n, --lines <n>', 'Number of trailing lines to show', '50')
  .action(gatewayLogsCommand);

gateway
  .command('install')
  .description('Register the gateway with the OS service manager (launchd/systemd/schtasks)')
  .option('--label <name>', 'Service label (platform default if omitted)')
  .option('-p, --port <n>', 'Port for the supervised gateway', String(process.env['AGENT_GATEWAY_PORT'] ?? 18790))
  .option('--auth-token <token>', 'Bearer token the service should use')
  .option('--start', 'Start the service immediately after installing')
  .action(gatewayInstallCommand);

gateway
  .command('uninstall')
  .description('Remove the OS service registration')
  .option('--label <name>', 'Service label (platform default if omitted)')
  .action(gatewayUninstallCommand);

gateway
  .command('restart')
  .description('Restart the OS-managed gateway service')
  .option('--label <name>', 'Service label (platform default if omitted)')
  .action(gatewayRestartCommand);

program
  .command('tui')
  .description('Launch the interactive Ink-based TUI client against a running gateway')
  .option('-H, --host <host>', 'Gateway host', '127.0.0.1')
  .option('-p, --port <n>', 'Gateway port', String(process.env['AGENT_GATEWAY_PORT'] ?? 18790))
  .option('--auth-token <token>', 'Bearer token')
  .option('-s, --session <id>', 'Resume an existing session')
  .option('-c, --conversation <id>', 'Conversation id (stable across restarts)')
  .action(tuiCommand);

const trace = program
  .command('trace')
  .description('Inspect per-turn debug trace events recorded by the gateway');

trace
  .command('list')
  .description('List recent traces (newest first)')
  .option('-s, --session <id>', 'Filter by session id')
  .option('-n, --limit <n>', 'Maximum traces to show', '20')
  .action(traceListCommand);

trace
  .command('show')
  .description('Print the block-level timeline for a trace')
  .argument('<traceId>', 'Trace id (e.g. trc-…)')
  .option('--format <fmt>', 'Output format: text | json', 'text')
  .option('--wall-clock', 'Show absolute wall-clock (HH:mm:ss.SSS) instead of offset')
  .option('--verbose', 'Dump raw payload JSON under each event')
  .option('--filter <block>', 'Only show events from one block (e.g. M1, X1, R3)')
  .option('--no-color', 'Disable ANSI color (default: auto-detect TTY)')
  .action(traceShowCommand);

trace
  .command('last')
  .description('Show the most recent trace (optionally within a session)')
  .option('-s, --session <id>', 'Filter by session id')
  .option('--format <fmt>', 'Output format: text | json', 'text')
  .option('--wall-clock', 'Show absolute wall-clock (HH:mm:ss.SSS) instead of offset')
  .option('--verbose', 'Dump raw payload JSON under each event')
  .option('--filter <block>', 'Only show events from one block (e.g. M1, X1, R3)')
  .option('--no-color', 'Disable ANSI color (default: auto-detect TTY)')
  .action(traceLastCommand);

trace
  .command('export')
  .description('Export a trace as JSON (or NDJSON) for sharing/analysis')
  .argument('<traceId>', 'Trace id (e.g. trc-…)')
  .option('--format <fmt>', 'json | ndjson', 'json')
  .action(traceExportCommand);

const device = program
  .command('device')
  .description('Manage browser device enrollments (devices.json)');

device
  .command('list')
  .description('List enrolled devices (deviceId, name, enrolledAt, lastSeenAt)')
  .option('--json', 'Emit raw JSON instead of a table')
  .action(deviceListCommand);

device
  .command('revoke')
  .description('Revoke an enrolled device by deviceId (cuts session tokens immediately)')
  .argument('<deviceId>', 'Device id (UUID assigned by enroll)')
  .action(deviceRevokeCommand);

program.parse();

function loadEnvFromAncestors(): void {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) {
      loadDotenv({ path: candidate });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
