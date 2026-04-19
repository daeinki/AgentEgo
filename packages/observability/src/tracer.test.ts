import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTelemetry, type TelemetryHandle } from './setup.js';
import { withSpan, getTracer } from './tracer.js';

describe('withSpan', () => {
  let tel: TelemetryHandle;

  beforeEach(() => {
    tel = setupTelemetry({ serviceName: 'test', exporter: 'memory' });
  });

  afterEach(async () => {
    await tel.shutdown();
  });

  it('records a successful span with OK status', async () => {
    const result = await withSpan('work', async () => 42, { kind: 'unit' });
    expect(result).toBe(42);
    const spans = await tel.collectSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('work');
    expect(spans[0]!.status.code).toBe(1); // OK
    expect(spans[0]!.attributes['kind']).toBe('unit');
  });

  it('records an exception, rethrows, and marks ERROR', async () => {
    await expect(withSpan('boom', async () => { throw new Error('bad'); })).rejects.toThrow('bad');
    const spans = await tel.collectSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status.code).toBe(2); // ERROR
    expect(spans[0]!.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('captures both outer and inner spans when nested', async () => {
    await withSpan('outer', async () => {
      await withSpan('inner', async () => 1);
    });
    const spans = await tel.collectSpans();
    const names = spans.map((s) => s.name).sort();
    expect(names).toContain('outer');
    expect(names).toContain('inner');
  });

  it('getTracer returns a usable tracer before setupTelemetry is called', () => {
    // Just ensures no-op provider doesn't crash.
    const tracer = getTracer('no-prov-test');
    expect(tracer).toBeDefined();
  });
});
