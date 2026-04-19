import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the state directory used by the gateway for logs, pid files, and
 * persistent state (sessions.db, ego state, memory palace).
 *
 * Precedence:
 * 1. `AGENT_STATE_DIR` environment variable
 * 2. `~/.agent`
 *
 * Matches the CLAUDE.md convention: `~/.agent/ego/…` for EGO state,
 * `~/.agent/memory/…` for the memory palace.
 */
export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['AGENT_STATE_DIR'];
  if (override && override.length > 0) return override;
  return join(homedir(), '.agent');
}

export interface GatewayPaths {
  stateDir: string;
  logsDir: string;
  runDir: string;
  sessionsDb: string;
  palaceRoot: string;
  egoAuditDb: string;
  egoGoalsStore: string;
  egoPersonaStore: string;
  /** SQLite file holding pipeline-block trace events (see trace_events table). */
  traceDb: string;
  pidFile: string;
  portFile: string;
  stdoutLog: string;
  stderrLog: string;
}

/** Build the canonical set of paths for a gateway instance. */
export function resolveGatewayPaths(env: NodeJS.ProcessEnv = process.env): GatewayPaths {
  const stateDir = resolveStateDir(env);
  const logsDir = join(stateDir, 'logs');
  const runDir = join(stateDir, 'run');
  const egoDir = join(stateDir, 'ego');
  const traceDir = join(stateDir, 'trace');
  return {
    stateDir,
    logsDir,
    runDir,
    sessionsDb: join(stateDir, 'state', 'sessions.db'),
    palaceRoot: join(stateDir, 'memory'),
    egoAuditDb: join(egoDir, 'audit.db'),
    egoGoalsStore: join(egoDir, 'goals.json'),
    egoPersonaStore: join(egoDir, 'persona.json'),
    traceDb: join(traceDir, 'traces.db'),
    pidFile: join(runDir, 'gateway.pid'),
    portFile: join(runDir, 'gateway.port'),
    stdoutLog: join(logsDir, 'gateway.log'),
    stderrLog: join(logsDir, 'gateway.err.log'),
  };
}
