import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { ConnectionStatus } from '../controllers/rpc-client.js';

@customElement('health-indicator')
export class HealthIndicatorEl extends LitElement {
  @property({ type: String })
  status: ConnectionStatus = 'idle';

  static override styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--fg-secondary);
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--fg-muted);
    }
    .dot[data-status='open'] {
      background: #2fbf71;
    }
    .dot[data-status='connecting'],
    .dot[data-status='reconnecting'] {
      background: #e2b33c;
      animation: pulse 1.2s ease-in-out infinite;
    }
    .dot[data-status='closed'] {
      background: #d64545;
    }
    @keyframes pulse {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.4;
      }
    }
  `;

  override render() {
    const label =
      this.status === 'open'
        ? 'Health OK'
        : this.status === 'connecting'
          ? 'Connecting…'
          : this.status === 'reconnecting'
            ? 'Reconnecting…'
            : this.status === 'closed'
              ? 'Gateway down'
              : 'Idle';
    return html`
      <span class="dot" data-status=${this.status}></span>
      <span>${label}</span>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'health-indicator': HealthIndicatorEl;
  }
}
