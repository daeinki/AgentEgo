import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { SessionSummary } from '../controllers/polling-controller.js';

@customElement('view-sessions')
export class ViewSessionsEl extends LitElement {
  @property({ attribute: false })
  sessions: SessionSummary[] = [];

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
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-weight: 500;
    }
    td.mono {
      font-family: var(--font-mono);
      font-size: 12px;
    }
    .status {
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      font-size: 11px;
      background: var(--bg-muted);
      color: var(--fg-secondary);
    }
    .status.active {
      background: rgba(47, 191, 113, 0.15);
      color: #2fbf71;
    }
    .status.hibernated {
      background: rgba(226, 179, 60, 0.15);
      color: #e2b33c;
    }
    .empty {
      color: var(--fg-muted);
      font-style: italic;
      padding: 20px 0;
    }
  `;

  override render() {
    return html`
      <h1>Sessions</h1>
      ${this.sessions.length === 0
        ? html`<p class="empty">No sessions yet.</p>`
        : html`
            <table>
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Agent</th>
                  <th>Channel</th>
                  <th>Status</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                ${this.sessions.map(
                  (s) => html`
                    <tr>
                      <td class="mono">${s.id.slice(0, 16)}…</td>
                      <td class="mono">${s.agentId}</td>
                      <td>${s.channelType}</td>
                      <td>
                        <span class="status ${s.status}">${s.status}</span>
                      </td>
                      <td>
                        ${s.updatedAt
                          ? new Date(s.updatedAt).toLocaleString()
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
    'view-sessions': ViewSessionsEl;
  }
}
