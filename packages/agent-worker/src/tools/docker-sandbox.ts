import type { Contracts, SandboxInstance, SessionPolicy, ToolResult } from '@agent-platform/core';
import { generateId, nowMs } from '@agent-platform/core';
import type { AgentTool } from './types.js';
import type { ContainerRuntime, ResourceLimits } from './container-runtime.js';

type ToolSandbox = Contracts.ToolSandbox;

export interface DockerSandboxConfig {
  /**
   * Base image used when a tool doesn't declare its own. A minimal
   * `alpine:latest` or `ubuntu:latest` is typical.
   */
  defaultImage: string;
  runtime: ContainerRuntime;
  /**
   * gVisor runtime name, e.g. `runsc`. Passed through to Docker when set.
   */
  gvisorRuntime?: string;
}

/**
 * Docker-backed `ToolSandbox`. Each `execute()` runs the tool's command in a
 * throwaway container with resource limits derived from the session policy.
 *
 * Built-in tools that want to run inside Docker expose a `dockerCommand(args)`
 * method (via the `DockerTool` protocol below). Tools without this opt-in fall
 * through to `InProcessSandbox`-style in-process execution — useful for
 * platform-native tools (fs.*) that don't benefit from containerization.
 */
export class DockerSandbox implements ToolSandbox {
  private readonly instances = new Map<
    string,
    { instance: SandboxInstance; policy: SessionPolicy }
  >();

  constructor(
    private readonly tools: Map<string, AgentTool | DockerTool>,
    private readonly config: DockerSandboxConfig,
  ) {}

  async acquire(policy: SessionPolicy): Promise<SandboxInstance> {
    const instance: SandboxInstance = {
      id: `dockerbox-${generateId()}`,
      status: 'ready',
      startedAt: nowMs(),
      resourceUsage: { cpuSeconds: 0, memoryMb: 0, diskMb: 0 },
    };
    this.instances.set(instance.id, { instance, policy });
    return instance;
  }

  async execute(
    sandbox: SandboxInstance,
    toolName: string,
    args: unknown,
    timeoutMs: number,
  ): Promise<ToolResult> {
    const registered = this.instances.get(sandbox.id);
    if (!registered) {
      return { toolName, success: false, error: 'sandbox not acquired', durationMs: 0 };
    }
    const tool = this.tools.get(toolName);
    if (!tool) {
      return { toolName, success: false, error: `unknown tool: ${toolName}`, durationMs: 0 };
    }

    // DockerTool path: run inside a container.
    if (isDockerTool(tool)) {
      return this.executeInContainer(tool, args, registered.policy, timeoutMs);
    }

    // Plain AgentTool fallback: in-process execution (for host-native tools).
    registered.instance.status = 'running';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const start = performance.now();
    try {
      return await tool.execute(args, {
        sessionId: '',
        agentId: '',
        traceId: '',
        signal: controller.signal,
      });
    } catch (err) {
      return {
        toolName,
        success: false,
        error: (err as Error).message,
        durationMs: performance.now() - start,
      };
    } finally {
      clearTimeout(timer);
      registered.instance.status = 'ready';
    }
  }

  async release(sandbox: SandboxInstance): Promise<void> {
    this.instances.delete(sandbox.id);
  }

  private async executeInContainer(
    tool: DockerTool,
    args: unknown,
    policy: SessionPolicy,
    timeoutMs: number,
  ): Promise<ToolResult> {
    const spec = tool.dockerCommand(args);
    const limits: ResourceLimits = {
      cpus: spec.cpus ?? policy.resourceLimits.maxCpuSeconds > 0 ? 0.5 : undefined,
      memoryMb: spec.memoryMb ?? policy.resourceLimits.maxMemoryMb,
      networkEnabled: spec.networkEnabled ?? policy.resourceLimits.networkEnabled,
      readOnly: spec.readOnly ?? true,
    };
    const runOpts: Parameters<ContainerRuntime['runOnce']>[0] = {
      image: spec.image ?? this.config.defaultImage,
      command: spec.command,
      timeoutMs,
      limits,
    };
    if (spec.env !== undefined) runOpts.env = spec.env;
    if (spec.cwd !== undefined) runOpts.cwd = spec.cwd;
    if (spec.stdinData !== undefined) runOpts.stdinData = spec.stdinData;
    if (this.config.gvisorRuntime !== undefined) runOpts.runtime = this.config.gvisorRuntime;

    const result = await this.config.runtime.runOnce(runOpts);

    const ok = result.exitCode === 0 && !result.timedOut;
    const output = `exit=${result.exitCode}\n--- stdout ---\n${result.stdout}${result.stderr ? `\n--- stderr ---\n${result.stderr}` : ''}`;
    const baseResult: ToolResult = {
      toolName: tool.name,
      success: ok,
      output,
      durationMs: result.durationMs,
    };
    if (!ok) {
      baseResult.error = result.timedOut ? 'timed out' : `non-zero exit: ${result.exitCode}`;
    }
    return baseResult;
  }
}

/**
 * Opt-in contract that lets a tool advertise how it wants to be run inside a
 * container.
 */
export interface DockerTool extends Pick<AgentTool, 'name' | 'description' | 'permissions' | 'riskLevel' | 'inputSchema'> {
  readonly runsInContainer: true;
  dockerCommand(args: unknown): DockerCommandSpec;
  /**
   * Fallback in-process execution (used when no DockerSandbox is wired up).
   */
  execute: AgentTool['execute'];
}

export interface DockerCommandSpec {
  image?: string;
  command: string[];
  env?: Record<string, string>;
  cwd?: string;
  stdinData?: string;
  cpus?: number;
  memoryMb?: number;
  networkEnabled?: boolean;
  readOnly?: boolean;
}

export function isDockerTool(tool: AgentTool | DockerTool): tool is DockerTool {
  return (tool as DockerTool).runsInContainer === true;
}
