import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { ThemePreference } from '../../types/index.js';

@customElement('theme-toggle')
export class ThemeToggleEl extends LitElement {
  @property({ type: String })
  value: ThemePreference = 'system';

  static override styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 2px;
      background: var(--bg-muted);
      border-radius: var(--radius-md);
    }
    button {
      background: transparent;
      border: 0;
      padding: 4px 10px;
      border-radius: var(--radius-sm);
      color: var(--fg-secondary);
      font: inherit;
      font-size: 11px;
      cursor: pointer;
    }
    button[aria-pressed='true'] {
      background: var(--bg-surface);
      color: var(--fg-primary);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
    }
  `;

  override render() {
    const opts: Array<{ id: ThemePreference; label: string }> = [
      { id: 'light', label: '☀' },
      { id: 'dark', label: '☾' },
      { id: 'system', label: '◐' },
    ];
    return html`
      ${opts.map(
        (o) => html`
          <button
            type="button"
            aria-pressed=${o.id === this.value}
            title=${o.id}
            @click=${() => this.emit(o.id)}
          >
            ${o.label}
          </button>
        `,
      )}
    `;
  }

  private emit(value: ThemePreference): void {
    this.dispatchEvent(
      new CustomEvent('theme-change', { detail: value, bubbles: true, composed: true }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'theme-toggle': ThemeToggleEl;
  }
}
