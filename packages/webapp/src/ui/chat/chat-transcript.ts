import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { ChatTurn } from '../../types/index.js';
import './chat-bubble.js';

@customElement('chat-transcript')
export class ChatTranscriptEl extends LitElement {
  @property({ attribute: false })
  turns: ChatTurn[] = [];

  static override styles = css`
    :host {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 20px 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .empty {
      margin: auto;
      color: var(--fg-muted);
      font-style: italic;
      font-size: 13px;
    }
  `;

  override updated(): void {
    this.scrollTo({ top: this.scrollHeight, behavior: 'smooth' });
  }

  override render() {
    // eslint-disable-next-line no-console
    console.log(
      '[transcript] render, turns:',
      this.turns.length,
      'last text len:',
      this.turns[this.turns.length - 1]?.text?.length,
    );
    if (this.turns.length === 0) {
      return html`<div class="empty">No messages yet — type below to start.</div>`;
    }
    return html`
      ${this.turns.map(
        (t) => html`
          <chat-bubble
            .role=${t.role}
            .text=${t.text}
            ?streaming=${Boolean(t.streaming)}
          ></chat-bubble>
        `,
      )}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'chat-transcript': ChatTranscriptEl;
  }
}
