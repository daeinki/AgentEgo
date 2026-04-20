import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

/**
 * Shown on first load when the browser has no enrolled device. Prompts for
 * the gateway's master Bearer token so a one-time `/device/enroll` can
 * happen, after which the browser uses its own ed25519 session tokens.
 */
@customElement('enroll-dialog')
export class EnrollDialogEl extends LitElement {
  @property({ type: String })
  error: string | null = null;

  @state()
  private token = '';

  @state()
  private submitting = false;

  static override styles = css`
    :host {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.45);
      z-index: 100;
    }
    .card {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      padding: 24px;
      width: min(440px, 90vw);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2);
    }
    h2 {
      margin: 0 0 8px;
      font-size: 18px;
    }
    p {
      color: var(--fg-secondary);
      font-size: 13px;
      margin: 0 0 16px;
      line-height: 1.5;
    }
    input {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      background: var(--bg-app);
      color: var(--fg-primary);
      font-family: var(--font-mono);
      font-size: 13px;
      box-sizing: border-box;
    }
    input:focus {
      outline: none;
      border-color: var(--accent);
    }
    .error {
      color: #d64545;
      font-size: 12px;
      margin-top: 8px;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 16px;
    }
    button {
      padding: 8px 16px;
      border-radius: var(--radius-sm);
      border: 0;
      cursor: pointer;
      font: inherit;
      font-size: 13px;
    }
    button[disabled] {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .primary {
      background: var(--accent);
      color: var(--accent-fg);
      font-weight: 500;
    }
  `;

  override render() {
    return html`
      <div class="card" role="dialog" aria-labelledby="enroll-title">
        <h2 id="enroll-title">Enroll this browser</h2>
        <p>
          Paste the gateway's master Bearer token. This one-time step registers
          an ed25519 keypair held in this browser — future connects use the
          device identity, not the master token.
        </p>
        <input
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="Bearer token"
          .value=${this.token}
          @input=${(e: Event) => (this.token = (e.currentTarget as HTMLInputElement).value)}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === 'Enter') this.submit();
          }}
        />
        ${this.error ? html`<p class="error">${this.error}</p>` : ''}
        <div class="actions">
          <button
            class="primary"
            ?disabled=${this.submitting || this.token.trim().length === 0}
            @click=${this.submit}
          >
            ${this.submitting ? 'Enrolling…' : 'Enroll'}
          </button>
        </div>
      </div>
    `;
  }

  private submit(): void {
    const token = this.token.trim();
    if (!token || this.submitting) return;
    this.submitting = true;
    this.dispatchEvent(
      new CustomEvent('enroll-submit', {
        detail: token,
        bubbles: true,
        composed: true,
      }),
    );
  }

  /** Called by parent after an enroll attempt resolves. */
  reset(): void {
    this.submitting = false;
    this.requestUpdate();
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'enroll-dialog': EnrollDialogEl;
  }
}
