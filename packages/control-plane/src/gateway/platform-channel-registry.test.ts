import { describe, it, expect } from 'vitest';
import type { Contracts } from '@agent-platform/core';
import { PlatformChannelRegistry } from './platform-channel-registry.js';

function makeAdapter(healthy = true, message?: string): Contracts.ChannelAdapter {
  return {
    async initialize() {},
    async shutdown() {},
    async healthCheck() {
      const h: Contracts.HealthStatus = {
        healthy,
        lastCheckedAt: Date.now(),
      };
      if (message !== undefined) h.message = message;
      return h;
    },
    onMessage() {},
    async sendMessage() {
      return { messageId: 'm', sentAt: 0, status: 'sent' as const };
    },
    async sendTypingIndicator() {},
    async isAllowed() {
      return true;
    },
  };
}

describe('PlatformChannelRegistry', () => {
  it('register → list surfaces the descriptor with status=connected', () => {
    const reg = new PlatformChannelRegistry();
    reg.register('webchat', 'webchat', makeAdapter());
    expect(reg.list()).toEqual([
      { id: 'webchat', type: 'webchat', status: 'connected' },
    ]);
    expect(reg.get('webchat')?.status).toBe('connected');
  });

  it('recordEvent updates lastEventAt and clears prior error', () => {
    const reg = new PlatformChannelRegistry();
    reg.register('webchat', 'webchat', makeAdapter());
    reg.recordError('webchat', 'boom');
    expect(reg.get('webchat')?.status).toBe('error');
    reg.recordEvent('webchat', 12345);
    const d = reg.get('webchat');
    expect(d?.status).toBe('connected');
    expect(d?.lastEventAt).toBe(12345);
    expect(d?.error).toBeUndefined();
  });

  it('recordError flips status + keeps the last error message', () => {
    const reg = new PlatformChannelRegistry();
    reg.register('slack', 'slack', makeAdapter());
    reg.recordError('slack', 'socket closed');
    const d = reg.get('slack');
    expect(d?.status).toBe('error');
    expect(d?.error).toBe('socket closed');
  });

  it('updateSessionCount is reflected on subsequent list()', () => {
    const reg = new PlatformChannelRegistry();
    reg.register('webchat', 'webchat', makeAdapter());
    reg.updateSessionCount('webchat', 3);
    expect(reg.get('webchat')?.sessionCount).toBe(3);
  });

  it('deregister flips status to disconnected but keeps descriptor in list', () => {
    const reg = new PlatformChannelRegistry();
    reg.register('webchat', 'webchat', makeAdapter());
    reg.deregister('webchat');
    expect(reg.list()[0]?.status).toBe('disconnected');
  });

  it('refreshHealth marks unhealthy adapter as error with health message', async () => {
    const reg = new PlatformChannelRegistry();
    reg.register('x', 'x', makeAdapter(false, 'pool exhausted'));
    await reg.refreshHealth('x');
    const d = reg.get('x');
    expect(d?.status).toBe('error');
    expect(d?.error).toBe('pool exhausted');
  });

  it('refreshHealth on a throwing adapter records the exception as error', async () => {
    const reg = new PlatformChannelRegistry();
    const throwing: Contracts.ChannelAdapter = {
      ...makeAdapter(),
      async healthCheck() {
        throw new Error('network dead');
      },
    };
    reg.register('x', 'x', throwing);
    await reg.refreshHealth('x');
    expect(reg.get('x')?.error).toBe('network dead');
    expect(reg.get('x')?.status).toBe('error');
  });

  it('refreshHealth is a no-op on unknown or disconnected ids', async () => {
    const reg = new PlatformChannelRegistry();
    await reg.refreshHealth('ghost'); // should not throw
    reg.register('x', 'x', makeAdapter(false, 'down'));
    reg.deregister('x');
    await reg.refreshHealth('x');
    expect(reg.get('x')?.status).toBe('disconnected'); // unchanged
  });

  it('recordEvent / recordError on unknown id is a no-op', () => {
    const reg = new PlatformChannelRegistry();
    reg.recordEvent('ghost');
    reg.recordError('ghost', 'x');
    expect(reg.list()).toEqual([]);
  });
});
