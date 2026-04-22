import Anthropic from '@anthropic-ai/sdk';
import type {
  ModelAdapter,
  CompletionRequest,
  CompletionMessage,
  StreamChunk,
  ToolDefinition,
} from './types.js';
import { buildToolNameMap, sanitizeToolName } from './tool-name.js';

export interface AnthropicConfig {
  apiKey: string;
  model?: string;
  defaultMaxTokens?: number;
}

// Rough pricing per 1M tokens (USD)
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 0.8, output: 4 },
};

export class AnthropicAdapter implements ModelAdapter {
  private client: Anthropic;
  private model: string;
  private defaultMaxTokens: number;

  constructor(config: AnthropicConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model ?? 'claude-opus-4-7';
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const messages = this.toAnthropicMessages(request.messages);
    // Anthropic tool names match `^[a-zA-Z0-9_-]{1,64}$` — our canonical
    // dotted names (e.g. fs.read) need rewrite-and-restore like on OpenAI.
    const nameMap = request.tools ? buildToolNameMap(request.tools) : undefined;
    const tools = nameMap ? this.toAnthropicTools(nameMap.wireTools) : undefined;

    const params: Anthropic.MessageCreateParams = {
      model: this.model,
      max_tokens: request.maxTokens ?? this.defaultMaxTokens,
      // Agentic tool-use flow benefits from higher effort on Opus 4.7.
      output_config: { effort: 'high' },
      system: [
        {
          type: 'text',
          text: request.systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
    };

    const stream = this.client.messages.stream(params);

    for await (const event of stream) {
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        if (block.type === 'tool_use') {
          const canonicalName = nameMap?.wireToCanonical.get(block.name) ?? block.name;
          yield { type: 'tool_call_start', id: block.id, name: canonicalName };
        }
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          yield { type: 'text_delta', text: delta.text };
        } else if (delta.type === 'input_json_delta') {
          yield {
            type: 'tool_call_delta',
            id: '', // will be associated by caller
            args: delta.partial_json,
          };
        }
      } else if (event.type === 'content_block_stop') {
        // Check if this was a tool_use block — caller tracks state
      } else if (event.type === 'message_delta') {
        const usage = (event as unknown as { usage?: { output_tokens: number } }).usage;
        if (usage) {
          // Final usage reporting happens at message_stop
        }
      } else if (event.type === 'message_stop') {
        // Done
      }
    }

    // Get final message for usage
    const finalMessage = await stream.finalMessage();
    const inputTokens = finalMessage.usage.input_tokens;
    const outputTokens = finalMessage.usage.output_tokens;
    const pricing = PRICING[this.model];
    const cost = pricing
      ? (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000
      : undefined;

    yield { type: 'usage', inputTokens, outputTokens, cost };
    yield { type: 'done', stopReason: finalMessage.stop_reason ?? 'end_turn' };
  }

  getModelInfo() {
    return { provider: 'anthropic', model: this.model };
  }

  private toAnthropicMessages(
    messages: CompletionMessage[],
  ): Anthropic.MessageParam[] {
    return messages.map((msg) => {
      if (msg.role === 'tool') {
        return {
          role: 'user' as const,
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: msg.toolCallId!,
              content: msg.content,
            },
          ],
        };
      }
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        // Anthropic expects a content array with text + tool_use blocks.
        // `input` is a parsed object (not the raw JSON string the LLM emitted).
        const blocks: Anthropic.ContentBlockParam[] = [];
        if (msg.content && msg.content.length > 0) {
          blocks.push({ type: 'text', text: msg.content });
        }
        for (const c of msg.toolCalls) {
          let input: unknown;
          try {
            input = c.arguments.length > 0 ? JSON.parse(c.arguments) : {};
          } catch {
            input = {};
          }
          blocks.push({
            type: 'tool_use',
            id: c.id,
            name: sanitizeToolName(c.name),
            input: input as Record<string, unknown>,
          });
        }
        return { role: 'assistant' as const, content: blocks };
      }
      return {
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      };
    });
  }

  private toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
    }));
  }
}
