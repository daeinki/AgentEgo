import type { ReactiveController, ReactiveControllerHost } from 'lit';
import type { ThemePreference, ViewId } from '../../types/index.js';
import { readJSON, writeJSON } from '../../local-storage.js';

const KEY_VIEW = 'view';
const KEY_THEME = 'theme';

const VALID_VIEWS: readonly ViewId[] = [
  'chat',
  'overview',
  'channels',
  'instances',
  'sessions',
  'cron',
];

/**
 * View + theme state. View is driven by `location.hash` so deep-links work
 * (`/ui/#/sessions` → `view = 'sessions'`). Theme is stored in localStorage
 * and applied to `<html data-theme=…>`.
 */
export class ViewStateController implements ReactiveController {
  private readonly host: ReactiveControllerHost;
  private hashHandler: (() => void) | null = null;

  view: ViewId = 'chat';
  theme: ThemePreference = 'system';

  constructor(host: ReactiveControllerHost) {
    this.host = host;
    host.addController(this);
    const stored = readJSON<ThemePreference>(KEY_THEME);
    if (stored) this.theme = stored;
  }

  hostConnected(): void {
    this.applyTheme();
    this.hashHandler = () => {
      this.view = parseHashView();
      this.host.requestUpdate();
    };
    window.addEventListener('hashchange', this.hashHandler);
    // Persisted view (if any) wins over the default but loses to an explicit
    // hash on the URL.
    const stored = readJSON<ViewId>(KEY_VIEW);
    const fromHash = parseHashView();
    this.view = window.location.hash ? fromHash : stored ?? 'chat';
    if (!window.location.hash) {
      window.location.hash = `#/${this.view}`;
    }
    this.host.requestUpdate();
  }

  hostDisconnected(): void {
    if (this.hashHandler) {
      window.removeEventListener('hashchange', this.hashHandler);
      this.hashHandler = null;
    }
  }

  setView(next: ViewId): void {
    if (this.view === next) return;
    this.view = next;
    writeJSON(KEY_VIEW, next);
    window.location.hash = `#/${next}`;
    this.host.requestUpdate();
  }

  setTheme(next: ThemePreference): void {
    if (this.theme === next) return;
    this.theme = next;
    writeJSON(KEY_THEME, next);
    this.applyTheme();
    this.host.requestUpdate();
  }

  private applyTheme(): void {
    document.documentElement.setAttribute('data-theme', this.theme);
  }
}

function parseHashView(): ViewId {
  const h = window.location.hash.replace(/^#\/?/, '').split('/')[0];
  if (!h) return 'chat';
  return (VALID_VIEWS as readonly string[]).includes(h) ? (h as ViewId) : 'chat';
}
