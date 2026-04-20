import type { ReactiveController, ReactiveControllerHost } from 'lit';
import type { Phase, PhaseEventDetail } from '@agent-platform/core/phase';
import { isTerminalPhase } from '@agent-platform/core/phase';
import type { PhaseIndicator } from '@agent-platform/core/phase-format';
import type { GatewayController } from './gateway-controller.js';

/**
 * ADR-010 §3.1.4.6 — subscribe to `chat.phase` notifications and expose the
 * current in-flight PhaseIndicator for `<phase-line>` to render. Terminal
 * phases (complete/aborted/error) and the streaming_response handoff both
 * clear the indicator, mirroring the TUI's behavior in App.tsx.
 */
export class PhaseController implements ReactiveController {
  private readonly host: ReactiveControllerHost;
  private readonly gateway: GatewayController;
  private unsub: (() => void) | null = null;
  private _phase: PhaseIndicator | null = null;

  constructor(host: ReactiveControllerHost, gateway: GatewayController) {
    this.host = host;
    this.gateway = gateway;
    host.addController(this);
  }

  hostConnected(): void {
    this.unsub = this.gateway.onNotification('chat.phase', (raw) => {
      const p = raw as {
        phase?: Phase;
        elapsedMs?: number;
        detail?: PhaseEventDetail;
      };
      if (typeof p.phase !== 'string' || typeof p.elapsedMs !== 'number') {
        return;
      }
      if (isTerminalPhase(p.phase) || p.phase === 'streaming_response') {
        this._phase = null;
        this.host.requestUpdate();
        return;
      }
      const next: PhaseIndicator = { phase: p.phase, elapsedMs: p.elapsedMs };
      const d = p.detail;
      if (d?.toolName) next.toolName = d.toolName;
      if (d?.stepIndex !== undefined) next.stepIndex = d.stepIndex;
      if (d?.totalSteps !== undefined) next.totalSteps = d.totalSteps;
      if (d?.attemptNumber !== undefined) next.attemptNumber = d.attemptNumber;
      this._phase = next;
      this.host.requestUpdate();
    });
  }

  hostDisconnected(): void {
    this.unsub?.();
    this.unsub = null;
  }

  get current(): PhaseIndicator | null {
    return this._phase;
  }

  /** Callable by the chat controller when a request finishes (success or error). */
  clear(): void {
    if (this._phase !== null) {
      this._phase = null;
      this.host.requestUpdate();
    }
  }
}
