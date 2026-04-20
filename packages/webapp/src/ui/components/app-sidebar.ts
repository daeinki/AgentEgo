import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { ViewId } from '../../types/index.js';
import { strings } from '../../i18n/strings.js';
import './nav-item.js';

interface NavEntry {
  id: ViewId | string;
  label: string;
  icon: string;
  disabled?: boolean;
}

interface NavSection {
  label: string;
  items: NavEntry[];
}

@customElement('app-sidebar')
export class AppSidebarEl extends LitElement {
  @property({ type: String })
  activeView: ViewId = 'chat';

  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: var(--sidebar-width);
      height: 100%;
      background: var(--bg-surface);
      border-right: 1px solid var(--border-subtle);
      overflow-y: auto;
    }
    .section-label {
      padding: 16px 20px 4px;
      color: var(--fg-muted);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .section-label.top {
      padding-top: 20px;
    }
    .section {
      padding-bottom: 6px;
    }
  `;

  private readonly sections: NavSection[] = [
    {
      label: strings.sidebar.chat,
      items: [{ id: 'chat', label: strings.sidebar.chat, icon: '💬' }],
    },
    {
      label: strings.sidebar.control,
      items: [
        { id: 'overview', label: strings.sidebar.overview, icon: '◰' },
        { id: 'channels', label: strings.sidebar.channels, icon: '⇌' },
        { id: 'instances', label: strings.sidebar.instances, icon: '⌘' },
        { id: 'sessions', label: strings.sidebar.sessions, icon: '◱' },
        { id: 'cron', label: strings.sidebar.cron, icon: '⏱' },
      ],
    },
    {
      label: strings.sidebar.agent,
      items: [
        { id: 'agents', label: strings.sidebar.agents, icon: '◯', disabled: true },
        { id: 'skills', label: strings.sidebar.skills, icon: '✦', disabled: true },
        { id: 'nodes', label: strings.sidebar.nodes, icon: '⬡', disabled: true },
      ],
    },
    {
      label: strings.sidebar.settings,
      items: [
        { id: 'config', label: strings.sidebar.config, icon: '⚙', disabled: true },
        { id: 'debug', label: strings.sidebar.debug, icon: '⚑', disabled: true },
        { id: 'logs', label: strings.sidebar.logs, icon: '📜', disabled: true },
      ],
    },
    {
      label: strings.sidebar.resources,
      items: [
        { id: 'docs', label: strings.sidebar.docs, icon: '📘', disabled: true },
      ],
    },
  ];

  override render() {
    return html`
      ${this.sections.map(
        (section, i) => html`
          <div class="section">
            <div class="section-label ${i === 0 ? 'top' : ''}">${section.label}</div>
            ${section.items.map(
              (item) => html`
                <nav-item
                  icon=${item.icon}
                  label=${item.label}
                  ?active=${item.id === this.activeView}
                  ?disabled=${Boolean(item.disabled)}
                  @nav-select=${() => this.select(item.id, Boolean(item.disabled))}
                ></nav-item>
              `,
            )}
          </div>
        `,
      )}
    `;
  }

  private select(id: string, disabled: boolean): void {
    if (disabled) return;
    this.dispatchEvent(
      new CustomEvent('view-select', {
        detail: id,
        bubbles: true,
        composed: true,
      }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'app-sidebar': AppSidebarEl;
  }
}
