import type { StandardMessage, OutboundContent } from '../types/message.js';

export interface ChannelConfig {
  type: string;
  credentials: Record<string, unknown>;
  [key: string]: unknown;
}

export interface HealthStatus {
  healthy: boolean;
  message?: string;
  lastCheckedAt: number;
}

export interface SendResult {
  messageId: string;
  sentAt: number;
  status: 'sent' | 'queued' | 'failed';
  error?: string;
}

export interface ChannelAdapter {
  initialize(config: ChannelConfig): Promise<void>;
  shutdown(): Promise<void>;
  healthCheck(): Promise<HealthStatus>;
  onMessage(handler: (msg: StandardMessage) => void): void;
  sendMessage(conversationId: string, content: OutboundContent): Promise<SendResult>;
  sendTypingIndicator(conversationId: string, isTyping: boolean): Promise<void>;
  isAllowed(senderId: string, conversationType: string): Promise<boolean>;
}
