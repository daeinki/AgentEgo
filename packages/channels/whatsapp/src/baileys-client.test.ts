import { describe, it, expect } from 'vitest';
import { translateBaileysMessage } from './baileys-client.js';

describe('translateBaileysMessage', () => {
  it('translates a 1:1 plain text message', () => {
    const out = translateBaileysMessage({
      key: { id: 'm1', remoteJid: '821012345678@s.whatsapp.net', fromMe: false },
      messageTimestamp: 1_700_000_000,
      message: { conversation: 'hi there' },
    });
    expect(out).not.toBeNull();
    expect(out!.text).toBe('hi there');
    expect(out!.isGroup).toBe(false);
    expect(out!.from).toBe('821012345678@s.whatsapp.net');
    expect(out!.chatId).toBe('821012345678@s.whatsapp.net');
    expect(out!.fromMe).toBe(false);
    expect(out!.timestamp).toBe(1_700_000_000);
  });

  it('translates extendedTextMessage fallback', () => {
    const out = translateBaileysMessage({
      key: { id: 'm2', remoteJid: '821099999999@s.whatsapp.net' },
      message: { extendedTextMessage: { text: '긴 문자' } },
    });
    expect(out!.text).toBe('긴 문자');
  });

  it('picks caption for media messages', () => {
    const out = translateBaileysMessage({
      key: { id: 'm3', remoteJid: '82@s.whatsapp.net' },
      message: { imageMessage: { caption: '스크린샷' } },
    });
    expect(out!.mediaCaption).toBe('스크린샷');
    expect(out!.text).toBeUndefined();
  });

  it('handles group messages using participant as sender', () => {
    const out = translateBaileysMessage({
      key: {
        id: 'm4',
        remoteJid: '123-1700@g.us',
        participant: '821012345678@s.whatsapp.net',
      },
      message: { conversation: 'group msg' },
    });
    expect(out!.isGroup).toBe(true);
    expect(out!.chatId).toBe('123-1700@g.us');
    expect(out!.from).toBe('821012345678@s.whatsapp.net');
  });

  it('returns null for messages with no text content', () => {
    expect(
      translateBaileysMessage({
        key: { id: 'm5', remoteJid: 'x@s.whatsapp.net' },
        message: {},
      }),
    ).toBeNull();
  });

  it('returns null for messages without remoteJid', () => {
    expect(
      translateBaileysMessage({
        key: { id: 'm6' },
        message: { conversation: 'hi' },
      }),
    ).toBeNull();
  });

  it('fromMe=true is preserved', () => {
    const out = translateBaileysMessage({
      key: { id: 'm7', remoteJid: 'x@s.whatsapp.net', fromMe: true },
      message: { conversation: 'hi' },
    });
    expect(out!.fromMe).toBe(true);
  });
});
