import React from 'react';
import { Box, Text } from 'ink';
import type { RpcStatus } from '../hooks/useRpc.js';
import { truncate } from '../lib/format.js';

// ADR-010 §3.1.4.6 formatter lives in @agent-platform/core so the TUI and the
// webapp render identical phase labels. Re-exported here for backwards
// compatibility with existing imports (`./StatusLine`).
export type { PhaseIndicator } from '@agent-platform/core';
export { formatPhase } from '@agent-platform/core';

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
