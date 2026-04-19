import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { GatewayPaths } from './paths.js';

export interface PidRecord {
  pid: number;
  port: number;
  startedAt: number;
}

/**
 * Check whether a PID is currently alive. Uses `process.kill(pid, 0)` which
 * throws ESRCH if the process doesn't exist, EPERM if we lack permission
 * (i.e. it exists but is not ours), and succeeds silently otherwise.
 *
 * Treats EPERM as "alive" — on Windows and multi-user Linux, another user's
 * process might occupy the PID. We err on the side of "do not clobber".
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

export async function writePidFile(paths: GatewayPaths, record: PidRecord): Promise<void> {
  await mkdir(dirname(paths.pidFile), { recursive: true });
  await writeFile(paths.pidFile, JSON.stringify(record));
}

export async function writePortFile(paths: GatewayPaths, port: number): Promise<void> {
  await mkdir(dirname(paths.portFile), { recursive: true });
  await writeFile(paths.portFile, String(port));
}

export async function readPidFile(paths: GatewayPaths): Promise<PidRecord | null> {
  let raw: string;
  try {
    raw = await readFile(paths.pidFile, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as PidRecord;
    if (
      typeof parsed?.pid !== 'number' ||
      typeof parsed?.port !== 'number' ||
      typeof parsed?.startedAt !== 'number'
    ) {
      return null;
    }
    return parsed;
  } catch {
    // Corrupt contents (not JSON, truncated, etc.) — treat as "no record".
    return null;
  }
}

export async function readPortFile(paths: GatewayPaths): Promise<number | null> {
  try {
    const raw = await readFile(paths.portFile, 'utf-8');
    const n = Number(raw.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function clearPidFile(paths: GatewayPaths): Promise<void> {
  for (const file of [paths.pidFile, paths.portFile]) {
    try {
      await unlink(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

/**
 * Inspect the PID file and determine whether a live gateway is running. If
 * the file exists but the PID is stale, the file is cleaned up automatically.
 */
export async function resolveRunning(paths: GatewayPaths): Promise<PidRecord | null> {
  const record = await readPidFile(paths);
  if (!record) return null;
  if (isProcessAlive(record.pid)) return record;
  await clearPidFile(paths);
  return null;
}
