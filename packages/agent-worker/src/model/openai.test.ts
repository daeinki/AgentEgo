import { describe, expect, it } from 'vitest';
import { OpenAIAdapter } from './openai.js';

/**
 * Minimal fake of the OpenAI streaming response: yields one text-delta then a
 * usage-bearing terminator chunk, mirroring what the SDK emits with
 * `stream: true, stream_options: { include_usage: true }`.
 */
function fakeOpenAiStream(text = 'hi') {
  return (async function* () {
    yield {
      choices: [{ delta: { content: text }, finish_reason: null }],
      usage: undefined,
    };
    yield {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    };
  })();
}

async function drain(iter: AsyncIterable<unknown>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _ of iter) {
    // discard
  }
}

describe('OpenAIAdapter — responseFormat passthrough', () => {
  it('sets response_format: { type: "json_object" } when caller asks for JSON', async () => {
    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' });
    const captured: Record<string, unknown>[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      chat: {
        completions: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          create: async (req: any) => {
            captured.push(req);
            return fakeOpenAiStream();
          },
        },
      },
    };

    await drain(
      adapter.stream({
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        responseFormat: { type: 'json_object' },
      }),
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]?.['response_format']).toEqual({ type: 'json_object' });
  });

  it('omits response_format when caller did not request JSON mode', async () => {
    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' });
    const captured: Record<string, unknown>[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      chat: {
        completions: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          create: async (req: any) => {
            captured.push(req);
            return fakeOpenAiStream();
          },
        },
      },
    };

    await drain(
      adapter.stream({
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    expect(captured[0]?.['response_format']).toBeUndefined();
  });

  it('omits response_format when caller explicitly asks for text', async () => {
    const adapter = new OpenAIAdapter({ apiKey: 'sk-test' });
    const captured: Record<string, unknown>[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).client = {
      chat: {
        completions: {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          create: async (req: any) => {
            captured.push(req);
            return fakeOpenAiStream();
          },
        },
      },
    };

    await drain(
      adapter.stream({
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'hi' }],
        responseFormat: { type: 'text' },
      }),
    );
    expect(captured[0]?.['response_format']).toBeUndefined();
  });
});
