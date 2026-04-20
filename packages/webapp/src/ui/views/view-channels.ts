import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { ChannelDescriptor } from '../controllers/polling-controller.js';

@customElement('view-channels')
export class ViewChannelsEl extends LitElement {
  @property({ attribute: false })
  channels: ChannelDescriptor[] = [];

  static override styles = css`
    :host {
      display: block;
      padding: 24px;
      overflow-y: auto;
      height: 100%;
    }
    h1 {
      margin: 0 0 16px;
      font-size: 20px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th,
    td {
      padding: 10px 12px;
      text-align: left;
      border-bottom: 1px solid var(--border-subtle);
      font-size: 13px;
    }
    th {
      color: var(--fg-muted);
      font-weight: 500;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 6px;
      vertical-align: baseline;
    }
    .dot.connected {
      background: #2fbf71;
    }
    .dot.disconnected {
      background: var(--fg-muted);
    }
    .dot.error {
      background: #d64545;
    }
    .dot.unknown {
      background: var(--fg-muted);
    }
    .empty {
      color: var(--fg-muted);
      font-style: italic;
      padding: 20px 0;
    }
  `;

  override render() {
    return html`
      <h1>Channels</h1>
      ${this.channels.length === 0
        ? html`<p class="empty">No channel adapters registered.</p>`
        : html`
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Sessions</th>
                  <th>Last event</th>
                </tr>
              </thead>
              <tbody>
                ${this.channels.map(
                  (c) => html`
                    <tr>
                      <td style="font-family:var(--font-mono);">${c.id}</td>
                      <td>${c.type}</td>
                      <td>
                        <span class="dot ${c.status}"></span>${c.status}${c.error
                          ? html` <small style="color:#d64545;">(${c.error})</small>`
                          : ''}
                      </td>
                      <td>${c.sessionCount ?? '—'}</td>
                      <td>
                        ${c.lastEventAt
                          ? new Date(c.lastEventAt).toLocaleTimeString()
                          : '—'}
                      </td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          `}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'view-channels': ViewChannelsEl;
  }
}
