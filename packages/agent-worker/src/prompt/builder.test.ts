import { describe, it, expect } from 'vitest';
import type { SessionEvent } from '@agent-platform/core';
import { PromptBuilder } from './builder.js';

function ev(partial: Partial<SessionEvent> & Pick<SessionEvent, 'eventType' | 'role' | 'content'>): SessionEvent {
  return {
    sessionId: 's1',
    createdAt: partial.createdAt ?? 0,
    ...partial,
  } as SessionEvent;
}

describe('PromptBuilder (ADR-010 매핑 규약)', () => {
  it('drops reasoning_step events defensively even if callers pass them in', () => {
    const builder = new PromptBuilder();
    const { messages } = builder.build({
      systemPrompt: 'sys',
      sessionEvents: [
        ev({ eventType: 'user_message', role: 'user', content: 'q' }),
        ev({ eventType: 'reasoning_step', role: 'assistant', content: '{"kind":"thought"}' }),
        ev({ eventType: 'agent_response', role: 'assistant', content: 'a' }),
      ],
      userMessage: 'current',
    });

    // reasoning_step 은 드롭. user/assistant + 현재 user = 3건.
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages.every((m) => m.content !== '{"kind":"thought"}')).toBe(true);
  });

  it('merges a compaction summary into the system prompt (1건만)', () => {
    const builder = new PromptBuilder();
    const { systemPrompt, messages } = builder.build({
      systemPrompt: 'base',
      sessionEvents: [
        ev({ eventType: 'compaction', role: 'system', content: 'SUMMARY' }),
        ev({ eventType: 'user_message', role: 'user', content: 'fresh' }),
      ],
      userMessage: 'now',
    });

    expect(systemPrompt).toContain('## 이전 대화 요약');
    expect(systemPrompt).toContain('SUMMARY');
    // compaction 은 messages 에는 들어가지 않음
    expect(messages.map((m) => m.role)).toEqual(['user', 'user']);
    expect(messages.map((m) => m.content)).toEqual(['fresh', 'now']);
  });
});

describe('PromptBuilder — U10 Phase 2: EGO suggestedTools', () => {
  it('injects "EGO 추천 도구" block when suggestedTools is non-empty', () => {
    const builder = new PromptBuilder();
    const { systemPrompt } = builder.build({
      systemPrompt: 'base',
      sessionEvents: [],
      userMessage: 'q',
      egoEnrichment: { suggestedTools: ['fs.read', 'web.fetch'] },
    });
    expect(systemPrompt).toContain('## EGO 추천 도구');
    expect(systemPrompt).toContain('fs.read');
    expect(systemPrompt).toContain('web.fetch');
  });

  it('omits the block when suggestedTools is missing or empty', () => {
    const builder = new PromptBuilder();
    const noHint = builder.build({
      systemPrompt: 'base',
      sessionEvents: [],
      userMessage: 'q',
      egoEnrichment: { addContext: 'ctx' },
    });
    expect(noHint.systemPrompt).not.toContain('## EGO 추천 도구');

    const emptyHint = builder.build({
      systemPrompt: 'base',
      sessionEvents: [],
      userMessage: 'q',
      egoEnrichment: { suggestedTools: [] },
    });
    expect(emptyHint.systemPrompt).not.toContain('## EGO 추천 도구');
  });
});
