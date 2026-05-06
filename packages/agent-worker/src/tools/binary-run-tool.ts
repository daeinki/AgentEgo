import { existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { ToolResult } from '@agent-platform/core';
import type { DockerCommandSpec, DockerTool } from './docker-sandbox.js';

/**
 * `binary.run` — execute a binary or script inside a hardened Docker container.
 *
 * Threat model & isolation:
 *   - DockerSandbox handles container lifecycle (`--rm`, network=none default,
 *     read-only rootfs, resource caps, no-new-privileges, optional gVisor).
 *   - The agent's `skillInstallRoot` is bind-mounted at `/skills` **read-only**
 *     so agent-authored scripts/binaries are reachable but the agent cannot
 *     mutate its own skill dir from inside the container (host-side fs.write
 *     happens earlier via WorkerSandbox).
 *   - Path validation rejects host-fs traversal (`..`, absolute paths outside
 *     skillRoot). Container-absolute paths (e.g. `/usr/bin/ffmpeg`) pass
 *     through — the container's own fs is a fresh ephemeral surface.
 *   - Interpreter is whitelisted (python3 / node / bash / sh). Free-form
 *     shell strings are not accepted to keep the LLM-emitted invocation
 *     auditable.
 *   - Direct (no-interpreter) execution requires the host file to have an
 *     execute bit set; this catches "wrote source as binary" mistakes early.
 */

export const INTERPRETER_WHITELIST = ['python3', 'node', 'bash', 'sh'] as const;
export type AllowedInterpreter = (typeof INTERPRETER_WHITELIST)[number];

const TIMEOUT_CEILING_MS = 5 * 60 * 1000; // 5 min — DockerSandbox enforces it
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_IMAGE = 'python:3.12-slim';
const DEFAULT_MOUNT_POINT = '/skills';

export interface BinaryRunToolDeps {
  /**
   * Host directory whose contents are bind-mounted into the container.
   * Typically the platform's `skillInstallRoot` so agent-authored skills
   * can run their own scripts/binaries. Required.
   */
  skillInstallRoot: string;
  /**
   * Container-side mountpoint for the skill dir. Default `/skills`.
   * Hard-coded so the LLM can predict paths without per-call lookup.
   */
  containerMountPoint?: string;
  /** Default container image. Overridable per-call via `args.image`. */
  defaultImage?: string;
  /** Default per-call timeout (ms). Default 30s, hard cap 5min. */
  defaultTimeoutMs?: number;
}

interface BinaryRunArgs {
  path: string;
  args?: string[];
  interpreter?: AllowedInterpreter;
  cwd?: string;
  image?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  /**
   * Opt-in network access. Default `false` — even owner-trusted sessions
   * cannot exfiltrate via network from a binary.run container unless the
   * caller explicitly asks for it. Without this override the container is
   * spawned with `--network none`.
   */
  network?: boolean;
}

/**
 * Build the `binary.run` DockerTool. Wire it alongside `bash.run` in
 * `platform.ts` (gated on `enableBinaryRun`).
 */
export function binaryRunTool(deps: BinaryRunToolDeps): DockerTool {
  const skillRoot = resolve(deps.skillInstallRoot);
  const mountPoint = deps.containerMountPoint ?? DEFAULT_MOUNT_POINT;
  const defaultImage = deps.defaultImage ?? DEFAULT_IMAGE;
  const defaultTimeout = deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: 'binary.run',
    description:
      'Execute a binary or script inside a Docker container. Two path forms:\n' +
      '  • Relative — resolved under the agent skill install root and bind-mounted at /skills (read-only). Use this for scripts/binaries created via skill.create.\n' +
      '  • Absolute — passed through to the container (e.g. /usr/bin/python3). Use this for binaries baked into the image.\n' +
      'When `interpreter` is set (python3 / node / bash / sh), the file does NOT need an execute bit. Otherwise the host file must be marked executable.\n' +
      'Container is hardened: --rm, network=none, read-only rootfs, resource caps. Output is stdout+stderr concatenated.',
    riskLevel: 'high',
    permissions: [{ type: 'filesystem', access: 'read', paths: [skillRoot] }],
    runsInContainer: true,
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: {
          type: 'string',
          description:
            'Relative path under skillInstallRoot (e.g. "csv-parser/runner.py") OR container-absolute path (e.g. "/usr/bin/ffmpeg").',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Argv after the binary.',
        },
        interpreter: {
          type: 'string',
          enum: [...INTERPRETER_WHITELIST],
          description:
            'Run the file via this interpreter instead of executing it directly. Skips the exec-bit requirement.',
        },
        cwd: {
          type: 'string',
          description: 'Container working directory. Default /tmp (a tmpfs).',
        },
        image: {
          type: 'string',
          description: `Override container image. Default ${defaultImage}.`,
        },
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          maximum: TIMEOUT_CEILING_MS,
          description: `Container timeout (ms). Default ${defaultTimeout}, ceiling ${TIMEOUT_CEILING_MS}.`,
        },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Env vars set inside the container.',
        },
        network: {
          type: 'boolean',
          description:
            'Allow network access. Default false — container is spawned with --network none. Set true only when the binary genuinely needs outbound HTTP/DNS.',
        },
      },
    },
    dockerCommand(rawArgs: unknown): DockerCommandSpec {
      const args = (rawArgs ?? {}) as BinaryRunArgs;
      if (typeof args.path !== 'string' || args.path.length === 0) {
        throw new Error('binary.run: `path` must be a non-empty string');
      }
      if (
        args.interpreter !== undefined &&
        !INTERPRETER_WHITELIST.includes(args.interpreter as AllowedInterpreter)
      ) {
        throw new Error(
          `binary.run: interpreter '${args.interpreter}' not in whitelist (${INTERPRETER_WHITELIST.join(', ')})`,
        );
      }

      const containerPath = resolveBinaryPath(args.path, skillRoot, mountPoint, args.interpreter);

      const command = args.interpreter
        ? [args.interpreter, containerPath, ...(args.args ?? [])]
        : [containerPath, ...(args.args ?? [])];

      const spec: DockerCommandSpec = {
        image: args.image ?? defaultImage,
        command,
        cwd: args.cwd ?? '/tmp',
        mounts: [{ source: skillRoot, target: mountPoint, readonly: true }],
        // Default-deny network even for owner-trusted sessions. The whole
        // point of containerizing agent-written code is to bound blast
        // radius below "what owner could do" — exfiltration via outbound
        // TCP is exactly the kind of thing this layer should block by
        // default. Caller opts in via `args.network: true`.
        networkEnabled: args.network === true,
      };
      if (args.env !== undefined) spec.env = args.env;
      return spec;
    },
    async execute(_args, _ctx): Promise<ToolResult> {
      // DockerSandbox routes DockerTools through `executeInContainer` and
      // never calls `execute()`. This fallback lights up only if a caller
      // wires `binary.run` into a non-Docker sandbox — refuse loudly,
      // because there is no in-process implementation that's safe.
      return {
        toolName: 'binary.run',
        success: false,
        error:
          'binary.run requires DockerSandbox; in-process execution is not supported (would defeat the isolation contract)',
        durationMs: 0,
      };
    },
  };
}

/**
 * Resolve the path the agent passed into a path the container will see.
 *
 * Rules:
 *   - Container-absolute (`/usr/bin/...`, `/skills/foo`) passes through.
 *     The container's fs is a fresh ephemeral rootfs plus our read-only
 *     bind-mount; nothing the agent can reference outside `mountPoint`
 *     leaks host secrets. We also reject obvious traversal attempts that
 *     start with `/` but contain `..`.
 *   - Relative paths must resolve to a real file under `skillRoot`. We
 *     re-anchor to `<mountPoint>/<relative>` for the container.
 *
 * Throws on rejection — DockerSandbox catches and reports as a
 * ToolResult.error.
 */
function resolveBinaryPath(
  rawPath: string,
  skillRoot: string,
  mountPoint: string,
  interpreter: AllowedInterpreter | undefined,
): string {
  // Container-absolute path
  if (rawPath.startsWith('/')) {
    if (rawPath.includes('/../') || rawPath.endsWith('/..')) {
      throw new Error(`binary.run: traversal segments ('..') are not allowed: ${rawPath}`);
    }
    return rawPath;
  }

  // Relative path — must stay under skillRoot.
  const hostPath = resolve(skillRoot, rawPath);
  const skillPrefix = skillRoot.endsWith(sep) ? skillRoot : skillRoot + sep;
  if (hostPath !== skillRoot && !hostPath.startsWith(skillPrefix)) {
    throw new Error(`binary.run: path escapes skillInstallRoot: ${rawPath}`);
  }
  if (!existsSync(hostPath)) {
    throw new Error(`binary.run: file not found under skillInstallRoot: ${rawPath}`);
  }

  // Direct execution requires an exec bit. With an interpreter we treat the
  // file as data and skip — the interpreter is the executable binary.
  if (!interpreter) {
    const stat = statSync(hostPath);
    if (!stat.isFile()) {
      throw new Error(`binary.run: not a regular file: ${rawPath}`);
    }
    if ((stat.mode & 0o111) === 0) {
      throw new Error(
        `binary.run: file lacks execute permission (mode ${stat.mode.toString(8)}): ${rawPath}. Use \`interpreter\` to run via python3/node/bash/sh, or chmod +x via skill.create.`,
      );
    }
  }

  // Map host path under skillRoot to container path under mountPoint.
  // POSIX-only join — mounts always use forward slashes inside the container,
  // even on Windows hosts.
  const rel = hostPath.slice(skillPrefix.length).split(sep).join('/');
  return `${mountPoint}/${rel}`;
}

// Exported for test access — not part of the public tool surface.
export const __testing__ = { resolveBinaryPath };
