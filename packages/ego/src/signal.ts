import type { StandardMessage, ContentType } from '@agent-platform/core';
import { nowMs } from '@agent-platform/core';

/**
 * S1 Intake signal — a StandardMessage flattened for ego pipeline use.
 * No LLM; pure transformation.
 */
export interface EgoSignal {
  raw: StandardMessage;
  receivedAt: number;
  traceId: string;
  sourceChannel: string;
  senderId: string;
  isOwner: boolean;
  contentType: ContentType;
  rawText: string;
}

export function intake(msg: StandardMessage): EgoSignal {
  let rawText = '';
  let contentType: ContentType = 'text';

  switch (msg.content.type) {
    case 'text':
      rawText = msg.content.text;
      contentType = 'text';
      break;
    case 'command':
      rawText = `/${msg.content.name} ${msg.content.args.join(' ')}`.trimEnd();
      contentType = 'command';
      break;
    case 'media':
      rawText = msg.content.caption ?? '';
      contentType = 'media';
      break;
    case 'reaction':
      rawText = msg.content.emoji;
      contentType = 'reaction';
      break;
  }

  return {
    raw: msg,
    receivedAt: nowMs(),
    traceId: msg.traceId,
    sourceChannel: msg.channel.type,
    senderId: msg.sender.id,
    isOwner: msg.sender.isOwner,
    contentType,
    rawText,
  };
}
