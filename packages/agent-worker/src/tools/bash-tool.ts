import type { ToolResult } from '@agent-platform/core';
import type { DockerTool, DockerCommandSpec } from './docker-sandbox.js';

interface BashArgs {
  script: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface BashToolConfig {
  image?: string;
  memoryMb?: number;
  cpus?: number;
  networkEnabled?: boolean;
}

/**
 * `bash.run` — execute a shell script inside a container. Only the Docker
 * path is safe; the in-process fallback refuses to execute and must be
 * explicitly enabled via `allowInProcessFallback: true`.
 */
export function bashTool(
  config: BashToolConfig & { allowInProcessFallback?: boolean } = {},
): DockerTool {
  const image = config.image ?? 'alpine:latest';
  return {
    name: 'bash.run',
    description: 'Execute a shell script in an isolated container.',
    riskLevel: 'critical',
    runsInContainer: true,
    permissions: [
      { type: 'process', access: 'execute', commands: ['/bin/sh'] },
    ],
    inputSchema: {
      type: 'object',
      required: ['script'],
      properties: {
        script: { type: 'string', description: 'Shell script to run via /bin/sh -c.' },
        cwd: { type: 'string' },
        env: { type: 'object', additionalProperties: { type: 'string' } },
      },
    },
    dockerCommand(args): DockerCommandSpec {
      const a = args as BashArgs;
      const spec: DockerCommandSpec = {
        image,
        command: ['/bin/sh', '-c', a.script],
        readOnly: false, // scripts often need a temp dir
      };
      if (a.env !== undefined) spec.env = a.env;
      if (a.cwd !== undefined) spec.cwd = a.cwd;
      if (config.memoryMb !== undefined) spec.memoryMb = config.memoryMb;
      if (config.cpus !== undefined) spec.cpus = config.cpus;
      if (config.networkEnabled !== undefined) spec.networkEnabled = config.networkEnabled;
      return spec;
    },
    async execute(_args): Promise<ToolResult> {
      if (!config.allowInProcessFallback) {
        return {
          toolName: 'bash.run',
          success: false,
          error:
            'bash.run refuses in-process execution — wire up DockerSandbox or set allowInProcessFallback',
          durationMs: 0,
        };
      }
      return {
        toolName: 'bash.run',
        success: false,
        error: 'in-process execution deliberately unimplemented — use DockerSandbox',
        durationMs: 0,
      };
    },
  };
}
