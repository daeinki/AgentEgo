/**
 * Minimal Discord REST client. We use Application Interaction endpoints
 * (webhook-based) rather than the Gateway WebSocket — that keeps this
 * dependency-free and test-friendly. Gateway support can slot in later as
 * a separate adapter variant.
 */

export interface DiscordCreateMessageParams {
  channelId: string;
  content: string;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  author: { id: string; username: string; bot?: boolean };
  content: string;
  timestamp: string;
}

export interface DiscordClient {
  createMessage(params: DiscordCreateMessageParams): Promise<DiscordMessage>;
  close(): Promise<void>;
}

export class HttpDiscordClient implements DiscordClient {
  constructor(
    private readonly botToken: string,
    private readonly apiBase = 'https://discord.com/api/v10',
  ) {}

  async createMessage(params: DiscordCreateMessageParams): Promise<DiscordMessage> {
    const response = await fetch(
      `${this.apiBase}/channels/${encodeURIComponent(params.channelId)}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bot ${this.botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: params.content }),
      },
    );
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`discord createMessage failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    return (await response.json()) as DiscordMessage;
  }

  async close(): Promise<void> {
    // stateless
  }
}
