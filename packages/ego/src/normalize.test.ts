import { describe, it, expect } from 'vitest';
import {
  classifyIntent,
  classifyUrgency,
  classifySentiment,
  extractEntities,
  normalize,
  shouldFastExit,
} from './normalize.js';
import { intake } from './signal.js';
import type { EgoFullConfig, StandardMessage } from '@agent-platform/core';
import { generateMessageId, generateTraceId, nowMs } from '@agent-platform/core';

function make(text: string): StandardMessage {
  return {
    id: generateMessageId(),
    traceId: generateTraceId(),
    timestamp: nowMs(),
    channel: { type: 'webchat', id: 'w-1', metadata: {} },
    sender: { id: 'user-1', isOwner: true },
    conversation: { type: 'dm', id: 'c-1' },
    content: { type: 'text', text },
  };
}

describe('classifyIntent', () => {
  it('detects greeting', () => {
    expect(classifyIntent(intake(make('안녕'))).primary).toBe('greeting');
    expect(classifyIntent(intake(make('hello'))).primary).toBe('greeting');
  });

  it('detects question via ? suffix', () => {
    expect(classifyIntent(intake(make('이 API 써도 돼?'))).primary).toBe('question');
  });

  it('detects instruction', () => {
    expect(classifyIntent(intake(make('PR 만들어줘'))).primary).toBe('instruction');
  });

  it('detects feedback', () => {
    expect(classifyIntent(intake(make('잘했어 감사'))).primary).toBe('feedback');
  });

  it('falls back to conversation', () => {
    expect(classifyIntent(intake(make('오늘 날씨 좋네'))).primary).toBe('conversation');
  });
});

describe('classifyUrgency', () => {
  it('detects critical keywords', () => {
    expect(classifyUrgency('긴급! 서버 다운')).toBe('critical');
  });

  it('detects high via multiple exclamation marks', () => {
    expect(classifyUrgency('now!!')).toBe('high');
  });

  it('detects low', () => {
    expect(classifyUrgency('나중에 봐주면 돼')).toBe('low');
  });

  it('defaults to normal', () => {
    expect(classifyUrgency('그냥 궁금해서')).toBe('normal');
  });
});

describe('classifySentiment', () => {
  it('returns positive valence for approval', () => {
    expect(classifySentiment('정말 좋아 최고!').valence).toBeGreaterThan(0);
  });

  it('returns negative valence for complaint', () => {
    expect(classifySentiment('완전 짜증나 틀렸어').valence).toBeLessThan(0);
  });
});

describe('extractEntities', () => {
  it('extracts filepaths, mentions, dates, and numbers', () => {
    const entities = extractEntities('@alice 2026-04-20에 src/app.ts 를 5회 변경');
    const types = entities.map((e) => e.type);
    expect(types).toContain('mention');
    expect(types).toContain('date');
    expect(types).toContain('filepath');
    expect(types).toContain('number');
  });
});

describe('shouldFastExit', () => {
  const config = {
    fastPath: {
      passthroughIntents: ['greeting', 'command', 'reaction'],
      passthroughPatterns: ['^/(reset|status)'],
      maxComplexityForPassthrough: 'simple',
      targetRatio: 0.75,
      measurementWindowDays: 7,
    },
  } as unknown as EgoFullConfig;

  it('exits on passthrough intent', () => {
    const normalized = normalize(intake(make('안녕')));
    expect(shouldFastExit(normalized, config)).toBe(true);
  });

  it('exits when text matches a passthrough pattern', () => {
    const normalized = normalize(intake(make('/status')));
    expect(shouldFastExit(normalized, config)).toBe(true);
  });

  it('does NOT exit for complex messages', () => {
    const long =
      '이 프로젝트의 아키텍처를 분석하고 성능과 보안 측면에서 개선점을 찾은 뒤, ' +
      '각각에 대한 리팩토링 계획을 구체적으로 세워서 단계별로 실행 가능한 PR로 나눠줘.';
    const normalized = normalize(intake(make(long)));
    expect(shouldFastExit(normalized, config)).toBe(false);
  });
});
