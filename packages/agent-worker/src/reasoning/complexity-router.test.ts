import { describe, it, expect } from 'vitest';
import type { Contracts, StandardMessage } from '@agent-platform/core';
import { generateMessageId, generateTraceId, nowMs } from '@agent-platform/core';
import { DefaultComplexityRouter, countImperativeVerbs, countSentences } from './complexity-router.js';

function makeMsg(text: string): StandardMessage {
  return {
    id: generateMessageId(),
    traceId: generateTraceId(),
    timestamp: nowMs(),
    channel: { type: 'webchat', id: 'w-1', metadata: {} },
    sender: { id: 'u', isOwner: true },
    conversation: { type: 'dm', id: 'c-1' },
    content: { type: 'text', text },
  };
}

const toolSet = (n: number): Contracts.ToolDescriptor[] =>
  Array.from({ length: n }, (_, i) => ({
    name: `t${i}`,
    description: `tool ${i}`,
    inputSchema: {},
  }));

describe('DefaultComplexityRouter — decision tree', () => {
  const router = new DefaultComplexityRouter();

  it('R1: EGO off, simple question → react', () => {
    expect(
      router.select({ userMessage: makeMsg('지금 시각?'), availableTools: toolSet(5) }),
    ).toBe('react');
  });

  it('R2: estimatedComplexity=low → react', () => {
    expect(
      router.select({
        userMessage: makeMsg('anything'),
        availableTools: toolSet(5),
        egoPerception: {
          requestType: 'direct_answer',
          patterns: [],
          isFollowUp: false,
          requiresToolUse: false,
          estimatedComplexity: 'low',
        },
      }),
    ).toBe('react');
  });

  it('R3: estimatedComplexity=medium → plan_execute', () => {
    expect(
      router.select({
        userMessage: makeMsg('anything'),
        availableTools: toolSet(5),
        egoPerception: {
          requestType: 'tool_assisted',
          patterns: [],
          isFollowUp: false,
          requiresToolUse: true,
          estimatedComplexity: 'medium',
        },
      }),
    ).toBe('plan_execute');
  });

  it('R4: workflow_execution forces plan_execute even if complexity=low', () => {
    expect(
      router.select({
        userMessage: makeMsg('x'),
        availableTools: toolSet(5),
        egoPerception: {
          requestType: 'workflow_execution',
          patterns: [],
          isFollowUp: false,
          requiresToolUse: true,
          estimatedComplexity: 'low',
        },
      }),
    ).toBe('plan_execute');
  });

  it('R5: EGO off, multi-sentence + multi-imperative + many tools → plan_execute', () => {
    expect(
      router.select({
        userMessage: makeMsg('파일을 읽어서 요약해. 그리고 CSV 로 저장해.'),
        availableTools: toolSet(5),
      }),
    ).toBe('plan_execute');
  });

  it('R6: forceMode=react overrides a high-complexity input', () => {
    expect(
      router.select({
        userMessage: makeMsg('파일 읽고 요약하고 CSV 저장해'),
        availableTools: toolSet(5),
        egoPerception: {
          requestType: 'workflow_execution',
          patterns: [],
          isFollowUp: false,
          requiresToolUse: true,
          estimatedComplexity: 'high',
        },
        forceMode: 'react',
      }),
    ).toBe('react');
  });

  it('empty tools → react (short-circuits all other rules)', () => {
    expect(
      router.select({
        userMessage: makeMsg('anything'),
        availableTools: [],
        egoPerception: {
          requestType: 'workflow_execution',
          patterns: [],
          isFollowUp: false,
          requiresToolUse: true,
          estimatedComplexity: 'high',
        },
      }),
    ).toBe('react');
  });
});

describe('heuristic helpers', () => {
  it('countSentences splits on ./!/?/。/？/！', () => {
    expect(countSentences('hello.')).toBe(1);
    expect(countSentences('a. b. c.')).toBe(3);
    expect(countSentences('파일 읽어줘. 그리고 저장해!')).toBe(2);
  });

  it('countImperativeVerbs catches Korean and English imperatives', () => {
    expect(countImperativeVerbs('파일을 읽고 요약해줘')).toBeGreaterThanOrEqual(1);
    expect(countImperativeVerbs('list all files and summarize each')).toBeGreaterThanOrEqual(2);
    expect(countImperativeVerbs('hello world')).toBe(0);
  });
});
