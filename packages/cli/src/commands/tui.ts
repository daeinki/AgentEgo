import { runTui } from '@agent-platform/tui';

interface TuiOptions {
  host?: string;
  port?: string;
  authToken?: string;
  session?: string;
  conversation?: string;
}

export async function tuiCommand(options: TuiOptions): Promise<void> {
  const host = options.host ?? '127.0.0.1';
  const port = Number(options.port ?? process.env['AGENT_GATEWAY_PORT'] ?? 18790);
  const authToken = options.authToken ?? process.env['AGENT_GATEWAY_TOKEN'] ?? 'dev-token';
  const conversationId =
    options.conversation ?? process.env['AGENT_TUI_CONV'] ?? `tui-${process.pid}`;

  await runTui({
    host,
    port,
    authToken,
    conversationId,
    ...(options.session ? { sessionId: options.session } : {}),
  });
}
