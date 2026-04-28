import type { SessionPolicy } from '../schema/capability.js';
import type { SandboxInstance } from '../schema/sandbox.js';
import type { ToolResult } from '../schema/tool.js';
import type { TraceCallContext } from './trace-logger.js';

export interface ToolSandbox {
  acquire(policy: SessionPolicy, trace?: TraceCallContext): Promise<SandboxInstance>;
  execute(
    sandbox: SandboxInstance,
    tool: string,
    args: unknown,
    timeout: number,
    trace?: TraceCallContext,
  ): Promise<ToolResult>;
  release(sandbox: SandboxInstance, trace?: TraceCallContext): Promise<void>;
}
