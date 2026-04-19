import React from 'react';
import { Box, Text } from 'ink';
import { formatPhase, type PhaseIndicator } from './StatusLine.js';

export type { PhaseIndicator };

interface Props {
  phase: PhaseIndicator | null;
}

/**
 * ADR-010 §3.1.4.6 — single-line phase indicator rendered directly beneath
 * the InputBar. Returns null (not an empty <Box/>) when no phase is active
 * so Ink can fully collapse the slot.
 */
export function PhaseLine({ phase }: Props): React.JSX.Element | null {
  if (!phase) return null;
  return (
    <Box paddingX={1}>
      <Text color="yellow" dimColor>
        {formatPhase(phase)}
      </Text>
    </Box>
  );
}
