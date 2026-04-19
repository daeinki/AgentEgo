import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveGatewayPaths, resolveStateDir } from './paths.js';

describe('resolveStateDir', () => {
  it('honors AGENT_STATE_DIR', () => {
    expect(resolveStateDir({ AGENT_STATE_DIR: '/custom/path' })).toBe('/custom/path');
  });

  it('falls back to ~/.agent when unset', () => {
    expect(resolveStateDir({})).toBe(join(homedir(), '.agent'));
  });

  it('treats empty AGENT_STATE_DIR as unset', () => {
    expect(resolveStateDir({ AGENT_STATE_DIR: '' })).toBe(join(homedir(), '.agent'));
  });
});

describe('resolveGatewayPaths', () => {
  it('derives all paths under the state dir', () => {
    const paths = resolveGatewayPaths({ AGENT_STATE_DIR: '/tmp/test-state' });
    expect(paths.stateDir).toBe('/tmp/test-state');
    expect(paths.logsDir).toBe(join('/tmp/test-state', 'logs'));
    expect(paths.runDir).toBe(join('/tmp/test-state', 'run'));
    expect(paths.sessionsDb).toBe(join('/tmp/test-state', 'state', 'sessions.db'));
    expect(paths.palaceRoot).toBe(join('/tmp/test-state', 'memory'));
    expect(paths.egoAuditDb).toBe(join('/tmp/test-state', 'ego', 'audit.db'));
    expect(paths.egoGoalsStore).toBe(join('/tmp/test-state', 'ego', 'goals.json'));
    expect(paths.egoPersonaStore).toBe(join('/tmp/test-state', 'ego', 'persona.json'));
    expect(paths.traceDb).toBe(join('/tmp/test-state', 'trace', 'traces.db'));
    expect(paths.pidFile).toBe(join('/tmp/test-state', 'run', 'gateway.pid'));
    expect(paths.portFile).toBe(join('/tmp/test-state', 'run', 'gateway.port'));
    expect(paths.stdoutLog).toBe(join('/tmp/test-state', 'logs', 'gateway.log'));
    expect(paths.stderrLog).toBe(join('/tmp/test-state', 'logs', 'gateway.err.log'));
  });
});
