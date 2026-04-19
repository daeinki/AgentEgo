/**
 * WhatsApp client abstraction. The production backend is typically baileys
 * (Web-Web reverse-engineered) or Meta's Cloud API. Both have very different
 * shapes, so we model the minimum operations the adapter needs and let
 * concrete clients be supplied at initialize-time.
 */

export interface WhatsAppMessage {
  /**
   * Message key (baileys' `key.id` or Cloud API's `messages[0].id`).
   */
  id: string;
  /**
   * JID / phone number of the remote party. For 1:1 chats this is the
   * sender; for groups it identifies the participant.
   */
  from: string;
  /**
   * Chat JID — the conversation id. Group chats look like "xxxxx@g.us".
   */
  chatId: string;
  isGroup: boolean;
  /**
   * Unix epoch in seconds (baileys style).
   */
  timestamp: number;
  text?: string;
  mediaCaption?: string;
  fromMe: boolean;
}

export interface WhatsAppSendParams {
  chatId: string;
  text: string;
}

export interface WhatsAppClient {
  /**
   * Start listening for inbound messages. Implementations invoke the callback
   * for every received message. baileys-based clients open a WebSocket;
   * Cloud-API clients poll or expose a webhook.
   */
  listen(onMessage: (msg: WhatsAppMessage) => void): Promise<void>;
  sendText(params: WhatsAppSendParams): Promise<{ id: string; timestamp: number }>;
  close(): Promise<void>;
}
