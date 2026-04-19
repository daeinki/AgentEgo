import type { SessionPolicy } from '../schema/capability.js';
import type { SandboxInstance } from '../schema/sandbox.js';
import type { ToolResult } from '../schema/tool.js';

export interface ToolSandbox {
  acquire(policy: SessionPolicy): Promise<SandboxInstance>;
  execute(
    sandbox: SandboxInstance,
    tool: string,
    args: unknown,
    timeout: number,
  ): Promise<ToolResult>;
  release(sandbox: SandboxInstance): Promise<void>;
}
