import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { PersonaFeedback } from '@agent-platform/core';

/**
 * Structural subset of the runtime ModelAdapter — just streaming text.
 * Keeps ego free of a direct dependency on agent-worker.
 */
export interface FeedbackParserModelAdapter {
  stream(request: {
    systemPrompt: string;
    messages: Array<{ role: string; content: string }>;
  }): AsyncIterable<{ type: string; text?: string }>;
}

const PersonaFeedbackArray = Type.Array(
  Type.Union([
    Type.Object({
      type: Type.Literal('explicit-instruction'),
      instruction: Type.String(),
      appliesTo: Type.String(),
    }),
    Type.Object({
      type: Type.Literal('correction'),
      original: Type.String(),
      corrected: Type.String(),
      pattern: Type.String(),
    }),
    Type.Object({
      type: Type.Literal('positive-feedback'),
      context: Type.String(),
      behavior: Type.String(),
    }),
    Type.Object({
      type: Type.Literal('negative-feedback'),
      context: Type.String(),
      behavior: Type.String(),
      severity: Type.Union([Type.Literal('mild'), Type.Literal('strong')]),
    }),
    Type.Object({
      type: Type.Literal('implicit'),
      observation: Type.String(),
      suggestedBehavior: Type.String(),
    }),
    Type.Object({
      type: Type.Literal('domain-exposure'),
      domain: Type.String(),
      subtopic: Type.String(),
      interactionCount: Type.Integer({ minimum: 0 }),
    }),
  ]),
);
type FeedbackArray = Static<typeof PersonaFeedbackArray>;

const DEFAULT_SYSTEM_PROMPT = `당신은 AI 에이전트의 페르소나 학습 신호를 추출하는 모듈입니다.
사용자 메시지와 직전 에이전트 응답을 받아, 관찰된 학습 신호를 JSON 배열로 반환합니다.

## 신호 유형
- explicit-instruction: 사용자가 스타일/행동을 직접 지시 (예: "좀 더 간결하게 말해줘")
  → { type, instruction, appliesTo: 'verbosity' | 'formality' | 'humor' | ... }
- correction: 이전 답변을 수정 요청
  → { type, original, corrected, pattern }
- positive-feedback: 긍정 반응 ("좋아", "정확해", "고마워")
  → { type, context, behavior }
- negative-feedback: 부정 반응 ("틀렸어", "별로야"); severity는 'mild' | 'strong'
  → { type, context, behavior, severity }
- implicit: 반복 행동 패턴 관찰 (예: 매번 아침 인사 직후 일정 묻기)
  → { type, observation, suggestedBehavior }
- domain-exposure: 특정 주제 대화 지속
  → { type, domain, subtopic, interactionCount }

## 출력 규칙
- JSON 배열로만 응답. 신호가 없으면 빈 배열 [].
- 확실한 신호만. 모호한 경우 생략.
- 마크다운 코드블록 없이 JSON 원본만.
`;

export interface LlmFeedbackParserOptions {
  model: FeedbackParserModelAdapter;
  systemPrompt?: string;
}

export interface ParseParams {
  userMessage: string;
  agentResponse: string;
  /**
   * Optional prior turn context. Parser prompts the LLM with whatever's
   * supplied here verbatim.
   */
  recentContext?: string;
}

/**
 * Extract structured `PersonaFeedback` signals from a raw user/agent turn
 * using an LLM. Output is validated against `PersonaFeedback` schema; invalid
 * entries are dropped.
 */
export class LlmFeedbackParser {
  private readonly model: FeedbackParserModelAdapter;
  private readonly systemPrompt: string;

  constructor(options: LlmFeedbackParserOptions) {
    this.model = options.model;
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  }

  async parse(params: ParseParams): Promise<PersonaFeedback[]> {
    const user =
      `## 사용자 메시지\n${params.userMessage}\n\n` +
      `## 직전 에이전트 응답\n${params.agentResponse}` +
      (params.recentContext ? `\n\n## 추가 맥락\n${params.recentContext}` : '');

    let raw = '';
    for await (const chunk of this.model.stream({
      systemPrompt: this.systemPrompt,
      messages: [{ role: 'user', content: user }],
    })) {
      if (chunk.type === 'text_delta' && typeof chunk.text === 'string') raw += chunk.text;
    }

    // Strip markdown fences if present.
    const body = stripCodeFences(raw.trim());
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];

    // Validate each item independently — don't throw if some are malformed.
    const valid: PersonaFeedback[] = [];
    for (const item of parsed) {
      if (Value.Check(PersonaFeedbackArray, [item])) {
        valid.push(...([item] as FeedbackArray) as PersonaFeedback[]);
      }
    }
    return valid;
  }
}

function stripCodeFences(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  return match ? match[1]!.trim() : text;
}
