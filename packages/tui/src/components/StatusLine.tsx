import React from 'react';
import { Box, Text } from 'ink';
import type { Phase } from '@agent-platform/core';
import type { RpcStatus } from '../hooks/useRpc.js';
import { truncate } from '../lib/format.js';

export interface PhaseIndicator {
  phase: Phase;
  elapsedMs: number;
  toolName?: string;
  stepIndex?: number;
  totalSteps?: number;
  attemptNumber?: number;
}

interface Props {
  status: RpcStatus;
  url: string;
  activeSessionId: string | null;
  model?: string;
  error?: string | null;
}

export function StatusLine({
  status,
  url,
  activeSessionId,
  model,
  error,
}: Props): React.JSX.Element {
  const statusColor =
    status === 'open' ? 'green' : status === 'reconnecting' ? 'yellow' : status === 'connecting' ? 'cyan' : 'red';
  const statusLabel =
    status === 'open'
      ? '● connected'
      : status === 'connecting'
        ? '● connecting…'
        : status === 'reconnecting'
          ? '● reconnecting…'
          : '● disconnected';

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
      <Box>
        <Text color={statusColor}>{statusLabel}</Text>
        <Text color="gray">  {url}</Text>
      </Box>
      <Box>
        {model ? <Text color="magenta">{model}  </Text> : null}
        <Text color="gray">session: </Text>
        <Text color="cyan">{activeSessionId ? truncate(activeSessionId, 12) : '(new)'}</Text>
        {error ? <Text color="red">  err: {truncate(error, 40)}</Text> : null}
      </Box>
    </Box>
  );
}

/**
 * Render a phase indicator per ADR-010 §3.1.4.6. Phase-only — no ETA, no
 * progress percentage, just "what kind of work + how long so far".
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

const PHASE_LABELS: Record<Phase, string> = {
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

const PHASE_ICONS: Record<Phase, string> = {
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
