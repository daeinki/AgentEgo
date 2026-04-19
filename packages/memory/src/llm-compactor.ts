import type { ChunkRecord } from './db/store.js';

/**
 * Structural subset of the runtime `ModelAdapter` — we only need streaming
 * text from a (systemPrompt, messages) pair. Keeping this narrow here means
 * memory doesn't have to depend on agent-worker.
 */
export interface CompactorModelAdapter {
  stream(request: {
    systemPrompt: string;
    messages: Array<{ role: string; content: string }>;
  }): AsyncIterable<{ type: string; text?: string }>;
}

export interface LlmCompactorOptions {
  model: CompactorModelAdapter;
  /**
   * Max input tokens worth of source chunks to feed into a single summary.
   * Anything beyond is split across multiple LLM calls and the results
   * concatenated. Default 6k tokens.
   */
  maxInputTokens?: number;
  /**
   * Target summary length (tokens) — rough upper bound communicated to the
   * model via the system prompt. Default ~300.
   */
  targetSummaryTokens?: number;
  /**
   * Override the system prompt entirely.
   */
  systemPrompt?: string;
}

const DEFAULT_SYSTEM_PROMPT_TEMPLATE = `당신은 AI 에이전트 플랫폼의 장기 기억 요약 모듈입니다.
입력으로 시간순 기억 조각들이 주어지면, 다음 규칙에 따라 하나의 요약을 작성하세요.

## 규칙
- 구체적 사실 (날짜/파일명/인물/결정)은 그대로 보존합니다.
- 반복되는 주제는 한 번만 언급합니다.
- 메타/잡담은 제거합니다.
- 출력은 한국어 마크다운 불릿 리스트로 작성합니다.
- 요약은 {{TARGET}} 토큰을 넘지 않도록 압축합니다.

## 출력 형식
요약 문장만 반환하세요. 서두·머리말·JSON 없이 불릿으로만 시작하세요.`;

function roughTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g) ?? []).length;
  return words + Math.ceil(cjk / 2);
}

/**
 * LLM-backed chunk summarizer. Used by PalaceMemorySystem's compact path as a
 * drop-in replacement for the default concat-based summary.
 */
export class LlmCompactor {
  private readonly model: CompactorModelAdapter;
  private readonly maxInputTokens: number;
  private readonly targetSummaryTokens: number;
  private readonly systemPrompt: string;

  constructor(options: LlmCompactorOptions) {
    this.model = options.model;
    this.maxInputTokens = options.maxInputTokens ?? 6000;
    this.targetSummaryTokens = options.targetSummaryTokens ?? 300;
    this.systemPrompt =
      options.systemPrompt ??
      DEFAULT_SYSTEM_PROMPT_TEMPLATE.replace('{{TARGET}}', String(this.targetSummaryTokens));
  }

  async summarize(chunks: ChunkRecord[]): Promise<string> {
    if (chunks.length === 0) return '';

    const batches = splitByTokenBudget(chunks, this.maxInputTokens);
    const partials: string[] = [];
    for (const batch of batches) {
      partials.push(await this.summarizeBatch(batch));
    }
    if (partials.length === 1) return partials[0]!;

    // Second-pass reduce when multiple batches.
    return this.summarizeText(partials.join('\n\n'));
  }

  private async summarizeBatch(chunks: ChunkRecord[]): Promise<string> {
    const input = chunks
      .map((c) => `[${new Date(c.createdAt).toISOString()}] (${c.wing}) ${c.content}`)
      .join('\n\n---\n\n');
    return this.summarizeText(input);
  }

  private async summarizeText(input: string): Promise<string> {
    let out = '';
    for await (const chunk of this.model.stream({
      systemPrompt: this.systemPrompt,
      messages: [{ role: 'user', content: input }],
    })) {
      if (chunk.type === 'text_delta' && typeof chunk.text === 'string') out += chunk.text;
    }
    return out.trim();
  }
}

function splitByTokenBudget(chunks: ChunkRecord[], budget: number): ChunkRecord[][] {
  const out: ChunkRecord[][] = [];
  let current: ChunkRecord[] = [];
  let running = 0;
  for (const c of chunks) {
    const cost = c.tokenCount ?? roughTokens(c.content);
    if (current.length > 0 && running + cost > budget) {
      out.push(current);
      current = [];
      running = 0;
    }
    current.push(c);
    running += cost;
  }
  if (current.length > 0) out.push(current);
  return out;
}
