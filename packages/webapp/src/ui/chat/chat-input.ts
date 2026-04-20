import { LitElement, css, html } from 'lit';
import { customElement, property, state, query } from 'lit/decorators.js';
import { strings } from '../../i18n/strings.js';

@customElement('chat-input')
export class ChatInputEl extends LitElement {
  @property({ type: Boolean })
  busy = false;

  @state()
  private draft = '';

  @query('textarea')
  private textarea!: HTMLTextAreaElement;

  static override styles = css`
    :host {
      display: block;
      border-top: 1px solid var(--border-subtle);
      background: var(--bg-surface);
      padding: 12px 16px 8px;
    }
    .frame {
      display: flex;
      align-items: flex-end;
      gap: 12px;
      border: 1px solid var(--accent);
      border-radius: var(--radius-md);
      padding: 8px 10px;
      background: var(--bg-app);
    }
    textarea {
      flex: 1 1 auto;
      resize: none;
      border: 0;
      outline: none;
      background: transparent;
      color: var(--fg-primary);
      font: inherit;
      font-size: 14px;
      line-height: 1.4;
      min-height: 24px;
      max-height: 200px;
    }
    textarea::placeholder {
      color: var(--fg-muted);
    }
    .actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    button {
      font: inherit;
      font-size: 13px;
      padding: 6px 14px;
      border-radius: var(--radius-sm);
      border: 0;
      cursor: pointer;
      transition: background 120ms ease;
    }
    button[disabled] {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .new-session {
      background: transparent;
      color: var(--fg-secondary);
    }
    .new-session:hover:not([disabled]) {
      background: var(--bg-hover);
      color: var(--fg-primary);
    }
    .send {
      background: var(--accent);
      color: var(--accent-fg);
      font-weight: 500;
    }
    .send:hover:not([disabled]) {
      filter: brightness(1.08);
    }
  `;

  override render() {
    return html`
      <div class="frame">
        <textarea
          .value=${this.draft}
          placeholder=${strings.chat.placeholder}
          rows="1"
          ?disabled=${this.busy}
          @input=${this.handleInput}
          @keydown=${this.handleKey}
        ></textarea>
      </div>
      <div class="actions" style="justify-content: flex-end; margin-top: 8px;">
        <button
          class="new-session"
          type="button"
          ?disabled=${this.busy}
          @click=${this.handleNewSession}
        >
          ${strings.chat.newSession}
        </button>
        <button
          class="send"
          type="button"
          ?disabled=${this.busy || this.draft.trim().length === 0}
          @click=${this.handleSend}
        >
          ${strings.chat.send}
        </button>
      </div>
    `;
  }

  private handleInput(e: Event): void {
    const el = e.currentTarget as HTMLTextAreaElement;
    this.draft = el.value;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }

  private handleKey(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.handleSend();
    }
  }

  private handleSend(): void {
    const text = this.draft.trim();
    if (!text || this.busy) return;
    this.dispatchEvent(
      new CustomEvent('chat-send', {
        detail: text,
        bubbles: true,
        composed: true,
      }),
    );
    this.draft = '';
    if (this.textarea) {
      this.textarea.value = '';
      this.textarea.style.height = 'auto';
    }
  }

  private handleNewSession(): void {
    this.dispatchEvent(
      new CustomEvent('chat-new-session', { bubbles: true, composed: true }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'chat-input': ChatInputEl;
  }
}
