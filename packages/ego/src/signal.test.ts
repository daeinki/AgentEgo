import { describe, it, expect } from 'vitest';
import { intake } from './signal.js';
import type { StandardMessage } from '@agent-platform/core';
import { generateMessageId, generateTraceId, nowMs } from '@agent-platform/core';

function make(content: StandardMessage['content']): StandardMessage {
  return {
    id: generateMessageId(),
    traceId: generateTraceId(),
    timestamp: nowMs(),
    channel: { type: 'webchat', id: 'w-1', metadata: {} },
    sender: { id: 'user-1', isOwner: true },
    conversation: { type: 'dm', id: 'c-1' },
    content,
  };
}

describe('intake (S1)', () => {
  it('extracts text content', () => {
    const s = intake(make({ type: 'text', text: '배포해줘' }));
    expect(s.contentType).toBe('text');
    expect(s.rawText).toBe('배포해줘');
  });

  it('flattens command content to a /name arg-joined string', () => {
    const s = intake(make({ type: 'command', name: 'deploy', args: ['prod', 'now'] }));
    expect(s.contentType).toBe('command');
    expect(s.rawText).toBe('/deploy prod now');
  });

  it('uses caption for media', () => {
    const s = intake(make({ type: 'media', mimeType: 'image/png', url: 'http://x/y.png', caption: '스크린샷' }));
    expect(s.contentType).toBe('media');
    expect(s.rawText).toBe('스크린샷');
  });

  it('uses emoji for reaction', () => {
    const s = intake(make({ type: 'reaction', emoji: '👍', targetMessageId: 'm-1' }));
    expect(s.contentType).toBe('reaction');
    expect(s.rawText).toBe('👍');
  });

  it('preserves trace id and owner flag', () => {
    const msg = make({ type: 'text', text: 'hi' });
    const s = intake(msg);
    expect(s.traceId).toBe(msg.traceId);
    expect(s.isOwner).toBe(true);
  });
});
