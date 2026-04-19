import type { EgoLlmConfig } from '../types/ego.js';
import type { EgoThinkingResult } from '../schema/ego-thinking.js';
import type { MessageSummary, MemorySearchResult } from '../schema/memory.js';

export interface EgoThinkingRequest {
  systemPrompt: string;
  context: {
    signal: unknown;
    recentConversation: MessageSummary[];
    relevantMemories: string[];
    activeGoals: unknown[];
    userProfile?: unknown;
  };
  responseFormat: { type: 'json_object' };
}

export interface EgoLlmAdapter {
  initialize(config: EgoLlmConfig): Promise<void>;
  think(request: EgoThinkingRequest): Promise<EgoThinkingResult>;
  healthCheck(): Promise<boolean>;
  getModelInfo(): { provider: string; model: string; isFallback: boolean };
}

export type { EgoThinkingResult, MemorySearchResult };
