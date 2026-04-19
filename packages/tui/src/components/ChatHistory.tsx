import React from 'react';
import { Box, Static, Text } from 'ink';
import { formatUsage } from '../lib/format.js';

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  /** If true, this is an incomplete assistant turn still streaming. */
  streaming?: boolean;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}

/**
 * Committed-turn renderer. Wraps Ink's <Static> so each turn is written to
 * terminal scrollback exactly once — prior rows never repaint on streaming
 * deltas. Items are keyed by id; Static decides what's new by `items.length`,
 * so the caller only has to append to the array.
 *
 * Returns null when empty so it contributes no layout box (the parent must
 * still render <Static> internally via this component's tree).
 */
export function ChatHistory({ completed }: { completed: ChatTurn[] }): React.JSX.Element {
  return (
    <Static items={completed}>
      {(turn) => <TurnView key={turn.id} turn={turn} />}
    </Static>
  );
}

/**
 * Single-turn renderer — exported so App can place the in-flight (streaming)
 * turn directly in the live region, immediately above the StatusLine. This
 * guarantees the flex-column ordering instead of relying on fragment sibling
 * layout semantics.
 */
export function TurnView({ turn }: { turn: ChatTurn }): React.JSX.Element {
  const tag =
    turn.role === 'user' ? 'you' : turn.role === 'assistant' ? 'agent' : 'system';
  const tagColor =
    turn.role === 'user' ? 'cyan' : turn.role === 'assistant' ? 'green' : 'yellow';

  return (
    <Box flexDirection="column" marginBottom={1} paddingX={1}>
      <Box>
        <Text color={tagColor} bold>
          {tag.padEnd(6)}
        </Text>
        <Text>{turn.text || (turn.streaming ? '…' : '')}</Text>
        {turn.streaming ? <Text color="yellow"> ▍</Text> : null}
      </Box>
      {turn.usage && !turn.streaming ? (
        <Box marginLeft={6}>
          <Text color="gray" dimColor>
            {formatUsage(turn.usage)}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
