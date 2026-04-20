import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { InstanceDescriptor } from '../controllers/polling-controller.js';

@customElement('view-instances')
export class ViewInstancesEl extends LitElement {
  @property({ attribute: false })
  instances: InstanceDescriptor[] = [];

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
    .empty {
      color: var(--fg-muted);
      font-style: italic;
      padding: 20px 0;
    }
  `;

  override render() {
    return html`
      <h1>Instances</h1>
      ${this.instances.length === 0
        ? html`<p class="empty">No agent instances observed yet.</p>`
        : html`
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Sessions</th>
                  <th>Active</th>
                  <th>Hibernated</th>
                </tr>
              </thead>
              <tbody>
                ${this.instances.map(
                  (i) => html`
                    <tr>
                      <td style="font-family:var(--font-mono);">${i.agentId}</td>
                      <td>${i.sessionCount}</td>
                      <td>${i.active}</td>
                      <td>${i.hibernated}</td>
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
    'view-instances': ViewInstancesEl;
  }
}
