import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { resolveGatewayPaths } from '@agent-platform/gateway-cli';

/**
 * Resolve the default session DB path the CLI should use.
 *
 * Precedence:
 *  1. `--db` flag the caller passes through (not handled here; caller-owned).
 *  2. A legacy `./agent-sessions.db` in the current working directory — kept
 *     for backwards-compat so existing workflows don't silently switch DBs.
 *  3. `<stateDir>/state/sessions.db` (default: `~/.agent/state/sessions.db`).
 *
 * The returned path's parent directory is created if necessary.
 */
export async function resolveDefaultSessionDb(): Promise<string> {
  const legacy = resolve(process.cwd(), 'agent-sessions.db');
  if (existsSync(legacy)) return legacy;

  const paths = resolveGatewayPaths();
  await mkdir(dirname(paths.sessionsDb), { recursive: true });
  return paths.sessionsDb;
}
