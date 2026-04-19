import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { Phase } from '@agent-platform/core';
import { isTerminalPhase } from '@agent-platform/core';
import { useRpc } from './hooks/useRpc.js';
import { StatusLine } from './components/StatusLine.js';
import { ChatHistory, TurnView, type ChatTurn } from './components/ChatHistory.js';
import { InputBar } from './components/InputBar.js';
import { PhaseLine, type PhaseIndicator } from './components/PhaseLine.js';

export interface AppProps {
  host: string;
  port: number;
  authToken: string;
  /** Conversation id passed with each chat.send — keeps server-side session stable. */
  conversationId: string;
  /** Optional session id to resume (skips history fetch if none provided). */
  sessionId?: string;
}

interface HealthInfo {
  version: string;
  uptimeMs: number;
  ports: { gateway: number };
}

export function App({ host, port, authToken, conversationId, sessionId: initialSessionId }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const url = useMemo(() => `ws://${host}:${port}/rpc`, [host, port]);
  const { client, status, error } = useRpc({ url, authToken });

  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialSessionId ?? null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  // ADR-010 §3.1.4.6 — current phase indicator for the in-flight turn.
  const [phase, setPhase] = useState<PhaseIndicator | null>(null);

  // Track which assistant turn id is currently streaming so delta notifications
  // can append to it.
  const streamingIdRef = useRef<string | null>(null);

  // Derive completed vs in-flight turns so we can render completed ones
  // through Ink's <Static> (write-once to scrollback, no re-render on delta)
  // while only the streaming tail repaints. Invariant: the streaming turn is
  // always appended last in `send()`, and flips to streaming:false atomically
  // in the .then/.catch handlers — so checking the last element is sufficient.
  const { completedTurns, streamingTurn } = useMemo(() => {
    const lastIdx = turns.length - 1;
    if (lastIdx >= 0 && turns[lastIdx]?.streaming) {
      return {
        completedTurns: turns.slice(0, lastIdx),
        streamingTurn: turns[lastIdx]!,
      };
    }
    return { completedTurns: turns, streamingTurn: null as ChatTurn | null };
  }, [turns]);

  // Initial fetch: health + (optional) history
  useEffect(() => {
    if (!client || status !== 'open') return;
    void client
      .call<HealthInfo>('gateway.health', {})
      .then((info) => setHealth(info))
      .catch(() => {});
    if (initialSessionId) {
      client
        .call<{ events: { role: string; content: string; createdAt: number; id: number }[] }>(
          'chat.history',
          { sessionId: initialSessionId, limit: 40 },
        )
        .then((res) => {
          setTurns(
            res.events.map((ev) => ({
              id: `hist-${ev.id}`,
              role: (ev.role === 'assistant' ? 'assistant' : ev.role === 'system' ? 'system' : 'user') as ChatTurn['role'],
              text: ev.content,
            })),
          );
        })
        .catch((err: Error) => setLastError(err.message));
    }
  }, [client, status, initialSessionId]);

  // Global keybindings
  useInput((input, key) => {
    if (key.ctrl && input === 'd') {
      exit();
      return;
    }
    if (key.ctrl && input === 'n') {
      // New session: clear history, let server assign a new sessionId on the
      // next chat.send (a fresh conversationId suffix forces it).
      setTurns([]);
      setActiveSessionId(null);
      return;
    }
    if (key.ctrl && input === 'l') {
      setTurns([]);
      return;
    }
  });

  const send = useCallback(
    (text: string) => {
      if (!client || status !== 'open' || busy) return;
      const userId = `u-${Date.now()}`;
      const agentId = `a-${Date.now()}`;
      streamingIdRef.current = agentId;
      setBusy(true);
      setLastError(null);
      setTurns((prev) => [
        ...prev,
        { id: userId, role: 'user', text },
        { id: agentId, role: 'assistant', text: '', streaming: true },
      ]);

      const params: Record<string, unknown> = { text, conversationId };
      if (activeSessionId) params['sessionId'] = activeSessionId;

      client
        .call<{
          sessionId: string;
          usage: { inputTokens?: number; outputTokens?: number; costUsd?: number };
        }>('chat.send', params, {
          timeoutMs: 5 * 60 * 1000,
          onNotification: (method, rawParams) => {
            const p = rawParams as {
              text?: string;
              sessionId?: string;
              phase?: Phase;
              elapsedMs?: number;
              detail?: {
                toolName?: string;
                stepIndex?: number;
                totalSteps?: number;
                attemptNumber?: number;
              };
            };
            if (method === 'chat.delta' && typeof p.text === 'string') {
              setTurns((prev) =>
                prev.map((t) => (t.id === agentId ? { ...t, text: t.text + p.text } : t)),
              );
            } else if (method === 'chat.accepted' && typeof p.sessionId === 'string') {
              setActiveSessionId(p.sessionId);
            } else if (
              method === 'chat.phase' &&
              typeof p.phase === 'string' &&
              typeof p.elapsedMs === 'number'
            ) {
              if (isTerminalPhase(p.phase) || p.phase === 'streaming_response') {
                // Terminal phases and streaming handoff both clear the indicator.
                // Streaming: ChatHistory takes over feedback. Terminal: turn is over.
                setPhase(null);
              } else {
                const next: PhaseIndicator = { phase: p.phase, elapsedMs: p.elapsedMs };
                if (p.detail?.toolName) next.toolName = p.detail.toolName;
                if (p.detail?.stepIndex !== undefined) next.stepIndex = p.detail.stepIndex;
                if (p.detail?.totalSteps !== undefined) next.totalSteps = p.detail.totalSteps;
                if (p.detail?.attemptNumber !== undefined) next.attemptNumber = p.detail.attemptNumber;
                setPhase(next);
              }
            }
          },
        })
        .then((result) => {
          setActiveSessionId(result.sessionId);
          setTurns((prev) =>
            prev.map((t) =>
              t.id === agentId ? { ...t, streaming: false, usage: result.usage } : t,
            ),
          );
        })
        .catch((err: Error) => {
          setTurns((prev) =>
            prev.map((t) =>
              t.id === agentId
                ? { ...t, streaming: false, text: t.text || `[error] ${err.message}` }
                : t,
            ),
          );
          setLastError(err.message);
        })
        .finally(() => {
          streamingIdRef.current = null;
          setBusy(false);
          setPhase(null);
        });
    },
    [client, status, busy, conversationId, activeSessionId],
  );

  const statusLineProps: React.ComponentProps<typeof StatusLine> = {
    status,
    url,
    activeSessionId,
  };
  if (health) statusLineProps.model = `v${health.version}`;
  if (error ?? lastError) statusLineProps.error = error ?? lastError;

  // Layout contract:
  //   1. Completed turns → <Static> (position:absolute, commits to terminal
  //      scrollback above the live region — rendered as a top-level sibling of
  //      the live column so its absolute positioning is not nested inside a
  //      flex parent).
  //   2. Streaming turn → TOP of the live column, DIRECTLY ABOVE StatusLine,
  //      so every response message (completed + in-flight) sits above the
  //      "connected ws://..." line. Placed explicitly inside the same flex
  //      column as StatusLine to make the ordering unambiguous (no fragment
  //      sibling surprises).
  //   3. Empty-state, StatusLine, help, InputBar, PhaseLine follow — InputBar
  //      is the entry widget; PhaseLine hangs below it per ADR-010 §3.1.4.6.
  return (
    <>
      <ChatHistory completed={completedTurns} />
      <Box flexDirection="column">
        {streamingTurn ? <TurnView turn={streamingTurn} /> : null}
        {completedTurns.length === 0 && !streamingTurn ? (
          <Box paddingX={1}>
            <Text color="gray" italic>
              No messages yet — type a question and press Enter.
            </Text>
          </Box>
        ) : null}
        <StatusLine {...statusLineProps} />
        <Box paddingX={1}>
          <Text color="gray" dimColor>
            Ctrl+N new session · Ctrl+L clear · Ctrl+D quit
          </Text>
        </Box>
        <InputBar
          onSubmit={send}
          busy={busy || status !== 'open'}
          placeholder={
            status !== 'open'
              ? `waiting for gateway at ${url}`
              : busy
                ? 'streaming response…'
                : 'type a message'
          }
        />
        <PhaseLine phase={phase} />
      </Box>
    </>
  );
}
