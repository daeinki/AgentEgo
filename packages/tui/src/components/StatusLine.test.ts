import { describe, it, expect } from 'vitest';
import { formatPhase } from './StatusLine.js';

describe('formatPhase (ADR-010 §3.1.4.6)', () => {
  it('renders a plain phase with elapsed seconds', () => {
    expect(formatPhase({ phase: 'ego_judging', elapsedMs: 1234 })).toBe('[◉ ego] 1.2s');
  });

  it('shows tool name when phase is tool_call', () => {
    expect(
      formatPhase({ phase: 'tool_call', elapsedMs: 3200, toolName: 'bash_run' }),
    ).toBe('[🔧 bash_run] 3.2s');
  });

  it('shows step progress when phase is executing_step', () => {
    expect(
      formatPhase({ phase: 'executing_step', elapsedMs: 5100, stepIndex: 2, totalSteps: 5 }),
    ).toBe('[▶ 2/5] 5.1s');
  });

  it('adds tool name to executing_step when present', () => {
    expect(
      formatPhase({
        phase: 'executing_step',
        elapsedMs: 5100,
        stepIndex: 2,
        totalSteps: 5,
        toolName: 'file_read',
      }),
    ).toBe('[▶ 2/5 file_read] 5.1s');
  });

  it('shows attempt number for replan phase', () => {
    expect(
      formatPhase({ phase: 'replan', elapsedMs: 8400, attemptNumber: 2 }),
    ).toBe('[↻ replan #2] 8.4s');
  });

  it('falls back to phase label when no structured detail is provided', () => {
    // tool_call without toolName still renders (fallback label).
    expect(formatPhase({ phase: 'tool_call', elapsedMs: 1000 })).toBe('[🔧 tool] 1.0s');
  });
});
