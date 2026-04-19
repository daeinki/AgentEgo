export { loadEgoConfig, isEgoEnabled, isEgoActive, getEgoState } from './config.js';
export { EgoLayer } from './layer.js';
export type { EgoLayerDependencies, EgoProcessParams, ProcessRecord } from './layer.js';
export { intake } from './signal.js';
export type { EgoSignal } from './signal.js';
export {
  normalize,
  shouldFastExit,
  classifyIntent,
  classifyUrgency,
  classifySentiment,
  extractEntities,
} from './normalize.js';
export type { NormalizedSignal, ExtractedEntity } from './normalize.js';
export { AnthropicEgoLlmAdapter, estimateCost } from './llm-adapter.js';
export { OpenAiEgoLlmAdapter, estimateOpenAiCost } from './llm-adapter-openai.js';
export { FallbackEgoLlmAdapter } from './llm-adapter-fallback.js';
export { createEgoLlmAdapter, type EgoLlmProvider } from './llm-adapter-factory.js';
export { CircuitBreaker } from './circuit-breaker.js';
export type { CircuitBreakerConfig, CircuitState } from './circuit-breaker.js';
export { gatherContext } from './context-gatherer.js';
export type { EgoGatheredContext, GatherParams } from './context-gatherer.js';
export { FileGoalStore } from './goal-store.js';
export { FilePersonaManager } from './persona-manager.js';
export type { PersonaManagerConfig } from './persona-manager.js';
export {
  evolvePersona,
  applyDecay,
  computeMaturity,
  maturityScale,
  inferDirection,
  DEFAULT_EVOLUTION_RULES,
} from './persona-evolution.js';
export type { EvolutionOutcome, EvolveParams } from './persona-evolution.js';
export { LlmFeedbackParser } from './feedback-parser.js';
export type {
  LlmFeedbackParserOptions,
  ParseParams,
  FeedbackParserModelAdapter,
} from './feedback-parser.js';
export { SqliteAuditLog } from './audit-log.js';
export { performRedirect } from './redirect.js';
export type { RedirectParams, RedirectResult } from './redirect.js';
export { loadSystemPrompt, buildSystemPrompt } from './system-prompt.js';
