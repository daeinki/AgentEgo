import type { Contracts, SessionPolicy } from '@agent-platform/core';
import { nowMs, DEFAULT_REASONING_BUDGET } from '@agent-platform/core';
import type {
  ReasoningMode,
  ReasoningState,
  ReasoningStep,
  TerminationReason,
} from '@agent-platform/core';
import type {
  CompletionMessage,
  ModelAdapter,
  StreamChunk,
  ToolDefinition,
} from '../model/types.js';

export interface ReactExecutorConfig {
  maxSteps?: number;
  maxToolCalls?: number;
  toolRetryLimit?: number;
}

export interface ReactExecutorDeps {
  capabilityGuard?: Contracts.CapabilityGuard;
  toolSandbox?: Contracts.ToolSandbox;
  sessionPolicy?: SessionPolicy;
  /** Optional per-turn debug trace logger (pipeline blocks R1/R2). */
  traceLogger?: Contracts.TraceLogger;
}

interface PendingToolCall {
  id: string;
  name: string;
  argsRaw: string;
}

/**
 * ReAct Contracts.Reasoner — interleaved Thought/Action/Observation loop.
 *
 * Contract: agent-orchestration.md §3. The executor is deliberately degenerate
 * to a single LLM call when `availableTools` is empty, preserving the prior
 * behavior of AgentRunner (which streamed a single completion with no tool
 * handling).
 */
export class ReactExecutor implements Contracts.Reasoner {
  readonly mode: ReasoningMode = 'react';

  constructor(
    private readonly modelAdapter: ModelAdapter,
    private readonly deps: ReactExecutorDeps = {},
    private readonly config: ReactExecutorConfig = {},
  ) {}

  async *run(ctx: Contracts.ReasoningContext): AsyncIterable<Contracts.ReasoningEvent> {
    const budget = cloneBudget(ctx.budget);
    if (this.config.maxSteps !== undefined) budget.maxSteps = this.config.maxSteps;
    if (this.config.maxToolCalls !== undefined) budget.maxToolCalls = this.config.maxToolCalls;

    const retryLimit = this.config.toolRetryLimit ?? 2;

    const state: ReasoningState = {
      mode: 'react',
      egoDecisionId: ctx.egoDecisionId,
      trace: [],
      budget,
    };

    const messages: CompletionMessage[] = [...ctx.priorMessages.map(toCompletionMessage)];
    messages.push({ role: 'user', content: extractText(ctx.userMessage) });

    const canExecuteTools =
      ctx.availableTools.length > 0 &&
      this.deps.toolSandbox !== undefined &&
      this.deps.capabilityGuard !== undefined;

    const toolDefs = canExecuteTools ? ctx.availableTools.map(toToolDefinition) : undefined;
    const retryCounts = new Map<string, number>();

    let finalText = '';

    while (budget.spent.steps < budget.maxSteps) {
      if (ctx.abortSignal?.aborted) {
        state.terminationReason = 'user_abort';
        break;
      }

      budget.spent.steps++;
      const pendingCalls = new Map<string, PendingToolCall>();
      let stepText = '';
      let stopReason = '';

      for await (const chunk of this.modelAdapter.stream(buildRequest(ctx.systemPrompt, messages, toolDefs))) {
        if (ctx.abortSignal?.aborted) {
          state.terminationReason = 'user_abort';
          break;
        }
        const event = handleChunk(chunk, pendingCalls);
        if (event) yield event;
        if (chunk.type === 'text_delta') stepText += chunk.text;
        if (chunk.type === 'done') stopReason = chunk.stopReason;
      }

      if (state.terminationReason === 'user_abort') break;

      const calls = [...pendingCalls.values()];

      if (calls.length === 0) {
        finalText = stepText;
        appendStep(state, { kind: 'final', at: nowMs(), content: { text: finalText, stopReason } });
        yield { kind: 'step', step: lastStep(state) };
        state.terminationReason = 'final_answer';
        break;
      }

      if (stepText.length > 0) {
        appendStep(state, { kind: 'thought', at: nowMs(), content: { text: stepText } });
      }

      let toolBudgetHit = false;
      // Providers require a single assistant message carrying ALL tool_calls
      // of this step, followed by one `role:'tool'` message per call. We
      // collect executed observations first, then push the assistant+tool
      // messages in one shot at the end of the iteration.
      const executedCalls: Array<{ call: PendingToolCall; observationText: string }> = [];
      for (const call of calls) {
        if (budget.spent.toolCalls >= budget.maxToolCalls) {
          state.terminationReason = 'tool_exhaustion';
          toolBudgetHit = true;
          break;
        }
        budget.spent.toolCalls++;

        appendStep(state, {
          kind: 'tool_call',
          at: nowMs(),
          content: { id: call.id, name: call.name, argsRaw: call.argsRaw },
        });
        yield { kind: 'step', step: lastStep(state) };

        const retryKey = `${call.name}:${call.argsRaw}`;
        const priorRetries = retryCounts.get(retryKey) ?? 0;

        const toolStart = Date.now();
        const observation = await this.executeTool(ctx, call, priorRetries, retryLimit);
        ctx.traceLogger?.event({
          traceId: ctx.userMessage.traceId,
          sessionId: ctx.sessionId,
          agentId: ctx.agentId,
          block: 'R2',
          event: 'tool_call',
          timestamp: Date.now(),
          durationMs: Date.now() - toolStart,
          payload: {
            toolName: call.name,
            toolStatus: observation.success
              ? 'ok'
              : observation.reason === 'permission_denied'
                ? 'denied'
                : 'error',
            retry: priorRetries,
          },
        });
        if (!observation.success) {
          retryCounts.set(retryKey, priorRetries + 1);
        }

        appendStep(state, {
          kind: 'observation',
          at: nowMs(),
          content: observation,
        });
        yield { kind: 'step', step: lastStep(state) };

        executedCalls.push({ call, observationText: observation.text });
      }

      if (executedCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: stepText,
          toolCalls: executedCalls.map(({ call }) => ({
            id: call.id,
            name: call.name,
            arguments: call.argsRaw,
          })),
        });
        for (const { call, observationText } of executedCalls) {
          messages.push({
            role: 'tool',
            content: observationText,
            toolCallId: call.id,
            toolName: call.name,
          });
        }
      }

      if (toolBudgetHit) break;
    }

    if (!state.terminationReason) {
      state.terminationReason = budget.spent.steps >= budget.maxSteps ? 'max_steps' : 'hard_error';
    }

    yield { kind: 'final', text: finalText, state };
  }

  private async executeTool(
    ctx: Contracts.ReasoningContext,
    call: PendingToolCall,
    priorRetries: number,
    retryLimit: number,
  ): Promise<{ success: boolean; text: string; toolError?: boolean; reason?: string }> {
    const { capabilityGuard, toolSandbox, sessionPolicy } = this.deps;
    if (!capabilityGuard || !toolSandbox) {
      return { success: false, text: '[tool execution not wired]', toolError: true, reason: 'no_executor' };
    }

    let args: unknown;
    try {
      args = call.argsRaw.length > 0 ? JSON.parse(call.argsRaw) : {};
    } catch (err) {
      return {
        success: false,
        text: `invalid JSON args: ${(err as Error).message}`,
        toolError: true,
        reason: 'invalid_args',
      };
    }

    const permission = await capabilityGuard.check(ctx.sessionId, call.name, args);
    if (!permission.allowed) {
      return {
        success: false,
        text: `permission denied: ${permission.reason}`,
        toolError: true,
        reason: 'permission_denied',
      };
    }

    if (!sessionPolicy) {
      return {
        success: false,
        text: '[tool execution requires sessionPolicy to be wired]',
        toolError: true,
        reason: 'no_policy',
      };
    }
    const policy = sessionPolicy;
    const sandbox = await toolSandbox.acquire(policy);
    try {
      const result = await toolSandbox.execute(sandbox, call.name, args, 30_000);
      if (result.success) {
        return { success: true, text: result.output ?? '' };
      }
      if (priorRetries < retryLimit) {
        return {
          success: false,
          text: `tool error (retry ${priorRetries + 1}/${retryLimit}): ${result.error ?? 'unknown'}`,
          toolError: true,
          reason: 'transient',
        };
      }
      return {
        success: false,
        text: `tool error (exhausted retries): ${result.error ?? 'unknown'}`,
        toolError: true,
        reason: 'exhausted',
      };
    } finally {
      await toolSandbox.release(sandbox);
    }
  }
}

function cloneBudget(source?: Contracts.ReasoningContext['budget']) {
  const base = source ?? DEFAULT_REASONING_BUDGET;
  return {
    maxSteps: base.maxSteps,
    maxToolCalls: base.maxToolCalls,
    spent: { steps: base.spent.steps, toolCalls: base.spent.toolCalls },
  };
}

function buildRequest(
  systemPrompt: string,
  messages: CompletionMessage[],
  tools: ToolDefinition[] | undefined,
) {
  const req: {
    systemPrompt: string;
    messages: CompletionMessage[];
    tools?: ToolDefinition[];
  } = { systemPrompt, messages: [...messages] };
  if (tools && tools.length > 0) req.tools = tools;
  return req;
}

function toToolDefinition(t: Contracts.ToolDescriptor): ToolDefinition {
  return { name: t.name, description: t.description, inputSchema: t.inputSchema };
}

function toCompletionMessage(m: Contracts.ReasoningContext['priorMessages'][number]): CompletionMessage {
  const out: CompletionMessage = { role: m.role, content: m.content };
  if (m.toolCallId !== undefined) out.toolCallId = m.toolCallId;
  if (m.toolName !== undefined) out.toolName = m.toolName;
  return out;
}

function handleChunk(
  chunk: StreamChunk,
  pending: Map<string, PendingToolCall>,
): Contracts.ReasoningEvent | null {
  switch (chunk.type) {
    case 'text_delta':
      return { kind: 'delta', text: chunk.text };
    case 'tool_call_start':
      pending.set(chunk.id, { id: chunk.id, name: chunk.name, argsRaw: '' });
      return null;
    case 'tool_call_delta': {
      const entry = pending.get(chunk.id);
      if (entry) entry.argsRaw += chunk.args;
      return null;
    }
    case 'tool_call_end':
      return null;
    case 'usage': {
      const ev: Contracts.ReasoningEvent = { kind: 'usage', inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens };
      if (chunk.cost !== undefined) (ev as { cost?: number }).cost = chunk.cost;
      return ev;
    }
    case 'done':
      return null;
    default:
      return null;
  }
}

function appendStep(state: ReasoningState, step: ReasoningStep) {
  state.trace.push(step);
}

function lastStep(state: ReasoningState): ReasoningStep {
  return state.trace[state.trace.length - 1]!;
}

function extractText(msg: Contracts.ReasoningContext['userMessage']): string {
  const content = msg.content;
  if (content.type === 'text') return content.text;
  if (content.type === 'command') return `/${content.name} ${content.args.join(' ')}`;
  if (content.type === 'media') return content.caption ?? '[media]';
  if (content.type === 'reaction') return content.emoji;
  return '';
}

// Re-export for downstream phases (plan-execute may reuse the termination enum).
export type { TerminationReason };
