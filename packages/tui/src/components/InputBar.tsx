import React from 'react';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

interface Props {
  /** Invoked when the user presses Enter with non-empty content. */
  onSubmit: (text: string) => void;
  /** Whether a turn is currently streaming — disables submission. */
  busy?: boolean;
  placeholder?: string;
}

export function InputBar({ onSubmit, busy, placeholder }: Props): React.JSX.Element {
  const [value, setValue] = useState('');

  useInput((input, key) => {
    if (busy) return;
    if (key.return) {
      const trimmed = value.trim();
      if (trimmed.length === 0) return;
      onSubmit(trimmed);
      setValue('');
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta) return; // let parent handle Ctrl+N etc.
    if (input && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow) {
      setValue((v) => v + input);
    }
  });

  return (
    <Box borderStyle="round" borderColor={busy ? 'yellow' : 'cyan'} paddingX={1}>
      <Text color={busy ? 'yellow' : 'cyan'} bold>
        {busy ? '…' : '›'}{' '}
      </Text>
      {value.length === 0 && placeholder ? (
        <Text color="gray" dimColor>
          {placeholder}
        </Text>
      ) : (
        <Text>{value}</Text>
      )}
      {!busy ? <Text color="cyan">▎</Text> : null}
    </Box>
  );
}
