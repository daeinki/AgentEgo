import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { unsafeHTML } from 'lit/directives/unsafe-html.js';
import { renderMarkdown } from '../../markdown.js';

@customElement('chat-bubble')
export class ChatBubbleEl extends LitElement {
  @property({ type: String })
  override role: 'user' | 'assistant' | 'system' = 'user';

  @property({ type: String })
  text = '';

  @property({ type: Boolean })
  streaming = false;

  static override styles = css`
    :host {
      display: flex;
      padding: 8px 24px;
    }
    :host([data-role='user']) {
      justify-content: flex-end;
    }
    .bubble {
      max-width: 70%;
      padding: 10px 14px;
      border-radius: var(--radius-lg);
      font-size: 14px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    :host([data-role='user']) .bubble {
      background: var(--chat-bubble-user-bg);
      color: var(--chat-bubble-user-fg);
      border-bottom-right-radius: var(--radius-sm);
    }
    :host([data-role='assistant']) .bubble {
      background: var(--chat-bubble-assistant-bg);
      color: var(--chat-bubble-assistant-fg);
      border-bottom-left-radius: var(--radius-sm);
    }
    :host([data-role='system']) .bubble {
      background: transparent;
      color: var(--fg-muted);
      font-style: italic;
      font-size: 12px;
      text-align: center;
      max-width: 90%;
      margin: 0 auto;
    }
    .meta {
      font-size: 11px;
      color: var(--fg-muted);
      margin-bottom: 2px;
      padding: 0 8px;
    }
    :host([data-role='user']) .meta {
      text-align: right;
    }
    .bubble :first-child {
      margin-top: 0;
    }
    .bubble :last-child {
      margin-bottom: 0;
    }
    .streaming::after {
      content: '▍';
      margin-left: 2px;
      opacity: 0.5;
      animation: blink 1s step-end infinite;
    }
    @keyframes blink {
      50% {
        opacity: 0;
      }
    }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    this.dataset['role'] = this.role;
  }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has('role')) this.dataset['role'] = this.role;
  }

  override render() {
    const meta =
      this.role === 'user' ? 'You' : this.role === 'assistant' ? 'Assistant' : 'System';
    const renderedHtml =
      this.role === 'user' ? null : renderMarkdown(this.text || '');
    return html`
      <div>
        <div class="meta">${meta}</div>
        <div class="bubble ${this.streaming ? 'streaming' : ''}">
          ${renderedHtml !== null
            ? html`<div>${unsafeHTML(renderedHtml)}</div>`
            : html`${this.text}`}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'chat-bubble': ChatBubbleEl;
  }
}
