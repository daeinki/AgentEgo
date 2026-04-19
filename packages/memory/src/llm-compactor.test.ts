import { describe, it, expect } from 'vitest';
import { LlmCompactor, type CompactorModelAdapter } from './llm-compactor.js';
import type { ChunkRecord } from './db/store.js';

class ScriptedModel implements CompactorModelAdapter {
  public calls: Array<{ systemPrompt: string; userContent: string }> = [];
  constructor(private readonly scripts: string[]) {}
  async *stream(req: {
    systemPrompt: string;
    messages: Array<{ role: string; content: string }>;
  }) {
    const first = req.messages[0];
    this.calls.push({
      systemPrompt: req.systemPrompt,
      userContent: typeof first?.content === 'string' ? first.content : '',
    });
    const idx = Math.min(this.calls.length - 1, this.scripts.length - 1);
    yield { type: 'text_delta' as const, text: this.scripts[idx] ?? '' };
    yield { type: 'done' as const };
  }
}

function makeChunk(overrides: Partial<ChunkRecord> = {}): ChunkRecord {
  const now = Date.now();
  return {
    id: `c-${Math.random().toString(36).slice(2, 8)}`,
    wing: 'work',
    filePath: '/x',
    lineStart: 1,
    lineEnd: 1,
    content: 'chunk content',
    tokenCount: 30,
    importance: 0.5,
    accessCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('LlmCompactor', () => {
  it('empty chunk list returns empty string', async () => {
    const model = new ScriptedModel([]);
    const summarizer = new LlmCompactor({ model });
    expect(await summarizer.summarize([])).toBe('');
    expect(model.calls).toHaveLength(0);
  });

  it('single batch produces one LLM call with the summary', async () => {
    const model = new ScriptedModel(['- summary point one\n- summary point two']);
    const summarizer = new LlmCompactor({ model, maxInputTokens: 1000 });
    const out = await summarizer.summarize([
      makeChunk({ content: 'deploy on 2026-04-17' }),
      makeChunk({ content: 'JWT bug fixed' }),
    ]);
    expect(model.calls).toHaveLength(1);
    expect(out).toContain('summary point');
    expect(model.calls[0]?.userContent).toContain('deploy on 2026-04-17');
    expect(model.calls[0]?.userContent).toContain('JWT bug fixed');
  });

  it('splits into multiple batches when input exceeds budget and reduces', async () => {
    // Two batches of partials + 1 reduce call = 3 LLM calls.
    const model = new ScriptedModel(['batch A', 'batch B', 'merged AB']);
    const summarizer = new LlmCompactor({ model, maxInputTokens: 50 });
    const out = await summarizer.summarize([
      makeChunk({ content: 'X'.repeat(100), tokenCount: 40 }),
      makeChunk({ content: 'Y'.repeat(100), tokenCount: 40 }),
      makeChunk({ content: 'Z'.repeat(100), tokenCount: 40 }),
    ]);
    expect(model.calls.length).toBeGreaterThanOrEqual(2);
    expect(out).toBe('merged AB');
  });

  it('system prompt can be overridden', async () => {
    const model = new ScriptedModel(['x']);
    const summarizer = new LlmCompactor({ model, systemPrompt: 'TEST PROMPT' });
    await summarizer.summarize([makeChunk()]);
    expect(model.calls[0]?.systemPrompt).toBe('TEST PROMPT');
  });
});
