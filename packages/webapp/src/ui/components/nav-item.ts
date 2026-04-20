import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';

@customElement('nav-item')
export class NavItemEl extends LitElement {
  @property({ type: String })
  icon = '';

  @property({ type: String })
  label = '';

  @property({ type: Boolean, reflect: true })
  active = false;

  @property({ type: Boolean, reflect: true })
  disabled = false;

  static override styles = css`
    :host {
      display: block;
    }
    a {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      margin: 1px 8px;
      border-radius: var(--radius-sm);
      color: var(--fg-secondary);
      text-decoration: none;
      font-size: 13px;
      cursor: pointer;
    }
    a:hover {
      background: var(--bg-hover);
      color: var(--fg-primary);
    }
    :host([active]) a {
      background: var(--bg-hover);
      color: var(--fg-accent);
      font-weight: 500;
    }
    :host([disabled]) a {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .icon {
      width: 16px;
      font-size: 14px;
      text-align: center;
      color: var(--fg-muted);
    }
    :host([active]) .icon {
      color: var(--fg-accent);
    }
  `;

  override render() {
    return html`
      <a
        role="button"
        tabindex="0"
        @click=${(e: MouseEvent) => this.handleClick(e)}
        @keydown=${(e: KeyboardEvent) => this.handleKey(e)}
      >
        <span class="icon">${this.icon}</span>
        <span class="label">${this.label}</span>
      </a>
    `;
  }

  private handleClick(e: MouseEvent): void {
    if (this.disabled) {
      e.preventDefault();
      return;
    }
    this.dispatchEvent(
      new CustomEvent('nav-select', { bubbles: true, composed: true }),
    );
  }

  private handleKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.handleClick(e as unknown as MouseEvent);
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'nav-item': NavItemEl;
  }
}
