export type {
  ModelAdapter,
  ModelTraceContext,
  CompletionRequest,
  CompletionMessage,
  StreamChunk,
  ToolDefinition,
} from './model/types.js';
export { AnthropicAdapter, type AnthropicConfig } from './model/anthropic.js';
export { OpenAIAdapter, type OpenAIConfig } from './model/openai.js';
export { PromptBuilder } from './prompt/builder.js';
export {
  AgentRunner,
  type AgentConfig,
  type TurnResult,
  type AgentRunnerDeps,
} from './runner/agent-runner.js';

// Tools
export type { AgentTool, ToolExecutionContext } from './tools/types.js';
export { InProcessSandbox } from './tools/sandbox.js';
export { fsListTool, fsReadTool, fsWriteTool, webFetchTool } from './tools/built-in.js';
export { buildDefaultTools, type DefaultToolsConfig } from './tools/presets.js';
export { LiveToolRegistry } from './tools/live-registry.js';
export {
  DockerSandbox,
  isDockerTool,
} from './tools/docker-sandbox.js';
export type {
  DockerTool,
  DockerCommandSpec,
  DockerSandboxConfig,
} from './tools/docker-sandbox.js';
export {
  DockerContainerRuntime,
  buildDockerArgs,
} from './tools/container-runtime.js';
export type {
  ContainerRuntime,
  RunOptions,
  ContainerResult,
  ResourceLimits,
} from './tools/container-runtime.js';
export { bashTool, type BashToolConfig } from './tools/bash-tool.js';
export {
  skillCreateTool,
  skillListTool,
  skillRemoveTool,
  skillReloadTool,
  skillAuthoringTools,
  type SkillToolDeps,
} from './tools/skill-tools.js';

// Security
export { PolicyCapabilityGuard, ownerPolicy } from './security/capability-guard.js';

// Reasoning (ADR-009 / agent-orchestration.md)
export {
  ReactExecutor,
  type ReactExecutorConfig,
  type ReactExecutorDeps,
} from './reasoning/react-executor.js';
export {
  PlanExecuteExecutor,
  type PlanExecuteConfig,
  type PlanExecuteDeps,
  parsePlan,
} from './reasoning/plan-execute-executor.js';
export {
  DefaultComplexityRouter,
  countSentences,
  countImperativeVerbs,
} from './reasoning/complexity-router.js';
export {
  HybridReasoner,
  type HybridReasonerDeps,
  type HybridReasonerConfig,
} from './reasoning/hybrid-reasoner.js';

export {
  EmbedderStepMatcher,
  cosineSimilarity as stepMatcherCosineSimilarity,
  type StepMatcher,
  type EmbedFn,
  type EmbedderStepMatcherOptions,
} from './reasoning/step-matcher.js';
