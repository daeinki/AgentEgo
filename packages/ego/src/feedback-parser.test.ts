import { describe, it, expect } from 'vitest';
import { LlmFeedbackParser, type FeedbackParserModelAdapter } from './feedback-parser.js';

class ScriptedModel implements FeedbackParserModelAdapter {
  public calls: Array<string> = [];
  constructor(private readonly response: string) {}
  async *stream(req: {
    systemPrompt: string;
    messages: Array<{ role: string; content: string }>;
  }) {
    const first = req.messages[0];
    this.calls.push(typeof first?.content === 'string' ? first.content : '');
    yield { type: 'text_delta' as const, text: this.response };
    yield { type: 'done' as const };
  }
}

describe('LlmFeedbackParser', () => {
  it('parses a valid JSON array of explicit-instruction signals', async () => {
    const model = new ScriptedModel(
      JSON.stringify([
        { type: 'explicit-instruction', instruction: '더 간결하게', appliesTo: 'verbosity' },
      ]),
    );
    const parser = new LlmFeedbackParser({ model });
    const result = await parser.parse({
      userMessage: '설명이 너무 길어 좀 줄여',
      agentResponse: '알겠습니다, 다음엔 더 짧게 하겠습니다.',
    });
    expect(result).toHaveLength(1);
    if (result[0]?.type === 'explicit-instruction') {
      expect(result[0].appliesTo).toBe('verbosity');
    }
  });

  it('accepts code-fenced JSON output', async () => {
    const model = new ScriptedModel('```json\n[{"type":"positive-feedback","context":"x","behavior":"y"}]\n```');
    const parser = new LlmFeedbackParser({ model });
    const result = await parser.parse({
      userMessage: '좋아!',
      agentResponse: '감사합니다.',
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('positive-feedback');
  });

  it('drops malformed array items, keeps valid ones', async () => {
    const model = new ScriptedModel(
      JSON.stringify([
        { type: 'nonsense' },
        { type: 'correction', original: 'X', corrected: 'Y', pattern: 'p' },
        { type: 'positive-feedback' }, // missing fields
      ]),
    );
    const parser = new LlmFeedbackParser({ model });
    const result = await parser.parse({
      userMessage: '',
      agentResponse: '',
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe('correction');
  });

  it('returns empty array when LLM outputs non-JSON', async () => {
    const model = new ScriptedModel('Sorry I have no structured output today');
    const parser = new LlmFeedbackParser({ model });
    const result = await parser.parse({ userMessage: '', agentResponse: '' });
    expect(result).toEqual([]);
  });

  it('returns empty array when LLM outputs non-array JSON', async () => {
    const model = new ScriptedModel('{"type":"positive-feedback"}');
    const parser = new LlmFeedbackParser({ model });
    const result = await parser.parse({ userMessage: '', agentResponse: '' });
    expect(result).toEqual([]);
  });

  it('forwards user message and agent response into the prompt', async () => {
    const model = new ScriptedModel('[]');
    const parser = new LlmFeedbackParser({ model });
    await parser.parse({
      userMessage: '간결히 말해',
      agentResponse: '알겠습니다',
      recentContext: '아까 길게 답했음',
    });
    const body = model.calls[0]!;
    expect(body).toContain('간결히 말해');
    expect(body).toContain('알겠습니다');
    expect(body).toContain('아까 길게 답했음');
  });

  it('accepts a domain-exposure signal', async () => {
    const model = new ScriptedModel(
      JSON.stringify([
        { type: 'domain-exposure', domain: 'baking', subtopic: 'bread', interactionCount: 5 },
      ]),
    );
    const parser = new LlmFeedbackParser({ model });
    const result = await parser.parse({ userMessage: '', agentResponse: '' });
    expect(result[0]?.type).toBe('domain-exposure');
  });

  it('accepts a negative-feedback signal with severity', async () => {
    const model = new ScriptedModel(
      JSON.stringify([
        { type: 'negative-feedback', context: 'code review', behavior: 'missed JWT bug', severity: 'strong' },
      ]),
    );
    const parser = new LlmFeedbackParser({ model });
    const result = await parser.parse({ userMessage: '', agentResponse: '' });
    expect(result[0]?.type).toBe('negative-feedback');
    if (result[0]?.type === 'negative-feedback') {
      expect(result[0].severity).toBe('strong');
    }
  });
});
