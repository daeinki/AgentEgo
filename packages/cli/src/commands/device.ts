import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveGatewayPaths } from '@agent-platform/gateway-cli';
import { DeviceAuthStore, type DeviceRecord } from '@agent-platform/control-plane';

interface DeviceListOptions {
  json?: boolean;
}

function openStore(): DeviceAuthStore {
  const paths = resolveGatewayPaths();
  const filePath = join(paths.stateDir, 'state', 'devices.json');
  if (!existsSync(filePath)) {
    console.error(
      `[device] no devices file at ${filePath}.\n` +
        `  Start the gateway (agent gateway start) and enroll at least one device\n` +
        `  from the webapp, or set AGENT_STATE_DIR if you use a custom state directory.`,
    );
    process.exit(1);
  }
  return new DeviceAuthStore({ filePath });
}

export async function deviceListCommand(options: DeviceListOptions): Promise<void> {
  const store = openStore();
  const devices = store.listDevices();
  if (options.json) {
    console.log(JSON.stringify(devices, null, 2));
    return;
  }
  if (devices.length === 0) {
    console.log('[device] no devices enrolled.');
    return;
  }
  console.log(formatHeader());
  for (const d of devices) console.log(formatRow(d));
}

export async function deviceRevokeCommand(deviceId: string): Promise<void> {
  const store = openStore();
  const target = store.getDevice(deviceId);
  if (!target) {
    console.error(`[device] no device with id ${deviceId}.`);
    process.exit(1);
  }
  const ok = store.revoke(deviceId);
  if (!ok) {
    console.error(`[device] failed to revoke ${deviceId}.`);
    process.exit(1);
  }
  console.log(`[device] revoked ${deviceId} (${target.name}).`);
}

function formatHeader(): string {
  return [
    pad('deviceId', 38),
    pad('name', 24),
    pad('enrolledAt', 19),
    pad('lastSeenAt', 19),
  ].join('  ');
}

function formatRow(d: DeviceRecord): string {
  return [
    pad(d.deviceId, 38),
    pad(truncate(d.name, 24), 24),
    pad(formatTs(d.enrolledAt), 19),
    pad(d.lastSeenAt ? formatTs(d.lastSeenAt) : '-', 19),
  ].join('  ');
}

function formatTs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function truncate(s: string, width: number): string {
  return s.length > width ? s.slice(0, width - 1) + '…' : s;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s.padEnd(width);
}
