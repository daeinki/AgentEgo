import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { ThemePreference } from '../../types/index.js';
import type { ConnectionStatus } from '../controllers/rpc-client.js';
import { strings } from '../../i18n/strings.js';
import './health-indicator.js';
import './theme-toggle.js';

@customElement('app-header')
export class AppHeaderEl extends LitElement {
  @property({ type: String })
  status: ConnectionStatus = 'idle';

  @property({ type: String })
  theme: ThemePreference = 'system';

  static override styles = css`
    :host {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: var(--header-height);
      padding: 0 20px;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .logo {
      width: 26px;
      height: 26px;
      border-radius: 50%;
      background: var(--accent);
      color: var(--accent-fg);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 14px;
    }
    .title {
      font-weight: 700;
      font-size: 13px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .subtitle {
      font-size: 10px;
      color: var(--fg-muted);
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .right {
      display: flex;
      align-items: center;
      gap: 16px;
    }
  `;

  override render() {
    return html`
      <div class="brand">
        <div class="logo">A</div>
        <div>
          <div class="title">${strings.app.title}</div>
          <div class="subtitle">${strings.app.subtitle}</div>
        </div>
      </div>
      <div class="right">
        <health-indicator .status=${this.status}></health-indicator>
        <theme-toggle .value=${this.theme}></theme-toggle>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'app-header': AppHeaderEl;
  }
}
