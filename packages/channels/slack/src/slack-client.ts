/**
 * Minimal Slack Web API client (chat.postMessage). Signing-secret verification
 * for incoming Events API requests is handled inside the adapter — not here,
 * because the secret belongs to the webhook layer, not the outbound client.
 */

export interface SlackPostMessageParams {
  channel: string;
  text: string;
  thread_ts?: string;
}

export interface SlackPostMessageResult {
  ok: boolean;
  ts?: string;
  channel?: string;
  error?: string;
}

export interface SlackClient {
  postMessage(params: SlackPostMessageParams): Promise<SlackPostMessageResult>;
  close(): Promise<void>;
}

export class HttpSlackClient implements SlackClient {
  constructor(
    private readonly botToken: string,
    private readonly baseUrl = 'https://slack.com/api',
  ) {}

  async postMessage(params: SlackPostMessageParams): Promise<SlackPostMessageResult> {
    const response = await fetch(`${this.baseUrl}/chat.postMessage`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(params),
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const body = (await response.json()) as SlackPostMessageResult;
    return body;
  }

  async close(): Promise<void> {
    // Nothing to tear down — stateless fetch.
  }
}
