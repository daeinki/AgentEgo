import type { Phase } from './phase.js';

/**
 * ADR-010 §3.1.4.6 — UI-facing phase indicator. Single source of truth for
 * both the TUI's `PhaseLine` component and the webapp's `<phase-line>`; kept
 * dependency-free (no Ink / React / DOM imports) so both renderers can share
 * the formatter verbatim.
 */
export interface PhaseIndicator {
  phase: Phase;
  elapsedMs: number;
  toolName?: string;
  stepIndex?: number;
  totalSteps?: number;
  attemptNumber?: number;
}

/**
 * Render a phase indicator as a compact single-line label.
 *
 * Examples:
 *   ego_judging → '[◉ ego] 1.2s'
 *   tool_call   → '[🔧 bash_run] 3.2s'
 *   executing_step → '[▶ 2/5 file_read] 5.1s'
 *   replan      → '[↻ replan #2] 8.4s'
 */
export function formatPhase(p: PhaseIndicator): string {
  const secs = (p.elapsedMs / 1000).toFixed(1);
  const label = PHASE_LABELS[p.phase] ?? p.phase;
  const icon = PHASE_ICONS[p.phase] ?? '•';

  if (p.phase === 'tool_call' && p.toolName) {
    return `[${icon} ${p.toolName}] ${secs}s`;
  }
  if (p.phase === 'executing_step' && p.stepIndex !== undefined && p.totalSteps !== undefined) {
    const tool = p.toolName ? ` ${p.toolName}` : '';
    return `[${icon} ${p.stepIndex}/${p.totalSteps}${tool}] ${secs}s`;
  }
  if (p.phase === 'replan' && p.attemptNumber !== undefined) {
    return `[${icon} replan #${p.attemptNumber}] ${secs}s`;
  }
  return `[${icon} ${label}] ${secs}s`;
}

export const PHASE_LABELS: Record<Phase, string> = {
  received: 'received',
  ego_judging: 'ego',
  reasoning_route: 'routing',
  planning: 'planning',
  executing_step: 'step',
  tool_call: 'tool',
  waiting_tool: 'waiting',
  replan: 'replan',
  streaming_response: 'streaming',
  finalizing: 'finalizing',
  complete: 'done',
  aborted: 'aborted',
  error: 'error',
};

export const PHASE_ICONS: Record<Phase, string> = {
  received: '◆',
  ego_judging: '◉',
  reasoning_route: '→',
  planning: '◈',
  executing_step: '▶',
  tool_call: '🔧',
  waiting_tool: '⋯',
  replan: '↻',
  streaming_response: '✎',
  finalizing: '◌',
  complete: '✓',
  aborted: '✕',
  error: '⚠',
};
