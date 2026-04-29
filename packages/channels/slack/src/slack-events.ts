/**
 * Wire shape of Slack Events API payloads. The same shape arrives via
 * Events API HTTP webhooks *and* Socket Mode envelopes' `payload` field —
 * it is the source-of-truth schema for inbound Slack events on this
 * adapter.
 */

export interface SlackEventsRequest {
  type: 'url_verification' | 'event_callback';
  challenge?: string;
  event?: SlackMessageEvent;
  team_id?: string;
}

export interface SlackMessageEvent {
  type: 'message';
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  channel: string;
  channel_type?: 'im' | 'channel' | 'group' | 'mpim';
}
