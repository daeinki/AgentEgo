// ─── Types (re-exported for convenience) ───────────────────────────────────
export type {
  StandardMessage,
  MessageContent,
  OutboundContent,
  ChannelType,
} from './types/message.js';
export type {
  Session,
  SessionEvent,
  SessionEventInput,
  SessionStatus,
  SessionEventType,
  SessionEventRole,
  LoadHistoryOptions,
  CreateSessionParams,
  SessionPatch,
  CompactionResult,
} from './types/session.js';
export { DEFAULT_PROMPT_EVENT_KINDS } from './types/session.js';
export type {
  EgoConfig,
  EgoLlmConfig,
  EgoLlmProvider,
  EgoFullConfig,
  EgoDecision,
  EgoMetadata,
  EgoState,
  IntentType,
  ComplexityLevel,
  UrgencyLevel,
  ContentType,
} from './types/ego.js';
export type { Goal, GoalStatus, GoalUpdate } from './schema/goal.js';
export type {
  EgoThinkingResult,
  Perception,
  Cognition,
  Judgment,
  JudgmentAction,
  ValidationFailureTag,
  ValidationOutcome,
} from './schema/ego-thinking.js';
export type {
  Persona,
  PersonaSnapshot,
  PersonaFeedback,
  EvolutionRules,
  CommunicationStyle,
  EmotionalTendencies,
  ValuePriorities,
  DomainExpertise,
  LearnedBehavior,
  RelationshipContext,
  EvolutionLogEntry,
  StylePresetName,
} from './schema/persona.js';
export type {
  SearchContext,
  MemorySearchResult,
  ConversationTurn,
  IngestResult,
  ClassificationResult,
  MessageSummary,
  TurnSummary,
} from './schema/memory.js';
export type {
  TraceContext,
  TurnMetrics,
  AuditEntry,
  AuditTag,
} from './schema/observability.js';
export type { RouteDecision, RoutingRule } from './schema/routing.js';
export type {
  Permission,
  ToolCapability,
  SessionPolicy,
  CapabilityDecision,
} from './schema/capability.js';
export type { BuiltPrompt, SystemLayer, ToolDefinition } from './schema/prompt.js';
export type { StreamChunk, ModelInfo, ProviderHealth } from './schema/model.js';
export type { ToolResult } from './schema/tool.js';
export type { SandboxInstance } from './schema/sandbox.js';
export type {
  SkillMetadata,
  InstallResult,
  InstalledSkill,
  VerificationResult,
} from './schema/skill.js';
export type { EgoContext } from './schema/ego-context.js';
export type {
  ReasoningMode,
  ReasoningStepKind,
  TerminationReason,
  ReasoningStep,
  PlanStep,
  PlanStepStatus,
  Plan,
  ReasoningBudget,
  ReasoningState,
} from './schema/reasoning.js';
export { DEFAULT_REASONING_BUDGET } from './schema/reasoning.js';
export type { Phase, PhaseEvent, PhaseEventDetail } from './schema/phase.js';
export { TERMINAL_PHASES, isTerminalPhase } from './schema/phase.js';
export type { PhaseIndicator } from './schema/phase-format.js';
export { formatPhase, PHASE_LABELS, PHASE_ICONS } from './schema/phase-format.js';

// ─── Schemas (runtime validation objects, namespaced) ──────────────────────
export * as Schemas from './schema/index.js';

// ─── Legacy schema namespaces (kept for backward compatibility) ────────────
export * as MessageSchema from './types/message.js';
export * as SessionSchema from './types/session.js';
export * as EgoSchema from './types/ego.js';

// ─── Contracts (type-only interfaces) ──────────────────────────────────────
export * as Contracts from './contracts/index.js';

// ─── Contract helpers that are runtime values (classes/fns) ────────────────
export { NoopTraceLogger, TraceEventNames } from './contracts/trace-logger.js';
export type { TraceEventName } from './contracts/trace-logger.js';

// ─── Schema validation helpers ─────────────────────────────────────────────
export {
  validateEgoThinking,
  parseEgoThinkingJson,
  classifyValidationFailure,
  schemaAsJsonSchema,
} from './schema/ego-thinking.js';

export { STYLE_PRESETS } from './schema/persona.js';

// ─── Branded IDs ───────────────────────────────────────────────────────────
export type {
  SessionId,
  TraceId,
  GoalId,
  EgoDecisionId,
  PersonaId,
  MessageId,
  AgentId,
  Brand,
} from './brand.js';
export {
  asSessionId,
  asTraceId,
  asGoalId,
  asEgoDecisionId,
  asPersonaId,
  asMessageId,
  asAgentId,
} from './brand.js';
export {
  generateId,
  generateSessionId,
  generateTraceId,
  generateGoalId,
  generateEgoDecisionId,
  generateMessageId,
  generateAgentId,
  generatePersonaId,
} from './ids.js';

// ─── Time utilities ────────────────────────────────────────────────────────
export { nowMs, nowIso, withTimeout, TimeoutError } from './time.js';

// ─── Result / errors ───────────────────────────────────────────────────────
export type { Result, Ok, Err } from './result.js';
export { ok, err, isOk, isErr, unwrap } from './result.js';
export {
  EgoError,
  SchemaValidationError,
  EgoPipelineAbort,
  EgoTimeoutError,
  DailyCostCapExceeded,
  CircuitOpenError,
} from './errors.js';

// ─── ADR-006 state helpers ─────────────────────────────────────────────────
export {
  isOperational,
  isIntervening,
  canTransition,
  downgradeState,
  upgradeState,
  compareStates,
} from './adr/state.js';

// ─── Normalize helpers ─────────────────────────────────────────────────────
export {
  classifyComplexity,
  classifyText,
  countClauses,
  countSequentialConnectors,
  estimateTokenCount,
} from './normalize/complexity.js';
export type { ComplexityInput } from './normalize/complexity.js';

// ─── Env util ──────────────────────────────────────────────────────────────
export { resolveEnvVars } from './utils/index.js';
