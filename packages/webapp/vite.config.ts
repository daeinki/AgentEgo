import { defineConfig } from 'vite';

// Default matches `agent gateway start`'s default port (packages/cli/src/commands/gateway.ts).
// Override with `AGENT_GATEWAY_ORIGIN=http://127.0.0.1:1234 pnpm --filter @agent-platform/webapp dev`.
const GATEWAY_ORIGIN = process.env['AGENT_GATEWAY_ORIGIN'] ?? 'http://127.0.0.1:18790';
const GATEWAY_WS_ORIGIN = GATEWAY_ORIGIN.replace(/^http/, 'ws');

// `base` must be `/ui/` in the production build so assets resolve when the
// gateway mounts `dist/` at `/ui/*`. In dev we serve at `/` so
// `http://localhost:5173/` renders without the user needing to remember a
// subpath — the gateway isn't in the loop anyway.
export default defineConfig(({ command }) => ({
  root: 'src',
  base: command === 'build' ? '/ui/' : '/',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/rpc': {
        target: GATEWAY_WS_ORIGIN,
        ws: true,
        changeOrigin: true,
      },
      '/healthz': {
        target: GATEWAY_ORIGIN,
        changeOrigin: true,
      },
      '/device': {
        target: GATEWAY_ORIGIN,
        changeOrigin: true,
      },
    },
  },
}));
