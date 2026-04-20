import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { CronTaskDescriptor } from '../controllers/polling-controller.js';

@customElement('view-cron')
export class ViewCronEl extends LitElement {
  @property({ attribute: false })
  tasks: CronTaskDescriptor[] = [];

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
    .empty {
      color: var(--fg-muted);
      font-style: italic;
      padding: 20px 0;
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
  `;

  override render() {
    return html`
      <h1>Cron Jobs</h1>
      ${this.tasks.length === 0
        ? html`<p class="empty">
            No scheduled tasks — cron scheduler is not configured.
          </p>`
        : html`
            <table>
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Spec</th>
                  <th>Status</th>
                  <th>Next run</th>
                  <th>Last run</th>
                </tr>
              </thead>
              <tbody>
                ${this.tasks.map(
                  (t) => html`
                    <tr>
                      <td class="mono">${t.id}</td>
                      <td class="mono">${t.spec}</td>
                      <td>${t.status}</td>
                      <td>
                        ${t.nextRunAt
                          ? new Date(t.nextRunAt).toLocaleString()
                          : '—'}
                      </td>
                      <td>
                        ${t.lastRunAt
                          ? new Date(t.lastRunAt).toLocaleString()
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
    'view-cron': ViewCronEl;
  }
}
