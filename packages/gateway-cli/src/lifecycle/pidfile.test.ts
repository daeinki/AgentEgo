import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  clearPidFile,
  isProcessAlive,
  readPidFile,
  readPortFile,
  resolveRunning,
  writePidFile,
  writePortFile,
} from './pidfile.js';
import type { GatewayPaths } from './paths.js';

function pathsUnder(root: string): GatewayPaths {
  return {
    stateDir: root,
    logsDir: join(root, 'logs'),
    runDir: join(root, 'run'),
    sessionsDb: join(root, 'state', 'sessions.db'),
    palaceRoot: join(root, 'memory'),
    egoAuditDb: join(root, 'ego', 'audit.db'),
    egoGoalsStore: join(root, 'ego', 'goals.json'),
    egoPersonaStore: join(root, 'ego', 'persona.json'),
    traceDb: join(root, 'trace', 'traces.db'),
    pidFile: join(root, 'run', 'gateway.pid'),
    portFile: join(root, 'run', 'gateway.port'),
    stdoutLog: join(root, 'logs', 'gateway.log'),
    stderrLog: join(root, 'logs', 'gateway.err.log'),
  };
}

describe('pidfile helpers', () => {
  let dir: string;
  let paths: GatewayPaths;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'pidfile-'));
    paths = pathsUnder(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes and reads a valid pid record', async () => {
    await writePidFile(paths, { pid: process.pid, port: 12345, startedAt: 1000 });
    const record = await readPidFile(paths);
    expect(record).toEqual({ pid: process.pid, port: 12345, startedAt: 1000 });
  });

  it('returns null for a missing pidfile', async () => {
    expect(await readPidFile(paths)).toBeNull();
  });

  it('treats malformed pidfile as null', async () => {
    await writePidFile(paths, { pid: 999, port: 1, startedAt: 0 });
    // Overwrite with garbage
    const { writeFile } = await import('node:fs/promises');
    await writeFile(paths.pidFile, 'not-json', 'utf-8');
    expect(await readPidFile(paths)).toBeNull();
  });

  it('writes and reads the port file', async () => {
    await writePortFile(paths, 54321);
    expect(await readPortFile(paths)).toBe(54321);
    // Raw contents are plain text, not JSON.
    const raw = await readFile(paths.portFile, 'utf-8');
    expect(raw.trim()).toBe('54321');
  });

  it('clears both files', async () => {
    await writePidFile(paths, { pid: 1, port: 1, startedAt: 1 });
    await writePortFile(paths, 1);
    await clearPidFile(paths);
    expect(await readPidFile(paths)).toBeNull();
    expect(await readPortFile(paths)).toBeNull();
  });

  it('isProcessAlive reports live for the current process and dead for pid 0', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });

  it('resolveRunning returns null and cleans up a stale pidfile', async () => {
    // Pick a pid we're confident is not alive — max-range pid is virtually
    // always unused on any OS. Using 99999999 as an easy proxy.
    await writePidFile(paths, { pid: 99999999, port: 1, startedAt: 0 });
    const res = await resolveRunning(paths);
    expect(res).toBeNull();
    expect(await readPidFile(paths)).toBeNull();
  });

  it('resolveRunning returns the record for a live pid', async () => {
    await writePidFile(paths, { pid: process.pid, port: 42, startedAt: 5 });
    const res = await resolveRunning(paths);
    expect(res?.pid).toBe(process.pid);
    expect(res?.port).toBe(42);
  });
});
