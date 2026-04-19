import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { StandardMessage, MessageContent, ChannelType } from '../src/types/message.js';
import { generateMessageId, generateTraceId } from '../src/ids.js';

describe('StandardMessage schema', () => {
  it('accepts a text message', () => {
    const msg = {
      id: generateMessageId(),
      traceId: generateTraceId(),
      timestamp: Date.now(),
      channel: { type: 'webchat', id: 'w-1', metadata: {} },
      sender: { id: 'user-1', isOwner: true },
      conversation: { type: 'dm', id: 'c-1' },
      content: { type: 'text', text: 'hello' },
    };
    expect(Value.Check(StandardMessage, msg)).toBe(true);
  });

  it('rejects unknown channel type', () => {
    expect(Value.Check(ChannelType, 'mastodon')).toBe(false);
  });

  it('accepts media content with optional caption', () => {
    expect(
      Value.Check(MessageContent, {
        type: 'media',
        mimeType: 'image/png',
        url: 'https://example.com/img.png',
      }),
    ).toBe(true);
  });

  it('accepts command content with args', () => {
    expect(
      Value.Check(MessageContent, {
        type: 'command',
        name: 'status',
        args: [],
      }),
    ).toBe(true);
  });
});
