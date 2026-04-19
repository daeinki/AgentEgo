import {
  BatchSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';

/**
 * OTLP-HTTP exporter bootstrapper. The exporter package is an optional peer
 * dependency; we load it dynamically so users who stick to `console`/`memory`
 * exporters don't pay for it.
 */

export interface OtlpProcessorOptions {
  /**
   * OTLP HTTP endpoint, e.g. `http://localhost:4318/v1/traces`.
   */
  url: string;
  /**
   * Extra HTTP headers — auth tokens, tenant ids, etc.
   */
  headers?: Record<string, string>;
  /**
   * Batch processor tuning. All fields are optional; defaults ship in the
   * OTel SDK. Kept narrow so we don't leak the SDK's configuration surface.
   */
  batch?: {
    maxExportBatchSize?: number;
    scheduledDelayMillis?: number;
    exportTimeoutMillis?: number;
    maxQueueSize?: number;
  };
}

/**
 * Dynamically import the OTLP HTTP exporter and wrap it in a BatchSpanProcessor.
 * Pass the returned processor to `setupTelemetry({exporter:'custom', customProcessors:[proc]})`.
 */
export async function createOtlpHttpProcessor(
  options: OtlpProcessorOptions,
): Promise<SpanProcessor> {
  let exporter: SpanExporter;
  try {
    const name = '@opentelemetry/exporter-trace-otlp-http';
    const mod = (await import(/* @vite-ignore */ name)) as {
      OTLPTraceExporter: new (cfg: {
        url: string;
        headers?: Record<string, string>;
      }) => SpanExporter;
    };
    const OTLPTraceExporter = mod.OTLPTraceExporter;
    const config: { url: string; headers?: Record<string, string> } = { url: options.url };
    if (options.headers !== undefined) config.headers = options.headers;
    exporter = new OTLPTraceExporter(config);
  } catch (err) {
    throw new Error(
      'createOtlpHttpProcessor requires the optional peer dependency @opentelemetry/exporter-trace-otlp-http. Install it with:\n' +
        '  pnpm add @opentelemetry/exporter-trace-otlp-http\n' +
        `Original error: ${(err as Error).message}`,
    );
  }
  return new BatchSpanProcessor(exporter, options.batch ?? {});
}
