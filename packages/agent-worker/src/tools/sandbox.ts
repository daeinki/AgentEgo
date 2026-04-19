import type { Contracts, SandboxInstance, SessionPolicy, ToolResult } from '@agent-platform/core';
import { generateId, nowMs } from '@agent-platform/core';
import type { AgentTool } from './types.js';

type ToolSandbox = Contracts.ToolSandbox;

/**
 * In-process tool sandbox.
 *
 * This is the Phase 1 implementation of the `ToolSandbox` contract. It runs
 * tools in the same process with only an AbortController timeout for
 * isolation. It's safe for tools that themselves don't touch unbounded
 * resources (web search, fs reads) but is **not** a security boundary: a
 * malicious tool could still do anything this process can.
 *
 * The spec calls for Docker + gVisor eventually. That lands in Phase 4 as a
 * `DockerSandbox` class implementing the same `ToolSandbox` contract, so
 * everything above this layer stays unchanged.
 */
export class InProcessSandbox implements ToolSandbox {
  private readonly instances = new Map<string, SandboxInstance>();

  constructor(private readonly tools: Map<string, AgentTool>) {}

  async acquire(policy: SessionPolicy): Promise<SandboxInstance> {
    const instance: SandboxInstance = {
      id: `sandbox-${generateId()}`,
      status: 'ready',
      startedAt: nowMs(),
      resourceUsage: { cpuSeconds: 0, memoryMb: 0, diskMb: 0 },
    };
    void policy;
    this.instances.set(instance.id, instance);
    return instance;
  }

  async execute(
    sandbox: SandboxInstance,
    tool: string,
    args: unknown,
    timeoutMs: number,
  ): Promise<ToolResult> {
    const registered = this.instances.get(sandbox.id);
    if (!registered) {
      return { toolName: tool, success: false, error: 'sandbox not acquired', durationMs: 0 };
    }
    const t = this.tools.get(tool);
    if (!t) {
      return { toolName: tool, success: false, error: `unknown tool: ${tool}`, durationMs: 0 };
    }

    registered.status = 'running';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const start = performance.now();
    try {
      const result = await t.execute(args, {
        sessionId: '',
        agentId: '',
        traceId: '',
        signal: controller.signal,
      });
      return {
        ...result,
        durationMs: performance.now() - start,
      };
    } catch (err) {
      return {
        toolName: tool,
        success: false,
        error: (err as Error).message,
        durationMs: performance.now() - start,
      };
    } finally {
      clearTimeout(timer);
      registered.status = 'ready';
    }
  }

  async release(sandbox: SandboxInstance): Promise<void> {
    this.instances.delete(sandbox.id);
  }
}
