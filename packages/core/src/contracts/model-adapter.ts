import type { StreamChunk, ModelInfo, ProviderHealth } from '../schema/model.js';

export interface CompletionRequest {
  model: string;
  systemPrompt: string;
  messages: { role: string; content: string }[];
  tools?: { name: string; description: string; inputSchema: unknown }[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' | 'text' };
}

export interface ModelAdapter {
  stream(request: CompletionRequest): AsyncIterable<StreamChunk>;
  getModelInfo(): ModelInfo;
  healthCheck(): Promise<ProviderHealth>;
}
