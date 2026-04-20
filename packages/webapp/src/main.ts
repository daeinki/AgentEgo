import './styles.css';
import './styles/tokens.css';

const root = document.getElementById('app');

async function boot(): Promise<void> {
  try {
    await import('./ui/components/app-root.js');
    if (!root) return;
    const el = document.createElement('app-root');
    root.replaceChildren(el);
  } catch (err) {
    showFatal(err);
  }
}

function showFatal(err: unknown): void {
  if (!root) return;
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  root.innerHTML = `
    <div style="padding: 40px; font-family: sans-serif;">
      <h2 style="margin:0 0 8px;color:#d64545;">Failed to initialize dashboard</h2>
      <pre style="white-space:pre-wrap;font-size:12px;color:#666;margin:0;">${msg}</pre>
      <p style="font-size:12px;color:#888;margin-top:12px;">
        Open the browser console for a full stack trace.
      </p>
    </div>
  `;
  // eslint-disable-next-line no-console
  console.error('[app-root] boot failed', err);
}

window.addEventListener('error', (e) => showFatal(e.error ?? e.message));
window.addEventListener('unhandledrejection', (e) => showFatal(e.reason));

void boot();
