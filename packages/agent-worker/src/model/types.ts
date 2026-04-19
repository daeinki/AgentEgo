/**
 * LLM Model Adapter — abstract interface for streaming completions.
 */

export interface CompletionRequest {
  systemPrompt: string;
  messages: CompletionMessage[];
  maxTokens?: number;
  temperature?: number;
  tools?: ToolDefinition[];
}

export interface CompletionMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
  /**
   * Present only on `role: 'assistant'` messages that invoked tool(s) in the
   * previous turn. The adapter serializes these as provider-specific tool-use
   * blocks:
   *   - OpenAI: `tool_calls: [{ id, type:'function', function: { name, arguments } }]`
   *   - Anthropic: `content: [{type:'text',text}, {type:'tool_use', id, name, input}]`
   * When a matching `role: 'tool'` message follows, the provider correlates
   * the two by `id`/`toolCallId`. Omitting this is what produced
   * "messages with role 'tool' must be a response to a preceding message
   * with 'tool_calls'" on OpenAI.
   */
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type StreamChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; args: string }
  | { type: 'tool_call_end'; id: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cost?: number }
  | { type: 'done'; stopReason: string };

export interface ModelAdapter {
  stream(request: CompletionRequest): AsyncIterable<StreamChunk>;
  getModelInfo(): { provider: string; model: string };
}
