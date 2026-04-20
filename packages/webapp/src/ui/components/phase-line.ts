import { LitElement, css, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { PhaseIndicator } from '@agent-platform/core/phase-format';
import { formatPhase } from '@agent-platform/core/phase-format';

/**
 * ADR-010 §3.1.4.6 — single-line phase indicator anchored below the chat
 * input. Renders the same label format the TUI uses (`[🔧 bash_run] 3.2s`)
 * so users see identical phase naming across surfaces.
 */
@customElement('phase-line')
export class PhaseLineEl extends LitElement {
  @property({ attribute: false })
  phase: PhaseIndicator | null = null;

  static override styles = css`
    :host {
      display: block;
      padding: 4px 12px;
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--phase-line-fg);
      min-height: var(--footer-height);
      line-height: var(--footer-height);
      transition: opacity var(--phase-line-fade-ms) ease-in-out;
    }
    :host([data-empty]) {
      opacity: 0;
    }
  `;

  override updated(): void {
    if (this.phase === null) this.setAttribute('data-empty', '');
    else this.removeAttribute('data-empty');
  }

  override render() {
    if (!this.phase) return nothing;
    return html`<span>${formatPhase(this.phase)}</span>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'phase-line': PhaseLineEl;
  }
}
