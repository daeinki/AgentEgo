import { LitElement, css, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { PhaseIndicator } from '@agent-platform/core/phase-format';
import type { ChatTurn } from '../../types/index.js';
import { strings } from '../../i18n/strings.js';
import '../chat/chat-transcript.js';
import '../chat/chat-input.js';
import '../components/phase-line.js';

@customElement('view-chat')
export class ViewChatEl extends LitElement {
  @property({ attribute: false })
  turns: ChatTurn[] = [];

  @property({ attribute: false })
  phase: PhaseIndicator | null = null;

  @property({ type: Boolean })
  busy = false;

  @property({ type: String })
  sessionId: string | null = null;

  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      flex: 1 1 auto;
      overflow: hidden;
    }
    header.page {
      padding: 24px 24px 16px;
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
    }
    h1 {
      margin: 0 0 4px;
      font-size: 20px;
    }
    .desc {
      color: var(--fg-secondary);
      font-size: 13px;
      margin: 0;
    }
    .session-chip {
      font-family: var(--font-mono);
      font-size: 12px;
      padding: 4px 10px;
      background: var(--bg-muted);
      border-radius: var(--radius-sm);
      color: var(--fg-secondary);
    }
    .transcript-wrap {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
    }
    chat-transcript {
      flex: 1 1 auto;
    }
    footer.compose {
      display: flex;
      flex-direction: column;
    }
  `;

  override render() {
    // eslint-disable-next-line no-console
    console.log(
      '[view-chat] render, turns:',
      this.turns.length,
      'last text len:',
      this.turns[this.turns.length - 1]?.text?.length,
    );
    const sessionLabel = this.sessionId
      ? `session:${this.sessionId.slice(0, 12)}`
      : 'session:(new)';
    return html`
      <header class="page">
        <div>
          <h1>${strings.chat.title}</h1>
          <p class="desc">${strings.chat.description}</p>
        </div>
        <span class="session-chip">${sessionLabel}</span>
      </header>
      <div class="transcript-wrap">
        <chat-transcript .turns=${this.turns}></chat-transcript>
      </div>
      <footer class="compose">
        <chat-input ?busy=${this.busy}></chat-input>
        <phase-line .phase=${this.phase}></phase-line>
      </footer>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'view-chat': ViewChatEl;
  }
}
