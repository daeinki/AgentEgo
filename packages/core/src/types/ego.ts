import { Type, type Static } from '@sinclair/typebox';
import { MessageContent, StandardMessage } from './message.js';

// ─── ADR-006: Single state enum ────────────────────────────────────────────

export const EgoState = Type.Union([
  Type.Literal('off'),
  Type.Literal('passive'),
  Type.Literal('active'),
]);
export type EgoState = Static<typeof EgoState>;

// ─── EGO LLM config ────────────────────────────────────────────────────────

export const EgoLlmProvider = Type.Union([
  Type.Literal('anthropic'),
  Type.Literal('openai'),
]);
export type EgoLlmProvider = Static<typeof EgoLlmProvider>;

export const EgoLlmConfig = Type.Object({
  provider: EgoLlmProvider,
  model: Type.String(),
  apiKey: Type.String(),
  // Optional OpenAI-compatible endpoint override. Supports `${ENV_VAR}`
  // interpolation the same way apiKey does. No effect on the Anthropic path.
  baseURL: Type.Optional(Type.String()),
  temperature: Type.Number({ minimum: 0, maximum: 2 }),
  maxTokens: Type.Integer({ minimum: 1 }),
  topP: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  fallback: Type.Optional(
    Type.Object({
      provider: EgoLlmProvider,
      model: Type.String(),
      apiKey: Type.String(),
      baseURL: Type.Optional(Type.String()),
      temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
      maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
  ),
});
export type EgoLlmConfig = Static<typeof EgoLlmConfig>;

// ─── Minimal EgoConfig surfaced in harness §3.2A.2 ─────────────────────────

export const EgoConfig = Type.Object({
  schemaVersion: Type.String(),
  state: EgoState,
  fallbackOnError: Type.Boolean(),
  maxDecisionTimeMs: Type.Integer({ minimum: 1 }),
});
export type EgoConfig = Static<typeof EgoConfig>;

// ─── Full ego.json config (source-of-truth schema) ─────────────────────────

const ThresholdsSchema = Type.Object({
  minConfidenceToAct: Type.Number({ minimum: 0, maximum: 1 }),
  minRelevanceToEnrich: Type.Number({ minimum: 0, maximum: 1 }),
  minRelevanceToRedirect: Type.Number({ minimum: 0, maximum: 1 }),
  minRelevanceToDirectRespond: Type.Number({ minimum: 0, maximum: 1 }),
  maxCostUsdPerDecision: Type.Number({ minimum: 0 }),
  maxCostUsdPerDay: Type.Number({ minimum: 0 }),
});

const FastPathSchema = Type.Object({
  /**
   * Fast path 자체 활성화 여부. `false` 면 모든 신호가 deep path 로 진입한다.
   * 미지정(undefined) 시 하위호환을 위해 `true` 로 해석된다.
   * 환경변수 `EGO_FORCE_DEEP=1` 로 런타임에 `false` 로 오버라이드 가능.
   */
  enabled: Type.Optional(Type.Boolean()),
  passthroughIntents: Type.Array(Type.String()),
  passthroughPatterns: Type.Array(Type.String()),
  maxComplexityForPassthrough: Type.Union([
    Type.Literal('trivial'),
    Type.Literal('simple'),
    Type.Literal('moderate'),
    Type.Literal('complex'),
    Type.Literal('multi_step'),
  ]),
  targetRatio: Type.Number({ minimum: 0, maximum: 1 }),
  measurementWindowDays: Type.Integer({ minimum: 1 }),
});

const PromptsSchema = Type.Object({
  systemPromptFile: Type.String(),
  responseFormat: Type.String(),
});

const GoalsSchema = Type.Object({
  enabled: Type.Boolean(),
  maxActiveGoals: Type.Integer({ minimum: 1 }),
  autoDetectCompletion: Type.Boolean(),
  storePath: Type.String(),
});

const MemoryConfigSchema = Type.Object({
  searchOnCognize: Type.Boolean(),
  maxSearchResults: Type.Integer({ minimum: 1 }),
  searchTimeoutMs: Type.Integer({ minimum: 1 }),
  onTimeout: Type.Union([
    Type.Literal('empty_result'),
    Type.Literal('cached'),
    Type.Literal('abort'),
  ]),
});

const PersonaConfigSchema = Type.Object({
  enabled: Type.Boolean(),
  storePath: Type.String(),
  snapshot: Type.Object({
    maxTokens: Type.Integer({ minimum: 1 }),
    topRelevantBehaviors: Type.Integer({ minimum: 0 }),
    topRelevantExpertise: Type.Integer({ minimum: 0 }),
    includeRelationshipContext: Type.Boolean(),
  }),
});

const ErrorHandlingSchema = Type.Object({
  onLlmInvalidJson: Type.Literal('passthrough'),
  onLlmTimeout: Type.Literal('passthrough'),
  onLlmOutOfRange: Type.Literal('passthrough'),
  onConsecutiveFailures: Type.Object({
    threshold: Type.Integer({ minimum: 1 }),
    action: Type.Literal('disable_llm_path'),
    cooldownMinutes: Type.Integer({ minimum: 0 }),
  }),
});

const AuditSchema = Type.Object({
  enabled: Type.Boolean(),
  logLevel: Type.String(),
  storePath: Type.String(),
  retentionDays: Type.Integer({ minimum: 1 }),
});

export const EgoFullConfig = Type.Object({
  schemaVersion: Type.String(),
  state: EgoState,
  fallbackOnError: Type.Boolean(),
  maxDecisionTimeMs: Type.Integer({ minimum: 1 }),
  llm: Type.Union([EgoLlmConfig, Type.Null()]),
  thresholds: ThresholdsSchema,
  fastPath: FastPathSchema,
  prompts: PromptsSchema,
  goals: GoalsSchema,
  memory: MemoryConfigSchema,
  persona: PersonaConfigSchema,
  errorHandling: ErrorHandlingSchema,
  audit: AuditSchema,
});
export type EgoFullConfig = Static<typeof EgoFullConfig>;

// ─── EGO Decision (4-way union) ────────────────────────────────────────────

export const EgoMetadata = Type.Object({
  egoDecisionId: Type.String(),
  decisionReason: Type.String(),
  confidenceScore: Type.Number({ minimum: 0, maximum: 1 }),
  decisionTimeMs: Type.Number({ minimum: 0 }),
  llmCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
});
export type EgoMetadata = Static<typeof EgoMetadata>;

export const EgoDecisionPassthrough = Type.Object({
  action: Type.Literal('passthrough'),
});

export const EgoDecisionEnrich = Type.Object({
  action: Type.Literal('enrich'),
  enrichedMessage: StandardMessage,
  metadata: EgoMetadata,
});

export const EgoDecisionRedirect = Type.Object({
  action: Type.Literal('redirect'),
  targetAgentId: Type.String(),
  targetSessionId: Type.String(),
  reason: Type.String(),
});

export const EgoDecisionDirectResponse = Type.Object({
  action: Type.Literal('direct_response'),
  content: MessageContent,
  reason: Type.String(),
});

export const EgoDecision = Type.Union([
  EgoDecisionPassthrough,
  EgoDecisionEnrich,
  EgoDecisionRedirect,
  EgoDecisionDirectResponse,
]);
export type EgoDecision = Static<typeof EgoDecision>;

// ─── EGO Signal / Normalized Signal (S1 / S2) ──────────────────────────────

export const ContentType = Type.Union([
  Type.Literal('text'),
  Type.Literal('media'),
  Type.Literal('command'),
  Type.Literal('reaction'),
]);
export type ContentType = Static<typeof ContentType>;

export const IntentType = Type.Union([
  Type.Literal('question'),
  Type.Literal('instruction'),
  Type.Literal('conversation'),
  Type.Literal('feedback'),
  Type.Literal('correction'),
  Type.Literal('greeting'),
  Type.Literal('emergency'),
  Type.Literal('meta'),
  Type.Literal('command'),
  Type.Literal('ambiguous'),
]);
export type IntentType = Static<typeof IntentType>;

export const UrgencyLevel = Type.Union([
  Type.Literal('low'),
  Type.Literal('normal'),
  Type.Literal('high'),
  Type.Literal('critical'),
]);
export type UrgencyLevel = Static<typeof UrgencyLevel>;

export const ComplexityLevel = Type.Union([
  Type.Literal('trivial'),
  Type.Literal('simple'),
  Type.Literal('moderate'),
  Type.Literal('complex'),
  Type.Literal('multi_step'),
]);
export type ComplexityLevel = Static<typeof ComplexityLevel>;
