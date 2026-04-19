import type { SessionEvent } from '@agent-platform/core';
import type { CompletionMessage } from '../model/types.js';

export interface PromptContext {
  systemPrompt: string;
  sessionEvents: SessionEvent[];
  userMessage: string;
  /**
   * Additional context injected by the EGO enrich path. Appears as a system
   * preamble directly before the user message, so the model sees "EGO" hints
   * without them being confused with prior turns.
   */
  egoEnrichment?: {
    addContext?: string;
    addInstructions?: string;
    memories?: string[];
    /**
     * U10 Phase 2: EGO가 이 턴에 적합하다고 판단해 힌트로 제시한 도구 이름들.
     * PromptBuilder 는 이를 system prompt 의 `## EGO 추천 도구` 블록으로 주입한다.
     * 실제 availableTools 를 바꾸진 않으며, LLM 에 "있다면 검토해보라" 는 힌트만 제공.
     */
    suggestedTools?: string[];
  };
}

/**
 * Basic single-layer prompt builder for Phase 1.
 * Converts session history + user message into LLM completion messages.
 */
export class PromptBuilder {
  private defaultSystemPrompt = `You are a helpful AI assistant. Respond concisely and accurately.`;

  build(ctx: PromptContext): { systemPrompt: string; messages: CompletionMessage[] } {
    let systemPrompt = ctx.systemPrompt || this.defaultSystemPrompt;

    if (ctx.egoEnrichment) {
      const parts: string[] = [];
      if (ctx.egoEnrichment.addContext) {
        parts.push(`## EGO 맥락\n${ctx.egoEnrichment.addContext}`);
      }
      if (ctx.egoEnrichment.memories?.length) {
        parts.push(
          `## 관련 기억\n${ctx.egoEnrichment.memories.map((m) => `- ${m}`).join('\n')}`,
        );
      }
      if (ctx.egoEnrichment.addInstructions) {
        parts.push(`## EGO 지시\n${ctx.egoEnrichment.addInstructions}`);
      }
      if (ctx.egoEnrichment.suggestedTools?.length) {
        parts.push(
          `## EGO 추천 도구\n` +
            `다음 도구가 이 요청에 적합할 가능성이 높습니다: ${ctx.egoEnrichment.suggestedTools.join(', ')}.\n` +
            `(반드시 사용해야 하는 것은 아님 — 실제 availableTools 에 등록돼 있고 적절하다고 판단될 때만 호출하세요.)`,
        );
      }
      if (parts.length) {
        systemPrompt = `${systemPrompt}\n\n${parts.join('\n\n')}`;
      }
    }

    const messages: CompletionMessage[] = [];

    // Convert session events to completion messages (ADR-010 매핑 규약)
    //   - user_message → role:'user'
    //   - agent_response → role:'assistant'
    //   - tool_result → role:'tool'
    //   - compaction → systemPrompt 에 요약 블록으로 합류 (최신 1건만)
    //   - reasoning_step → 방어적 드롭 (관측 전용, loadHistory 기본값에서도 제외됨)
    //   - tool_call / system → 본 빌더에서는 스킵 (Phase 1 단일 계층 프롬프트)
    let compactionSummary: string | undefined;
    for (const event of ctx.sessionEvents) {
      if (event.eventType === 'user_message') {
        messages.push({ role: 'user', content: event.content });
      } else if (event.eventType === 'agent_response') {
        messages.push({ role: 'assistant', content: event.content });
      } else if (event.eventType === 'tool_result') {
        messages.push({
          role: 'tool',
          content: event.content,
          toolCallId: event.traceId,
        });
      } else if (event.eventType === 'compaction') {
        if (compactionSummary === undefined) compactionSummary = event.content;
      }
      // tool_call, reasoning_step, system → drop
    }

    if (compactionSummary !== undefined) {
      systemPrompt = `${systemPrompt}\n\n## 이전 대화 요약\n${compactionSummary}`;
    }

    // Add current user message
    messages.push({ role: 'user', content: ctx.userMessage });

    return { systemPrompt, messages };
  }
}
