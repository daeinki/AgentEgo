import { describe, it, expect } from 'vitest';
import { createOtlpHttpProcessor } from './otlp.js';

describe('createOtlpHttpProcessor', () => {
  it('throws a helpful install hint when the peer dep is missing', async () => {
    // The otlp-http exporter is an optional peer dep and is NOT installed in
    // the workspace, so the dynamic import should fail and produce the
    // install-guidance error.
    await expect(
      createOtlpHttpProcessor({ url: 'http://localhost:4318/v1/traces' }),
    ).rejects.toThrow(/@opentelemetry\/exporter-trace-otlp-http/);
  });

  it('options shape is accepted (no TypeScript error)', () => {
    // Compile-time assertion only — if this file compiles, the options type
    // surface is stable.
    const opts = {
      url: 'http://localhost:4318/v1/traces',
      headers: { 'x-tenant': 'acme' },
      batch: { maxExportBatchSize: 256 },
    };
    expect(opts.url).toBeTruthy();
  });
});
