import { LitElement, css, html, nothing } from 'lit';
import { customElement, state, query } from 'lit/decorators.js';
import { ContextProvider } from '@lit/context';
import type { ViewId, ThemePreference } from '../../types/index.js';
import { GatewayController, gatewayContext } from '../controllers/gateway-controller.js';
import { PhaseController } from '../controllers/phase-controller.js';
import { ChatController } from '../controllers/chat-controller.js';
import { PollingController } from '../controllers/polling-controller.js';
import { ViewStateController } from '../controllers/view-state-controller.js';
import './app-header.js';
import './app-sidebar.js';
import './enroll-dialog.js';
import '../views/view-chat.js';
import '../views/view-overview.js';
import '../views/view-channels.js';
import '../views/view-instances.js';
import '../views/view-sessions.js';
import '../views/view-cron.js';

const CONVERSATION_ID_KEY = 'ap:conversationId';

@customElement('app-root')
export class AppRootEl extends LitElement {
  // Initialized in the constructor (not as class field initializers) because
  // esbuild + experimentalDecorators + useDefineForClassFields:false has
  // known issues with decorated fields whose initializers reference other
  // decorated fields — the cross-field `this.gateway` read silently yields
  // undefined, which would bail out the whole component tree.
  private gateway!: GatewayController;
  private phase!: PhaseController;
  private chat!: ChatController;
  private polling!: PollingController;
  private viewState!: ViewStateController;

  @state()
  private enrollError: string | null = null;

  @query('enroll-dialog')
  private enrollDialog?: HTMLElement;

  constructor() {
    super();
    this.gateway = new GatewayController(this);
    this.phase = new PhaseController(this, this.gateway);
    this.chat = new ChatController(
      this,
      this.gateway,
      this.phase,
      resolveConversationId(),
    );
    this.polling = new PollingController(this, this.gateway);
    this.viewState = new ViewStateController(this);

    // Imperative context provider — same runtime as `@provide({context})` but
    // without the decorator-on-initialized-field footgun described above.
    new ContextProvider(this, {
      context: gatewayContext,
      initialValue: this.gateway,
    });
  }

  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--bg-app);
      color: var(--fg-primary);
    }
    .layout {
      display: flex;
      flex: 1 1 auto;
      min-height: 0;
    }
    main {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
  `;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    // Wait a tick so all controllers have had hostConnected fired.
    await Promise.resolve();
    if (this.gateway.enrolled) {
      try {
        await this.gateway.rpc.connect();
      } catch {
        // Ignore — controller tracks error state for display.
      }
    }
  }

  override render() {
    if (!this.gateway || !this.viewState) {
      // Defensive guard — if the constructor failed partway through, render
      // an explicit banner instead of a blank surface so the bug is visible.
      return html`<pre
        style="margin:40px;padding:16px;background:#fee;border:1px solid #c66;color:#900;font:13px/1.4 monospace;border-radius:4px;"
      >
app-root mounted but controllers are not initialized.
Open the browser console for the underlying error.
      </pre>`;
    }
    const enrolled = this.gateway.enrolled;
    return html`
      <app-header
        .status=${this.gateway.status}
        .theme=${this.viewState.theme}
        @theme-change=${(e: CustomEvent<ThemePreference>) =>
          this.viewState.setTheme(e.detail)}
      ></app-header>
      <div class="layout">
        <app-sidebar
          .activeView=${this.viewState.view}
          @view-select=${(e: CustomEvent<ViewId>) => this.viewState.setView(e.detail)}
        ></app-sidebar>
        <main>${this.renderView()}</main>
      </div>
      ${!enrolled
        ? html`<enroll-dialog
            .error=${this.enrollError}
            @enroll-submit=${(e: CustomEvent<string>) => this.handleEnroll(e.detail)}
          ></enroll-dialog>`
        : nothing}
    `;
  }

  private renderView() {
    switch (this.viewState.view) {
      case 'chat':
        return html`
          <view-chat
            .turns=${this.chat.turns}
            .phase=${this.phase.current}
            ?busy=${this.chat.busy}
            .sessionId=${this.chat.sessionId}
            @chat-send=${(e: CustomEvent<string>) => void this.chat.send(e.detail)}
            @chat-new-session=${() => this.chat.newSession()}
          ></view-chat>
        `;
      case 'overview':
        return html`<view-overview
          .overview=${this.polling.overview}
          .channels=${this.polling.channels}
        ></view-overview>`;
      case 'channels':
        return html`<view-channels .channels=${this.polling.channels}></view-channels>`;
      case 'instances':
        return html`<view-instances
          .instances=${this.polling.instances}
        ></view-instances>`;
      case 'sessions':
        return html`<view-sessions .sessions=${this.polling.sessions}></view-sessions>`;
      case 'cron':
        return html`<view-cron .tasks=${this.polling.cron}></view-cron>`;
      default:
        return html`<p style="padding:24px;color:var(--fg-muted);">
          Unknown view: ${this.viewState.view}
        </p>`;
    }
  }

  private async handleEnroll(token: string): Promise<void> {
    this.enrollError = null;
    try {
      await this.gateway.enroll(token);
      this.polling.kick();
    } catch (err) {
      this.enrollError = (err as Error).message;
    } finally {
      (this.enrollDialog as unknown as { reset?: () => void } | null)?.reset?.();
    }
  }
}

function resolveConversationId(): string {
  try {
    const existing = window.localStorage.getItem(CONVERSATION_ID_KEY);
    if (existing) return existing;
    const fresh = `web-${crypto.randomUUID()}`;
    window.localStorage.setItem(CONVERSATION_ID_KEY, fresh);
    return fresh;
  } catch {
    return `web-${Date.now()}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'app-root': AppRootEl;
  }
}
