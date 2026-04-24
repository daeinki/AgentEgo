import type { Cognition, Perception } from '../schema/ego-thinking.js';
import type { GoalUpdate } from '../schema/goal.js';
import type {
  ReasoningMode,
  ReasoningState,
  ReasoningStep,
  ReasoningBudget,
} from '../schema/reasoning.js';
import type { StandardMessage } from '../types/message.js';
import type { TraceLogger } from './trace-logger.js';

// ─── Tool descriptor (structurally compatible with agent-worker's) ─────────

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ─── ComplexityRouter (agent-orchestration.md §2) ──────────────────────────

export interface ComplexityRouterInput {
  egoPerception?: Perception;
  userMessage: StandardMessage;
  availableTools: ToolDescriptor[];
  forceMode?: ReasoningMode;
}

export interface ComplexityRouter {
  select(input: ComplexityRouterInput): ReasoningMode;
}

// ─── Reasoner (agent-orchestration.md §3, §4) ──────────────────────────────

export type ReasoningEvent =
  | { kind: 'step'; step: ReasoningStep }
  | { kind: 'delta'; text: string }
  | { kind: 'step_progress'; stepId: string; goal: string; status: 'running' | 'success' | 'failed' }
  | { kind: 'usage'; inputTokens: number; outputTokens: number; cost?: number }
  | { kind: 'final'; text: string; state: ReasoningState };

export interface ReasoningContext {
  sessionId: string;
  agentId: string;
  userMessage: StandardMessage;
  systemPrompt: string;
  priorMessages: { role: 'user' | 'assistant' | 'tool'; content: string; toolCallId?: string; toolName?: string }[];
  availableTools: ToolDescriptor[];
  budget?: ReasoningBudget;
  egoDecisionId: string | null;
  /**
   * Optional EGO `Perception` snapshot from the upstream judgment. When
   * present, ComplexityRouter uses it directly (requestType /
   * estimatedComplexity) instead of falling back to text heuristics.
   * Lifted from `channel.metadata._egoPerception` by AgentRunner.
   */
  egoPerception?: Perception;
  /**
   * Optional EGO `Cognition` snapshot (opportunities/risks/egoRelevance).
   * Consumed by PlanExecuteExecutor to gate replan trigger #3
   * (egoRelevance > 0.8 AND goalUpdates.length > 0 — see
   * agent-orchestration.md §4.4). Lifted from
   * `channel.metadata._egoCognition` by AgentRunner.
   */
  egoCognition?: Cognition;
  /**
   * Optional goal-state deltas produced by EGO's deep-path LLM in this turn.
   * When combined with `egoCognition.egoRelevance > 0.8` these trigger a
   * single replan pass so the planner can account for the updated goal
   * context. Lifted from `channel.metadata._egoGoalUpdates` by AgentRunner.
   */
  goalUpdates?: GoalUpdate[];
  abortSignal?: AbortSignal;
  /**
   * Optional per-turn debug trace logger for pipeline blocks R1/R2/R3 and
   * their sub-events (mode selection, step boundaries, tool calls, replan).
   * AgentRunner populates this from its own `deps.traceLogger` on every turn.
   */
  traceLogger?: TraceLogger;
}

export interface Reasoner {
  mode: ReasoningMode;
  run(ctx: ReasoningContext): AsyncIterable<ReasoningEvent>;
}
