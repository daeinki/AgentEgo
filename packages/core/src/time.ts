export function nowMs(): number {
  return Date.now();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Error thrown by {@link withTimeout} when the wrapped promise does not
 * settle within the given budget. Callers can use `instanceof TimeoutError`
 * (or `err.name === 'TimeoutError'`) to distinguish budget exhaustion from
 * other failures — in particular, observability sinks want to tag timeouts
 * differently from generic runtime errors.
 */
export class TimeoutError extends Error {
  public readonly label: string;
  public readonly timeoutMs: number;
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
    this.label = label;
    this.timeoutMs = ms;
  }
}

export async function withTimeout<T>(p: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
