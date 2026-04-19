import { trace, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';

export const TRACER_NAME = '@agent-platform';
export const TRACER_VERSION = '0.1.0';

/**
 * Fetch a named tracer. Safe to call multiple times — underlying provider is
 * resolved at call time, so this works before or after `setupTelemetry()`.
 */
export function getTracer(name = TRACER_NAME): Tracer {
  return trace.getTracer(name, TRACER_VERSION);
}

/**
 * Run an async function inside a named span, automatically recording
 * exceptions, setting status, and ending the span.
 */
export async function withSpan<T>(
  spanName: string,
  fn: (span: Span) => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(spanName, async (span) => {
    if (attributes) {
      for (const [k, v] of Object.entries(attributes)) {
        span.setAttribute(k, v);
      }
    }
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}
