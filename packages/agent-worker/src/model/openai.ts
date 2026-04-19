import OpenAI from 'openai';
import type {
  ModelAdapter,
  CompletionRequest,
  CompletionMessage,
  StreamChunk,
  ToolDefinition,
} from './types.js';
import { buildToolNameMap, sanitizeToolName } from './tool-name.js';

export interface OpenAIConfig {
  apiKey: string;
  model?: string;
  baseURL?: string;
  defaultMaxTokens?: number;
}

const PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
};

export class OpenAIAdapter implements ModelAdapter {
  private client: OpenAI;
  private model: string;
  private defaultMaxTokens: number;

  constructor(config: OpenAIConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    });
    this.model = config.model ?? 'gpt-4o-mini';
    this.defaultMaxTokens = config.defaultMaxTokens ?? 4096;
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const messages = this.toOpenAIMessages(request);
    // OpenAI function.name rejects `.` and other punctuation. We rewrite
    // canonical names like "fs.read" to "fs_read" on the wire and translate
    // incoming tool_call names back so downstream sandbox.execute receives
    // the canonical form.
    const nameMap = request.tools ? buildToolNameMap(request.tools) : undefined;
    const tools = nameMap ? this.toOpenAITools(nameMap.wireTools) : undefined;

    const maxTok = request.maxTokens ?? this.defaultMaxTokens;
    const usesCompletionTokens = isNewGenModel(this.model);
    const supportsTemperature = !isReasoningModel(this.model);

    const stream = await this.client.chat.completions.create({
      model: this.model,
      ...(usesCompletionTokens
        ? { max_completion_tokens: maxTok }
        : { max_tokens: maxTok }),
      ...(supportsTemperature ? { temperature: request.temperature ?? 0.7 } : {}),
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
      stream: true,
      stream_options: { include_usage: true },
    });

    const toolCallIndexToId = new Map<number, string>();
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason = 'end_turn';

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (choice?.delta) {
        const delta = choice.delta;
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          yield { type: 'text_delta', text: delta.content };
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (tc.id && !toolCallIndexToId.has(idx)) {
              toolCallIndexToId.set(idx, tc.id);
              const wireName = tc.function?.name ?? '';
              const canonicalName =
                nameMap?.wireToCanonical.get(wireName) ?? wireName;
              yield {
                type: 'tool_call_start',
                id: tc.id,
                name: canonicalName,
              };
            }
            if (tc.function?.arguments) {
              yield {
                type: 'tool_call_delta',
                id: toolCallIndexToId.get(idx) ?? '',
                args: tc.function.arguments,
              };
            }
          }
        }
      }
      if (choice?.finish_reason) {
        stopReason = mapFinishReason(choice.finish_reason);
      }
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens;
        outputTokens = chunk.usage.completion_tokens;
      }
    }

    const pricing = PRICING[this.model];
    const cost = pricing
      ? (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000
      : undefined;

    yield { type: 'usage', inputTokens, outputTokens, cost };
    yield { type: 'done', stopReason };
  }

  getModelInfo() {
    return { provider: 'openai', model: this.model };
  }

  private toOpenAIMessages(
    request: CompletionRequest,
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    if (request.systemPrompt) {
      out.push({ role: 'system', content: request.systemPrompt });
    }
    for (const m of request.messages) {
      out.push(convertMessage(m));
    }
    return out;
  }



  private toOpenAITools(
    tools: ToolDefinition[],
  ): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as Record<string, unknown>,
      },
    }));
  }
}

function convertMessage(
  m: CompletionMessage,
): OpenAI.Chat.Completions.ChatCompletionMessageParam {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: m.toolCallId ?? '',
      content: m.content,
    };
  }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: {
          // Must be kept in sync with the wire-name rewrite done in
          // buildToolNameMap — both the tool definition on the request and
          // the tool_call replayed in the conversation history use the
          // sanitized form.
          name: sanitizeToolName(c.name),
          arguments: c.arguments,
        },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

function isNewGenModel(model: string): boolean {
  // gpt-5.x, o1/o3/o4 reasoning models require `max_completion_tokens`.
  return /^(gpt-5|o1|o3|o4)/i.test(model);
}

function isReasoningModel(model: string): boolean {
  // Reasoning models reject custom temperature — only the default (1) is allowed.
  return /^(o1|o3|o4|gpt-5)/i.test(model);
}

function mapFinishReason(reason: string): string {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    default:
      return reason;
  }
}
