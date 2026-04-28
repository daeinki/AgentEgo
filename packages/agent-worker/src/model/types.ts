/**
 * LLM Model Adapter — abstract interface for streaming completions.
 */

import type { Contracts } from '@agent-platform/core';

/**
 * Optional per-request trace plumbing. When supplied, the adapter emits
 * `M1.stream_started` / `M1.first_token` / `M1.stream_done` (or
 * `M1.stream_error`) events bracketing the SDK call so token / latency /
 * cost / JSON-mode telemetry surfaces in `agent trace show` instead of
 * being lumped into W1's `stream_done`. Stateless: the adapter never
 * stores it across calls.
 */
export interface ModelTraceContext {
  traceLogger: Contracts.TraceLogger;
  traceId: string;
  sessionId?: string;
  agentId?: string;
  /**
   * Optional caller-supplied label (e.g. 'planner', 'react', 'synthesis')
   * forwarded into the M1 payload so consumers can distinguish the same
   * adapter being called for different reasoning roles within one turn.
   */
  role?: string;
}

export interface CompletionRequest {
  systemPrompt: string;
  messages: CompletionMessage[];
  maxTokens?: number;
  temperature?: number;
  tools?: ToolDefinition[];
  /**
   * Optional structured-output hint for the planner / EGO-style callers that
   * need a JSON-only reply. When `'json_object'`:
   *   - OpenAI: passed through as native `response_format: { type: 'json_object' }`,
   *     guaranteeing syntactically valid JSON.
   *   - Anthropic: no native JSON mode — the adapter prefills the assistant
   *     turn with `{` so the first token is forced to start an object, and
   *     the prefill char is reattached to the streamed text so callers can
   *     `JSON.parse()` the concatenated result without special-casing.
   * Schema validity is still the caller's job (see `parsePlan`).
   */
  responseFormat?: { type: 'json_object' | 'text' };
  /**
   * Optional trace context. When omitted the adapter is silent (preserves
   * the pre-M1 contract for callers that haven't been wired up).
   */
  traceContext?: ModelTraceContext;
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
