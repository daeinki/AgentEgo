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

  async acquire(
    policy: SessionPolicy,
    trace?: Contracts.TraceCallContext,
  ): Promise<SandboxInstance> {
    const instance: SandboxInstance = {
      id: `sandbox-${generateId()}`,
      status: 'ready',
      startedAt: nowMs(),
      resourceUsage: { cpuSeconds: 0, memoryMb: 0, diskMb: 0 },
    };
    this.instances.set(instance.id, instance);
    if (trace) {
      trace.traceLogger.event({
        traceId: trace.traceId,
        ...(trace.sessionId !== undefined ? { sessionId: trace.sessionId } : {}),
        ...(trace.agentId !== undefined ? { agentId: trace.agentId } : {}),
        block: 'S1',
        event: 'sandbox_acquired',
        timestamp: Date.now(),
        summary: `in-process sandbox '${instance.id}' acquired (trustLevel=${policy.trustLevel}, sandboxMode=${policy.sandboxMode})`,
        payload: {
          sandboxId: instance.id,
          kind: 'in-process',
          trustLevel: policy.trustLevel,
          sandboxMode: policy.sandboxMode,
        },
      });
    }
    return instance;
  }

  async execute(
    sandbox: SandboxInstance,
    tool: string,
    args: unknown,
    timeoutMs: number,
    trace?: Contracts.TraceCallContext,
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
    let result: ToolResult;
    try {
      const out = await t.execute(args, {
        sessionId: '',
        agentId: '',
        traceId: '',
        signal: controller.signal,
      });
      result = { ...out, durationMs: performance.now() - start };
    } catch (err) {
      result = {
        toolName: tool,
        success: false,
        error: (err as Error).message,
        durationMs: performance.now() - start,
      };
    } finally {
      clearTimeout(timer);
      registered.status = 'ready';
    }
    if (trace) {
      trace.traceLogger.event({
        traceId: trace.traceId,
        ...(trace.sessionId !== undefined ? { sessionId: trace.sessionId } : {}),
        ...(trace.agentId !== undefined ? { agentId: trace.agentId } : {}),
        block: 'S1',
        event: 'sandbox_executed',
        timestamp: Date.now(),
        durationMs: Math.round(result.durationMs),
        summary: `in-process exec '${tool}' → ${result.success ? 'ok' : 'error'} in ${Math.round(result.durationMs)}ms${result.success ? '' : `: ${(result.error ?? 'unknown').slice(0, 40)}`}`,
        payload: {
          sandboxId: sandbox.id,
          tool,
          success: result.success,
          ...(result.error !== undefined ? { error: result.error } : {}),
        },
      });
    }
    return result;
  }

  async release(sandbox: SandboxInstance, trace?: Contracts.TraceCallContext): Promise<void> {
    this.instances.delete(sandbox.id);
    if (trace) {
      trace.traceLogger.event({
        traceId: trace.traceId,
        ...(trace.sessionId !== undefined ? { sessionId: trace.sessionId } : {}),
        ...(trace.agentId !== undefined ? { agentId: trace.agentId } : {}),
        block: 'S1',
        event: 'sandbox_released',
        timestamp: Date.now(),
        summary: `in-process sandbox '${sandbox.id}' released`,
        payload: { sandboxId: sandbox.id, kind: 'in-process' },
      });
    }
  }
}
