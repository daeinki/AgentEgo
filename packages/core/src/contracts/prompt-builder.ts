import type { BuiltPrompt, ToolDefinition } from '../schema/prompt.js';
import type { StandardMessage } from '../types/message.js';
import type { Session } from '../types/session.js';
import type { MemorySearchResult } from '../schema/memory.js';

export interface AgentConfig {
  agentId: string;
  modelId: string;
  personaSnapshot?: string;
}

export interface PromptContext {
  session: Session;
  agent: AgentConfig;
  memory: MemorySearchResult[];
  availableTools: ToolDefinition[];
  userMessage: StandardMessage;
}

export interface PromptBuilder {
  build(ctx: PromptContext): Promise<BuiltPrompt>;
}
