import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  ConsoleSpanExporter,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

export interface TelemetryConfig {
  serviceName: string;
  serviceVersion?: string;
  /**
   * `console` → logs spans to stdout (dev).
   * `memory` → captures spans in-process (tests).
   * `none` → no-op processor (disable telemetry).
   *
   * For OTLP/Jaeger/etc., pass `custom` with a list of your own processors.
   */
  exporter: 'console' | 'memory' | 'none' | 'custom';
  customProcessors?: SpanProcessor[];
}

export interface TelemetryHandle {
  provider: BasicTracerProvider;
  memoryExporter?: InMemorySpanExporter;
  /**
   * Collect currently-flushed spans from the memory exporter. Useful for
   * assertions in tests. Calling this also triggers a force-flush first.
   */
  collectSpans(): Promise<readonly ReadableSpan[]>;
  shutdown(): Promise<void>;
}

/**
 * Configure a global OpenTelemetry tracer provider. Safe to call multiple
 * times — subsequent calls replace the provider.
 */
export function setupTelemetry(config: TelemetryConfig): TelemetryHandle {
  const processors: SpanProcessor[] = [];
  let memoryExporter: InMemorySpanExporter | undefined;

  switch (config.exporter) {
    case 'console':
      processors.push(new SimpleSpanProcessor(new ConsoleSpanExporter()));
      break;
    case 'memory':
      memoryExporter = new InMemorySpanExporter();
      processors.push(new SimpleSpanProcessor(memoryExporter));
      break;
    case 'none':
      break;
    case 'custom':
      if (config.customProcessors) {
        processors.push(...config.customProcessors);
      }
      break;
  }

  const provider = new BasicTracerProvider({
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: config.serviceName,
      [SemanticResourceAttributes.SERVICE_VERSION]: config.serviceVersion ?? '0.1.0',
    }),
    spanProcessors: processors,
  });
  // Replace any previously registered global provider so each call to
  // setupTelemetry() produces a clean slate (important for tests).
  trace.disable();
  provider.register();

  return {
    provider,
    ...(memoryExporter ? { memoryExporter } : {}),
    async collectSpans() {
      await provider.forceFlush();
      return memoryExporter?.getFinishedSpans() ?? [];
    },
    async shutdown() {
      await provider.shutdown();
      trace.disable();
    },
  };
}
