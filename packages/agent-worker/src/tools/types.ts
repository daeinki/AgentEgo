import type { Permission, ToolResult } from '@agent-platform/core';

/**
 * Runtime tool interface — the unit that an agent can request.
 *
 * Each built-in tool declares its name, permissions, and a JSON-schema-ish
 * input description. At call time, `execute` receives validated args and
 * produces a ToolResult (matching core's schema).
 */
export interface AgentTool<A = unknown> {
  readonly name: string;
  readonly description: string;
  readonly permissions: Permission[];
  readonly riskLevel: 'low' | 'medium' | 'high' | 'critical';
  readonly inputSchema: Record<string, unknown>;
  execute(args: A, ctx: ToolExecutionContext): Promise<ToolResult>;
}

export interface ToolExecutionContext {
  sessionId: string;
  agentId: string;
  traceId: string;
  /**
   * Abort signal tied to the per-tool timeout.
   */
  signal: AbortSignal;
}
