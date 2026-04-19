import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  EgoThinkingResult,
  validateEgoThinking,
  parseEgoThinkingJson,
  classifyValidationFailure,
} from '../src/schema/ego-thinking.js';

const VALID: unknown = {
  perception: {
    requestType: 'direct_answer',
    patterns: ['follow-up'],
    isFollowUp: true,
    requiresToolUse: false,
    estimatedComplexity: 'low',
  },
  cognition: {
    relevantMemoryIndices: [0],
    relatedGoalId: null,
    situationSummary: 'A brief summary.',
    opportunities: [],
    risks: [],
    egoRelevance: 0.6,
  },
  judgment: {
    action: 'passthrough',
    confidence: 0.7,
    reason: 'no intervention needed',
  },
};

describe('EgoThinkingResult schema (§5.7)', () => {
  it('accepts a valid payload', () => {
    expect(Value.Check(EgoThinkingResult, VALID)).toBe(true);
  });

  it('rejects confidence > 1 and classifies as out_of_range', () => {
    const bad = structuredClone(VALID) as any;
    bad.judgment.confidence = 1.5;
    const outcome = validateEgoThinking(bad);
    expect(outcome.ok).toBe(false);
    expect(outcome.tag).toBe('llm_out_of_range');
  });

  it('rejects confidence < 0 and classifies as out_of_range', () => {
    const bad = structuredClone(VALID) as any;
    bad.judgment.confidence = -0.1;
    const outcome = validateEgoThinking(bad);
    expect(outcome.ok).toBe(false);
    expect(outcome.tag).toBe('llm_out_of_range');
  });

  it('classifies enrich without enrichment as inconsistent_action', () => {
    const bad = structuredClone(VALID) as any;
    bad.judgment.action = 'enrich';
    // enrichment omitted entirely
    const outcome = validateEgoThinking(bad);
    expect(outcome.ok).toBe(false);
    expect(outcome.tag).toBe('llm_inconsistent_action');
  });

  it('classifies redirect with missing target as invalid_target', () => {
    const bad = structuredClone(VALID) as any;
    bad.judgment.action = 'redirect';
    bad.judgment.redirect = { reason: 'x' }; // missing targetAgentId/targetSessionId
    const outcome = validateEgoThinking(bad);
    expect(outcome.ok).toBe(false);
    expect(outcome.tag).toBe('llm_invalid_target');
  });

  it('classifies unknown action literal as schema_mismatch', () => {
    const bad = structuredClone(VALID) as any;
    bad.judgment.action = 'burninate';
    const outcome = validateEgoThinking(bad);
    expect(outcome.ok).toBe(false);
    expect(outcome.tag).toBe('llm_schema_mismatch');
  });

  it('parseEgoThinkingJson flags invalid JSON syntax', () => {
    const outcome = parseEgoThinkingJson('{not json');
    expect(outcome.ok).toBe(false);
    expect(outcome.tag).toBe('llm_invalid_json');
  });

  it('parseEgoThinkingJson accepts valid JSON', () => {
    const outcome = parseEgoThinkingJson(JSON.stringify(VALID));
    expect(outcome.ok).toBe(true);
    expect(outcome.value?.judgment.action).toBe('passthrough');
  });

  it('classifyValidationFailure exposes a stable API', () => {
    const tag = classifyValidationFailure([], { judgment: { action: 'enrich' } });
    expect(tag).toBe('llm_inconsistent_action');
  });
});
