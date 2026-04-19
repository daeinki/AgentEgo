import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  Phase,
  PhaseEvent,
  PhaseEventDetail,
  TERMINAL_PHASES,
  isTerminalPhase,
} from './phase.js';

describe('PhaseEvent schema (ADR-010 §3.1.4.3)', () => {
  it('accepts a well-formed event with no detail', () => {
    const evt = {
      turnId: 'trace-abc',
      sessionId: 'sess-1',
      seq: 0,
      at: 1_700_000_000_000,
      phase: 'received' as const,
      elapsedMs: 0,
    };
    expect(Value.Check(PhaseEvent, evt)).toBe(true);
  });

  it('accepts a tool_call event with toolName in detail', () => {
    const evt = {
      turnId: 'trace-abc',
      sessionId: 'sess-1',
      seq: 3,
      at: 1_700_000_000_500,
      phase: 'tool_call' as const,
      elapsedMs: 500,
      detail: { toolName: 'bash_run' },
    };
    expect(Value.Check(PhaseEvent, evt)).toBe(true);
  });

  it('rejects an event with unknown phase', () => {
    const evt = {
      turnId: 'trace-abc',
      sessionId: 'sess-1',
      seq: 0,
      at: 1_700_000_000_000,
      phase: 'unknown_phase',
      elapsedMs: 0,
    };
    expect(Value.Check(PhaseEvent, evt)).toBe(false);
  });

  it('rejects negative elapsedMs', () => {
    const evt = {
      turnId: 'trace-abc',
      sessionId: 'sess-1',
      seq: 0,
      at: 1_700_000_000_000,
      phase: 'received' as const,
      elapsedMs: -1,
    };
    expect(Value.Check(PhaseEvent, evt)).toBe(false);
  });

  it('rejects empty turnId or sessionId', () => {
    const base = {
      seq: 0,
      at: 1_700_000_000_000,
      phase: 'received' as const,
      elapsedMs: 0,
    };
    expect(Value.Check(PhaseEvent, { ...base, turnId: '', sessionId: 's' })).toBe(false);
    expect(Value.Check(PhaseEvent, { ...base, turnId: 't', sessionId: '' })).toBe(false);
  });

  it('PhaseEventDetail.stepIndex must be ≥ 1', () => {
    expect(Value.Check(PhaseEventDetail, { stepIndex: 0 })).toBe(false);
    expect(Value.Check(PhaseEventDetail, { stepIndex: 1 })).toBe(true);
  });
});

describe('isTerminalPhase', () => {
  it('returns true for complete, aborted, error', () => {
    for (const p of ['complete', 'aborted', 'error'] as Phase[]) {
      expect(isTerminalPhase(p)).toBe(true);
    }
  });

  it('returns false for intermediate phases', () => {
    for (const p of [
      'received',
      'ego_judging',
      'reasoning_route',
      'planning',
      'executing_step',
      'tool_call',
      'waiting_tool',
      'replan',
      'streaming_response',
      'finalizing',
    ] as Phase[]) {
      expect(isTerminalPhase(p)).toBe(false);
    }
  });

  it('TERMINAL_PHASES is frozen', () => {
    expect(Object.isFrozen(TERMINAL_PHASES)).toBe(true);
  });
});
