import type { AgentTool } from './types.js';
import { fsListTool, fsReadTool, fsWriteTool, webFetchTool } from './built-in.js';

export interface DefaultToolsConfig {
  /**
   * Allowed root directories for `fs.read`. Pass an empty/undefined value to
   * skip the tool entirely. The tool refuses any path outside the allowlist.
   */
  fsRead?: string[];
  /**
   * Allowed root directories for `fs.write`. Same allowlist semantics as
   * `fsRead`. Writes outside owner trust are denied by PolicyCapabilityGuard
   * regardless.
   */
  fsWrite?: string[];
  /**
   * Allowed domains (hostname suffix match) for `web.fetch`. Empty/undefined
   * skips the tool.
   */
  webFetch?: string[];
}

/**
 * Build the canonical "safe local agent" tool set. Returns only the tools the
 * caller explicitly opted into — there is no implicit default that would let
 * an LLM read arbitrary files or hit arbitrary URLs.
 *
 * Typical usage in `startPlatform()`:
 *   tools: buildDefaultTools({ fsRead: [process.cwd()], webFetch: ['github.com'] })
 *
 * For Docker-backed tools (`bash.run`), import `bashTool` directly and append.
 */
export function buildDefaultTools(config: DefaultToolsConfig): AgentTool[] {
  const tools: AgentTool[] = [];
  if (config.fsRead && config.fsRead.length > 0) {
    tools.push(fsReadTool(config.fsRead));
    // fs.list shares the read allow-list — "show files in X" / "read Y" are the
    // canonical pair, and forcing a separate env var for listing would just
    // push users to duplicate the same roots.
    tools.push(fsListTool(config.fsRead));
  }
  if (config.fsWrite && config.fsWrite.length > 0) tools.push(fsWriteTool(config.fsWrite));
  if (config.webFetch && config.webFetch.length > 0) tools.push(webFetchTool(config.webFetch));
  return tools;
}
