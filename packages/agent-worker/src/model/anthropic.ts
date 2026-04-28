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

    const trace = request.traceContext;
    const startedAt = Date.now();
    const role = trace?.role ?? 'actor';
    const wantsJsonMode = request.responseFormat?.type === 'json_object';
    if (trace) {
      trace.traceLogger.event({
        traceId: trace.traceId,
        ...(trace.sessionId !== undefined ? { sessionId: trace.sessionId } : {}),
        ...(trace.agentId !== undefined ? { agentId: trace.agentId } : {}),
        block: 'M1',
        event: 'stream_started',
        timestamp: startedAt,
        summary: `anthropic ${this.model}: ${role} stream started (msgs=${messages.length}${tools ? `, tools=${tools.length}` : ''}${wantsJsonMode ? ', json_object via prefill' : ''})`,
        payload: {
          provider: 'anthropic',
          model: this.model,
          role,
          messageCount: messages.length,
          toolCount: tools?.length ?? 0,
          jsonMode: wantsJsonMode,
        },
      });
    }

    // Anthropic has no native `response_format: json_object`. The standard
    // technique is **assistant prefill**: appending an `assistant` message
    // whose content is `{` forces the model to continue from that token, so
    // its first emitted character is guaranteed to be inside a JSON object.
    // We emit the prefill char ourselves at the start of the stream so
    // downstream `JSON.parse()` sees a complete object without the caller
    // having to know about prefill.
    const wantsJson = request.responseFormat?.type === 'json_object';
    const PREFILL = '{';
    if (wantsJson) {
      messages.push({ role: 'assistant', content: PREFILL });
    }

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

    let stream;
    try {
      stream = this.client.messages.stream(params);
    } catch (err) {
      if (trace) {
        trace.traceLogger.event({
          traceId: trace.traceId,
          ...(trace.sessionId !== undefined ? { sessionId: trace.sessionId } : {}),
          ...(trace.agentId !== undefined ? { agentId: trace.agentId } : {}),
          block: 'M1',
          event: 'stream_error',
          timestamp: Date.now(),
          durationMs: Date.now() - startedAt,
          summary: `anthropic ${this.model}: stream rejected pre-flight — ${(err as Error).message.slice(0, 60)}`,
          error: (err as Error).message,
        });
      }
      throw err;
    }

    let prefillEmitted = !wantsJson;
    let firstTokenAt: number | undefined;
    const emitFirstTokenIfNeeded = () => {
      if (firstTokenAt !== undefined || !trace) return;
      firstTokenAt = Date.now();
      trace.traceLogger.event({
        traceId: trace.traceId,
        ...(trace.sessionId !== undefined ? { sessionId: trace.sessionId } : {}),
        ...(trace.agentId !== undefined ? { agentId: trace.agentId } : {}),
        block: 'M1',
        event: 'first_token',
        timestamp: firstTokenAt,
        durationMs: firstTokenAt - startedAt,
        summary: `anthropic ${this.model}: first token after ${firstTokenAt - startedAt}ms (ttft)`,
        payload: { provider: 'anthropic', model: this.model, role, ttftMs: firstTokenAt - startedAt },
      });
    };

    try {
      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block.type === 'tool_use') {
            emitFirstTokenIfNeeded();
            const canonicalName = nameMap?.wireToCanonical.get(block.name) ?? block.name;
            yield { type: 'tool_call_start', id: block.id, name: canonicalName };
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta;
          if (delta.type === 'text_delta') {
            emitFirstTokenIfNeeded();
            if (!prefillEmitted) {
              yield { type: 'text_delta', text: PREFILL + delta.text };
              prefillEmitted = true;
            } else {
              yield { type: 'text_delta', text: delta.text };
            }
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
    } catch (err) {
      if (trace) {
        trace.traceLogger.event({
          traceId: trace.traceId,
          ...(trace.sessionId !== undefined ? { sessionId: trace.sessionId } : {}),
          ...(trace.agentId !== undefined ? { agentId: trace.agentId } : {}),
          block: 'M1',
          event: 'stream_error',
          timestamp: Date.now(),
          durationMs: Date.now() - startedAt,
          summary: `anthropic ${this.model}: stream errored after ${Date.now() - startedAt}ms — ${(err as Error).message.slice(0, 60)}`,
          error: (err as Error).message,
        });
      }
      throw err;
    }

    // Get final message for usage
    const finalMessage = await stream.finalMessage();
    const inputTokens = finalMessage.usage.input_tokens;
    const outputTokens = finalMessage.usage.output_tokens;
    const pricing = PRICING[this.model];
    const cost = pricing
      ? (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000
      : undefined;

    if (trace) {
      const totalMs = Date.now() - startedAt;
      const ttft = firstTokenAt !== undefined ? firstTokenAt - startedAt : null;
      trace.traceLogger.event({
        traceId: trace.traceId,
        ...(trace.sessionId !== undefined ? { sessionId: trace.sessionId } : {}),
        ...(trace.agentId !== undefined ? { agentId: trace.agentId } : {}),
        block: 'M1',
        event: 'stream_done',
        timestamp: Date.now(),
        durationMs: totalMs,
        summary:
          `anthropic ${this.model}: ${outputTokens} out / ${inputTokens} in tokens` +
          (cost !== undefined ? `, $${cost.toFixed(4)}` : '') +
          ` in ${totalMs}ms` +
          (ttft !== null ? ` (ttft=${ttft}ms)` : '') +
          ` — stop=${finalMessage.stop_reason ?? 'end_turn'}`,
        payload: {
          provider: 'anthropic',
          model: this.model,
          role,
          inputTokens,
          outputTokens,
          ...(cost !== undefined ? { costUsd: cost } : {}),
          ttftMs: ttft,
          stopReason: finalMessage.stop_reason ?? 'end_turn',
        },
      });
    }

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
