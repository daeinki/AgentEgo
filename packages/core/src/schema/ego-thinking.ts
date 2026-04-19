import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value, type ValueError } from '@sinclair/typebox/value';
import { GoalUpdate } from './goal.js';

// ─── Sub-schemas ──────────────────────────────────────────────────────────

const RequestType = Type.Union([
  Type.Literal('direct_answer'),
  Type.Literal('tool_assisted'),
  Type.Literal('research_needed'),
  Type.Literal('workflow_execution'),
  Type.Literal('clarification_needed'),
  Type.Literal('not_actionable'),
]);

const EstimatedComplexity = Type.Union([
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
]);

export const Perception = Type.Object({
  requestType: RequestType,
  patterns: Type.Array(Type.String(), { maxItems: 8 }),
  isFollowUp: Type.Boolean(),
  requiresToolUse: Type.Boolean(),
  estimatedComplexity: EstimatedComplexity,
});
export type Perception = Static<typeof Perception>;

export const Cognition = Type.Object({
  relevantMemoryIndices: Type.Array(Type.Integer({ minimum: 0 })),
  relatedGoalId: Type.Union([Type.String(), Type.Null()]),
  situationSummary: Type.String({ maxLength: 400 }),
  opportunities: Type.Array(Type.String(), { maxItems: 5 }),
  risks: Type.Array(Type.String(), { maxItems: 5 }),
  egoRelevance: Type.Number({ minimum: 0, maximum: 1 }),
});
export type Cognition = Static<typeof Cognition>;

const Enrichment = Type.Object({
  addContext: Type.Optional(Type.String()),
  addMemories: Type.Optional(Type.Array(Type.String())),
  suggestTools: Type.Optional(Type.Array(Type.String())),
  suggestModel: Type.Optional(Type.String()),
  addInstructions: Type.Optional(Type.String()),
  setPriority: Type.Optional(Type.Integer()),
});

const RedirectPayload = Type.Object({
  targetAgentId: Type.String({ minLength: 1 }),
  targetSessionId: Type.String({ minLength: 1 }),
  reason: Type.String({ minLength: 1 }),
});

const DirectResponsePayload = Type.Object({
  text: Type.String({ minLength: 1 }),
});

export const JudgmentAction = Type.Union([
  Type.Literal('passthrough'),
  Type.Literal('enrich'),
  Type.Literal('redirect'),
  Type.Literal('direct_response'),
]);
export type JudgmentAction = Static<typeof JudgmentAction>;

export const Judgment = Type.Object({
  action: JudgmentAction,
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  reason: Type.String({ maxLength: 500 }),
  enrichment: Type.Optional(Enrichment),
  redirect: Type.Optional(RedirectPayload),
  directResponse: Type.Optional(DirectResponsePayload),
});
export type Judgment = Static<typeof Judgment>;

export const EgoThinkingResult = Type.Object({
  perception: Perception,
  cognition: Cognition,
  judgment: Judgment,
  goalUpdates: Type.Optional(Type.Array(GoalUpdate)),
  personaSignals: Type.Optional(
    Type.Object({
      detected: Type.Boolean(),
      feedbacks: Type.Array(Type.Unknown()),
    }),
  ),
});
export type EgoThinkingResult = Static<typeof EgoThinkingResult>;

// ─── Validation failure classification (§5.7) ──────────────────────────────

export type ValidationFailureTag =
  | 'llm_invalid_json'
  | 'llm_schema_mismatch'
  | 'llm_out_of_range'
  | 'llm_inconsistent_action'
  | 'llm_invalid_target';

function isOutOfRangeError(e: ValueError): boolean {
  const schema = e.schema as {
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: number;
    exclusiveMaximum?: number;
  } | undefined;
  if (schema && typeof schema === 'object') {
    if (
      schema.minimum !== undefined ||
      schema.maximum !== undefined ||
      schema.exclusiveMinimum !== undefined ||
      schema.exclusiveMaximum !== undefined
    ) {
      return true;
    }
  }
  const msg = String(e.message).toLowerCase();
  return (
    msg.includes('minimum') ||
    msg.includes('maximum') ||
    msg.includes('less than') ||
    msg.includes('greater than') ||
    msg.includes('range')
  );
}

export function classifyValidationFailure(
  errors: ValueError[],
  candidate: unknown,
): ValidationFailureTag {
  if (errors.some(isOutOfRangeError)) return 'llm_out_of_range';

  const cand = candidate as {
    judgment?: {
      action?: string;
      redirect?: unknown;
      enrichment?: unknown;
      directResponse?: unknown;
    };
  } | null;
  if (cand && typeof cand === 'object' && cand.judgment) {
    const j = cand.judgment;
    if (j.action === 'enrich' && !j.enrichment) return 'llm_inconsistent_action';
    if (j.action === 'redirect') {
      const r = j.redirect as { targetAgentId?: string; targetSessionId?: string } | undefined;
      if (!r || !r.targetAgentId || !r.targetSessionId) return 'llm_invalid_target';
    }
    if (j.action === 'direct_response' && !j.directResponse) return 'llm_inconsistent_action';
  }
  return 'llm_schema_mismatch';
}

export interface ValidationOutcome {
  ok: boolean;
  tag?: ValidationFailureTag;
  errors?: ValueError[];
  value?: EgoThinkingResult;
}

function postSchemaConsistencyTag(
  value: EgoThinkingResult,
): ValidationFailureTag | undefined {
  const j = value.judgment;
  if (j.action === 'enrich' && !j.enrichment) return 'llm_inconsistent_action';
  if (j.action === 'direct_response' && !j.directResponse) return 'llm_inconsistent_action';
  if (j.action === 'redirect') {
    const r = j.redirect;
    if (!r || !r.targetAgentId || !r.targetSessionId) return 'llm_invalid_target';
  }
  return undefined;
}

export function validateEgoThinking(candidate: unknown): ValidationOutcome {
  if (Value.Check(EgoThinkingResult, candidate)) {
    const value = candidate as EgoThinkingResult;
    const semanticTag = postSchemaConsistencyTag(value);
    if (semanticTag) {
      return { ok: false, tag: semanticTag, errors: [] };
    }
    return { ok: true, value };
  }
  const errors = [...Value.Errors(EgoThinkingResult, candidate)];
  return { ok: false, tag: classifyValidationFailure(errors, candidate), errors };
}

export function parseEgoThinkingJson(jsonText: string): ValidationOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, tag: 'llm_invalid_json', errors: [] };
  }
  return validateEgoThinking(parsed);
}

export function schemaAsJsonSchema<T extends TSchema>(schema: T): unknown {
  return JSON.parse(JSON.stringify(schema));
}
