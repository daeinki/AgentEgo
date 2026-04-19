import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { Goal, GoalStatus } from '../src/schema/goal.js';
import { generateGoalId } from '../src/ids.js';

const baseGoal = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: generateGoalId(),
  description: 'Ship v1 of the feature',
  status: 'active' as const,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  progress: 0,
  relatedSessionIds: [],
  createdBy: 'user' as const,
  ...overrides,
});

describe('Goal schema (ADR-007)', () => {
  it('accepts a valid goal', () => {
    expect(Value.Check(Goal, baseGoal())).toBe(true);
  });

  it('rejects id without `goal-` prefix', () => {
    expect(Value.Check(Goal, baseGoal({ id: 'abc-123' }))).toBe(false);
  });

  it('rejects progress outside [0, 1]', () => {
    expect(Value.Check(Goal, baseGoal({ progress: 1.1 }))).toBe(false);
    expect(Value.Check(Goal, baseGoal({ progress: -0.01 }))).toBe(false);
  });

  it('rejects unknown status', () => {
    expect(Value.Check(Goal, baseGoal({ status: 'dormant' }))).toBe(false);
  });

  it('GoalStatus enumerates exactly the 4 documented states', () => {
    for (const s of ['active', 'paused', 'completed', 'abandoned']) {
      expect(Value.Check(GoalStatus, s)).toBe(true);
    }
    expect(Value.Check(GoalStatus, 'new')).toBe(false);
  });

  it('accepts optional completionCriteria and metadata', () => {
    const full = baseGoal({
      completionCriteria: 'user confirms deployment',
      metadata: { priority: 2 },
    });
    expect(Value.Check(Goal, full)).toBe(true);
  });

  it('generateGoalId returns a value matching the schema pattern', () => {
    const id = generateGoalId();
    expect(id).toMatch(/^goal-/);
  });
});
