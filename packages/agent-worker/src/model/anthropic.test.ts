import { describe, expect, it } from 'vitest';
import { AnthropicAdapter } from './anthropic.js';
import type { StreamChunk } from './types.js';

/**
 * Minimal stand-in for `client.messages.stream(params)` — async-iterable that
 * emits one text_delta event, plus a `finalMessage()` resolver returning a
 * usage-bearing message envelope. Captures the params it was called with so
 * tests can assert prompt/messages/prefill.
 */
function makeFakeAnthropicClient(deltaText = 'value"}') {
  const captured: Array<Record<string, unknown>> = [];
  const client = {
    messages: {
      stream(params: Record<string, unknown>) {
        captured.push(params);
        async function* events() {
          yield {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: deltaText },
          };
        }
        const iter = events();
        return {
          [Symbol.asyncIterator]() {
            return iter;
          },
          async finalMessage() {
            return {
              usage: { input_tokens: 4, output_tokens: 6 },
              stop_reason: 'end_turn',
            };
          },
        };
      },
    },
  };
  return { client, captured };
}

async function collectText(stream: AsyncIterable<StreamChunk>): Promise<string> {
  let acc = '';
  for await (const ev of stream) {
    if (ev.type === 'text_delta') acc += ev.text;
  }
  return acc;
}

describe('AnthropicAdapter — responseFormat=json_object prefill', () => {
  it('appends an assistant prefill message containing "{" so the model continues inside an object', async () => {
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test' });
    const { client, captured } = makeFakeAnthropicClient('"k":"v"}');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = client;

    await collectText(
      adapter.stream({
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'give me JSON' }],
        responseFormat: { type: 'json_object' },
      }),
    );

    expect(captured).toHaveLength(1);
    const sentMessages = captured[0]?.['messages'] as Array<{ role: string; content: unknown }>;
    expect(sentMessages.at(-1)).toEqual({ role: 'assistant', content: '{' });
  });

  it('prepends "{" to the streamed text so callers can JSON.parse the result', async () => {
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test' });
    const { client } = makeFakeAnthropicClient('"k":"v"}');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = client;

    const text = await collectText(
      adapter.stream({
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'give me JSON' }],
        responseFormat: { type: 'json_object' },
      }),
    );
    expect(text).toBe('{"k":"v"}');
    // Sanity: the recovered string is real JSON.
    expect(JSON.parse(text)).toEqual({ k: 'v' });
  });

  it('does NOT add prefill or prepend "{" when JSON mode is not requested', async () => {
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test' });
    const { client, captured } = makeFakeAnthropicClient('hello world');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = client;

    const text = await collectText(
      adapter.stream({
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(text).toBe('hello world');
    const sentMessages = captured[0]?.['messages'] as Array<{ role: string }>;
    // Last message should be the original user turn, NOT a synthetic assistant prefill.
    expect(sentMessages.at(-1)?.role).toBe('user');
  });

  it('only prepends "{" once even if multiple text_delta chunks arrive', async () => {
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test' });
    // Custom client that emits two consecutive text_deltas.
    const client = {
      messages: {
        stream() {
          async function* events() {
            yield {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: '"a":1,' },
            };
            yield {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: '"b":2}' },
            };
          }
          const iter = events();
          return {
            [Symbol.asyncIterator]() {
              return iter;
            },
            async finalMessage() {
              return { usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' };
            },
          };
        },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = client;

    const text = await collectText(
      adapter.stream({
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'json' }],
        responseFormat: { type: 'json_object' },
      }),
    );
    expect(text).toBe('{"a":1,"b":2}');
    expect(JSON.parse(text)).toEqual({ a: 1, b: 2 });
  });
});
