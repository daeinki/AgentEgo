import React from 'react';
import { Box, Text, useInput } from 'ink';
import { useRef, useState } from 'react';

interface Props {
  /** Invoked when the user presses Enter with non-empty content. */
  onSubmit: (text: string) => void;
  /** Whether a turn is currently streaming — disables submission. */
  busy?: boolean;
  placeholder?: string;
}

const HISTORY_CAP = 100;

export function InputBar({ onSubmit, busy, placeholder }: Props): React.JSX.Element {
  const [value, setValue] = useState('');
  // Submitted inputs, oldest → newest. Ref (not state) because navigating the
  // list doesn't need to trigger a re-render of the history itself — only
  // `value`/`cursor` changes are visible.
  const historyRef = useRef<string[]>([]);
  // null = editing a fresh draft; otherwise index into historyRef.current.
  const [cursor, setCursor] = useState<number | null>(null);
  // Buffer for the in-flight draft the user was typing before they pressed ↑
  // for the first time. Restored when ↓ returns past the newest entry.
  const draftRef = useRef<string>('');

  useInput((input, key) => {
    if (busy) return;
    if (key.return) {
      const trimmed = value.trim();
      if (trimmed.length === 0) return;
      const hist = historyRef.current;
      if (hist.length === 0 || hist[hist.length - 1] !== trimmed) {
        hist.push(trimmed);
        if (hist.length > HISTORY_CAP) hist.splice(0, hist.length - HISTORY_CAP);
      }
      onSubmit(trimmed);
      setValue('');
      setCursor(null);
      draftRef.current = '';
      return;
    }
    if (key.upArrow || (key.ctrl && input === 'p')) {
      const hist = historyRef.current;
      if (hist.length === 0) return;
      if (cursor === null) {
        draftRef.current = value;
        const next = hist.length - 1;
        setCursor(next);
        setValue(hist[next]!);
      } else if (cursor > 0) {
        const next = cursor - 1;
        setCursor(next);
        setValue(hist[next]!);
      }
      return;
    }
    if (key.downArrow) {
      if (cursor === null) return;
      const hist = historyRef.current;
      if (cursor >= hist.length - 1) {
        setCursor(null);
        setValue(draftRef.current);
      } else {
        const next = cursor + 1;
        setCursor(next);
        setValue(hist[next]!);
      }
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      if (cursor !== null) setCursor(null);
      return;
    }
    if (key.ctrl || key.meta) return; // let parent handle Ctrl+N etc.
    if (input && !key.leftArrow && !key.rightArrow) {
      setValue((v) => v + input);
      if (cursor !== null) setCursor(null);
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
