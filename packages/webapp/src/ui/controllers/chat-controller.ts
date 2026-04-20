import type { ReactiveController, ReactiveControllerHost } from 'lit';
import type { ChatTurn } from '../../types/index.js';
import type { GatewayController } from './gateway-controller.js';
import type { PhaseController } from './phase-controller.js';

interface ChatSendResult {
  sessionId: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  };
}

/**
 * Manages the chat transcript + in-flight send for the `/chat` view. Owns:
 *  - the turns array,
 *  - the currently streaming assistant turn id,
 *  - session id resume / reset,
 *  - phase controller clearing on completion.
 */
export class ChatController implements ReactiveController {
  private readonly host: ReactiveControllerHost;
  private readonly gateway: GatewayController;
  private readonly phase: PhaseController;
  private readonly conversationId: string;
  private streamingId: string | null = null;
  private unsubDelta: (() => void) | null = null;
  private unsubAccepted: (() => void) | null = null;

  turns: ChatTurn[] = [];
  sessionId: string | null = null;
  busy = false;
  lastError: string | null = null;

  constructor(
    host: ReactiveControllerHost,
    gateway: GatewayController,
    phase: PhaseController,
    conversationId: string,
  ) {
    this.host = host;
    this.gateway = gateway;
    this.phase = phase;
    this.conversationId = conversationId;
    host.addController(this);
  }

  hostConnected(): void {
    this.unsubDelta = this.gateway.onNotification('chat.delta', (raw) => {
      const p = raw as { text?: string } | undefined;
      // eslint-disable-next-line no-console
      console.log('[chat] delta received:', JSON.stringify(p), 'streamingId:', this.streamingId);
      if (!this.streamingId || typeof p?.text !== 'string') return;
      const delta = p.text;
      const streamingId = this.streamingId;
      this.turns = this.turns.map((t) =>
        t.id === streamingId ? { ...t, text: t.text + delta } : t,
      );
      // eslint-disable-next-line no-console
      console.log(
        '[chat] after delta, turn text len:',
        this.turns.find((t) => t.id === streamingId)?.text.length,
      );
      this.host.requestUpdate();
    });
    this.unsubAccepted = this.gateway.onNotification('chat.accepted', (raw) => {
      const p = raw as { sessionId?: string } | undefined;
      if (typeof p?.sessionId === 'string') {
        this.sessionId = p.sessionId;
        this.host.requestUpdate();
      }
    });
  }

  hostDisconnected(): void {
    this.unsubDelta?.();
    this.unsubAccepted?.();
    this.unsubDelta = null;
    this.unsubAccepted = null;
  }

  async loadHistory(limit = 40): Promise<void> {
    if (!this.sessionId) return;
    try {
      const res = await this.gateway.call<{
        events: { role: string; content: string; id: number }[];
      }>('chat.history', { sessionId: this.sessionId, limit });
      this.turns = res.events.map((ev) => ({
        id: `hist-${ev.id}`,
        role:
          ev.role === 'assistant' ? 'assistant' : ev.role === 'system' ? 'system' : 'user',
        text: ev.content,
      }));
      this.host.requestUpdate();
    } catch (err) {
      this.lastError = (err as Error).message;
      this.host.requestUpdate();
    }
  }

  newSession(): void {
    this.turns = [];
    this.sessionId = null;
    this.streamingId = null;
    this.lastError = null;
    this.phase.clear();
    this.host.requestUpdate();
  }

  async send(text: string): Promise<void> {
    if (this.busy || !text.trim()) return;
    const userId = `u-${Date.now()}`;
    const agentId = `a-${Date.now()}`;
    this.streamingId = agentId;
    this.busy = true;
    this.lastError = null;
    this.turns = [
      ...this.turns,
      { id: userId, role: 'user', text },
      { id: agentId, role: 'assistant', text: '', streaming: true },
    ];
    this.host.requestUpdate();

    const params: Record<string, unknown> = {
      text,
      conversationId: this.conversationId,
    };
    if (this.sessionId) params['sessionId'] = this.sessionId;

    try {
      const result = await this.gateway.call<ChatSendResult>('chat.send', params, {
        timeoutMs: 5 * 60_000,
      });
      this.sessionId = result.sessionId;
      // Immutable finalize of the streaming turn (see delta handler above).
      this.turns = this.turns.map((t) =>
        t.id === agentId
          ? {
              ...t,
              streaming: false,
              ...(result.usage ? { usage: result.usage } : {}),
            }
          : t,
      );
    } catch (err) {
      const msg = (err as Error).message;
      this.lastError = msg;
      this.turns = this.turns.map((t) =>
        t.id === agentId
          ? { ...t, streaming: false, text: t.text || `[error] ${msg}` }
          : t,
      );
    } finally {
      this.streamingId = null;
      this.busy = false;
      this.phase.clear();
      this.host.requestUpdate();
    }
  }
}
