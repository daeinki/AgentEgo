import type { Contracts, EgoThinkingResult } from '@agent-platform/core';
import { parseEgoThinkingJson, Schemas, SchemaValidationError } from '@agent-platform/core';

/**
 * Cached JSON-schema string for `EgoThinkingResult`, injected into the EGO
 * user prompt so the LLM sees the exact structure it must produce. Grounding
 * the prompt with the schema is the single biggest lever against
 * `llm_schema_mismatch`: without it the model has to guess field names and
 * regularly drops required fields (enrichment, directResponse, ...).
 */
const EGO_RESULT_SCHEMA_JSON = JSON.stringify(
  Schemas.EgoThinkingSchema.EgoThinkingResult,
);

/**
 * Build the user-message JSON payload shared by all provider-specific EGO
 * adapters. The payload is three blocks:
 *
 *   1. `SCHEMA` — the JSON Schema the response must conform to.
 *   2. `CONTEXT` — the analysis input (signal + memories + goals).
 *   3. An instruction line insisting on JSON-only output matching SCHEMA.
 *
 * OpenAI's `response_format: json_object` mode only guarantees valid JSON,
 * not schema conformance, so the schema block is what prevents the common
 * classes of EgoThinkingResult validation failures.
 */
export function buildUserPrompt(req: Contracts.EgoThinkingRequest): string {
  return (
    `SCHEMA (응답은 이 JSON Schema 를 반드시 따를 것):\n` +
    `${EGO_RESULT_SCHEMA_JSON}\n\n` +
    `CONTEXT:\n${JSON.stringify(req.context, null, 2)}\n\n` +
    `위 SCHEMA 를 만족하는 단일 JSON 객체로만 응답. 추가 텍스트 금지. ` +
    `judgment.action 값에 따라:\n` +
    `- action="enrich" → enrichment 필드 필수\n` +
    `- action="redirect" → redirect 필드(targetAgentId, targetSessionId, reason 모두) 필수\n` +
    `- action="direct_response" → directResponse.text 필수\n` +
    `- action="passthrough" → 위 세 필드 모두 생략.`
  );
}

/**
 * Validate an LLM text response as an `EgoThinkingResult`. Throws
 * `SchemaValidationError` on null/invalid output so the EgoLayer's
 * fallbackOnError path can handle it uniformly regardless of provider.
 *
 * The thrown error carries:
 *   - `tag` — the specific failure class (e.g. `llm_invalid_json`,
 *     `llm_out_of_range`) so audit/trace sinks can classify correctly.
 *   - `candidate` — the parsed-but-invalid object when we got that far, so
 *     observability can log a preview of what the LLM actually returned.
 */
export function parseOrThrow(text: string | null): EgoThinkingResult {
  if (!text) {
    throw new SchemaValidationError('EGO LLM returned no text block', [], {
      tag: 'llm_invalid_json',
    });
  }
  const outcome = parseEgoThinkingJson(text);
  if (!outcome.ok || !outcome.value) {
    let candidate: unknown = undefined;
    try {
      candidate = JSON.parse(text);
    } catch {
      /* already classified as llm_invalid_json below */
    }
    throw new SchemaValidationError(
      `EGO LLM output invalid (${outcome.tag ?? 'unknown'})`,
      outcome.errors ?? [],
      {
        ...(outcome.tag ? { tag: outcome.tag } : {}),
        ...(candidate !== undefined ? { candidate } : {}),
      },
    );
  }
  return outcome.value;
}
