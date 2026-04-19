import { describe, it, expect } from 'vitest';
import {
  NoopTraceLogger,
  type TraceLogger,
  type TraceEvent,
  type TraceBlock,
} from '../src/contracts/trace-logger.js';

describe('TraceLogger contract', () => {
  it('TraceBlock union accepts the documented block identifiers', () => {
    const blocks: TraceBlock[] = ['G3', 'C1', 'P1', 'E1', 'W1', 'R1', 'R2', 'R3', 'M1'];
    expect(blocks.length).toBe(9);
  });

  it('NoopTraceLogger conforms to TraceLogger', () => {
    const logger: TraceLogger = new NoopTraceLogger();
    expect(typeof logger.event).toBe('function');
    expect(typeof logger.span).toBe('function');
  });

  it('NoopTraceLogger.event() is a no-op', () => {
    const logger = new NoopTraceLogger();
    const entry: TraceEvent = {
      traceId: 'trc-1',
      block: 'G3',
      event: 'enter',
      timestamp: Date.now(),
    };
    expect(() => logger.event(entry)).not.toThrow();
  });

  it('NoopTraceLogger.span() returns the fn result and does not record', async () => {
    const logger = new NoopTraceLogger();
    const result = await logger.span(
      { traceId: 'trc-1', block: 'P1' },
      async () => 42,
    );
    expect(result).toBe(42);
  });

  it('NoopTraceLogger.span() rethrows on error', async () => {
    const logger = new NoopTraceLogger();
    await expect(
      logger.span({ traceId: 'trc-1', block: 'P1' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
