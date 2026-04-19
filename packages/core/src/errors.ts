export class EgoError extends Error {
  constructor(
    message: string,
    public readonly tag: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

/**
 * Thrown when the EGO LLM response can't be coerced into a valid
 * `EgoThinkingResult`. The {@link tag} captures the specific failure class
 * from `classifyValidationFailure` (e.g. `llm_out_of_range`,
 * `llm_inconsistent_action`, `llm_invalid_json`, `llm_invalid_target`, or
 * `llm_schema_mismatch` for anything else) — the default `llm_schema_mismatch`
 * is only used when the caller has no better information. Downstream audit
 * logs and trace payloads rely on this tag.
 *
 * `validationErrors` carries the raw TypeBox ValueError list; `candidate`
 * optionally holds the already-parsed (invalid) object so consumers can
 * surface a truncated preview for debugging. Neither is part of the error
 * message by design — rendering is left to trace/audit sinks that can cap
 * length and scrub secrets appropriately.
 */
export class SchemaValidationError extends EgoError {
  public readonly validationErrors: unknown[];
  public readonly candidate?: unknown;

  constructor(
    message: string,
    validationErrors: unknown[],
    options: {
      tag?: string;
      candidate?: unknown;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.tag ?? 'llm_schema_mismatch', options.cause);
    this.validationErrors = validationErrors;
    if (options.candidate !== undefined) this.candidate = options.candidate;
  }
}

export class EgoPipelineAbort extends EgoError {
  constructor(reason: string, cause?: unknown) {
    super(`EGO pipeline aborted: ${reason}`, 'ego_runtime_error', cause);
  }
}

export class EgoTimeoutError extends EgoError {
  constructor(ms: number) {
    super(`EGO decision exceeded ${ms}ms budget`, 'ego_timeout');
  }
}

export class DailyCostCapExceeded extends EgoError {
  constructor(
    public readonly capUsd: number,
    public readonly observedUsd: number,
  ) {
    super(
      `EGO daily cost ${observedUsd.toFixed(4)} exceeds cap ${capUsd.toFixed(4)} USD`,
      'daily_cost_cap_hit',
    );
  }
}

export class CircuitOpenError extends EgoError {
  constructor(public readonly cooldownMinutes: number) {
    super(
      `EGO LLM circuit open; retry after ${cooldownMinutes} minutes`,
      'ego_circuit_open',
    );
  }
}
