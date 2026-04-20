import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type {
  OverviewStatus,
  ChannelDescriptor,
} from '../controllers/polling-controller.js';

@customElement('view-overview')
export class ViewOverviewEl extends LitElement {
  @property({ attribute: false })
  overview: OverviewStatus | null = null;

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
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }
    .card {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 16px;
    }
    .card .k {
      font-size: 11px;
      letter-spacing: 0.06em;
      color: var(--fg-muted);
      text-transform: uppercase;
    }
    .card .v {
      font-size: 20px;
      font-weight: 600;
      margin-top: 4px;
    }
    .card .v .unit {
      font-size: 12px;
      color: var(--fg-muted);
      font-weight: 400;
      margin-left: 4px;
    }
    .empty {
      color: var(--fg-muted);
      font-style: italic;
    }
  `;

  override render() {
    const o = this.overview;
    return html`
      <h1>Overview</h1>
      ${o
        ? html`
            <div class="cards">
              <div class="card">
                <div class="k">Version</div>
                <div class="v">${o.version}</div>
              </div>
              <div class="card">
                <div class="k">Uptime</div>
                <div class="v">${formatUptime(o.uptimeMs)}</div>
              </div>
              <div class="card">
                <div class="k">Sessions</div>
                <div class="v">${o.sessionCount}</div>
              </div>
              <div class="card">
                <div class="k">Active agents</div>
                <div class="v">${o.activeAgents.length}</div>
              </div>
              <div class="card">
                <div class="k">Channels</div>
                <div class="v">${o.channelCount}</div>
              </div>
              <div class="card">
                <div class="k">Memory</div>
                <div class="v">${o.memMB}<span class="unit">MB</span></div>
              </div>
              <div class="card">
                <div class="k">PID</div>
                <div class="v">${o.pid}</div>
              </div>
            </div>
          `
        : html`<p class="empty">Waiting for gateway snapshot…</p>`}
      ${o && o.activeAgents.length > 0
        ? html`
            <h2 style="font-size:14px;margin:0 0 8px;color:var(--fg-secondary);">
              Active agents
            </h2>
            <ul
              style="margin:0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:6px;"
            >
              ${o.activeAgents.map(
                (a) => html`<li
                  style="padding:4px 10px;background:var(--bg-muted);border-radius:var(--radius-sm);font-family:var(--font-mono);font-size:12px;"
                >
                  ${a}
                </li>`,
              )}
            </ul>
          `
        : nothing}
    `;
  }
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

declare global {
  interface HTMLElementTagNameMap {
    'view-overview': ViewOverviewEl;
  }
}
