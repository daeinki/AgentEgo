import type { Contracts, Plan, PlanStep, ReasoningMode, ReasoningState, ReasoningStep, SessionPolicy, StandardMessage } from '@agent-platform/core';
import { DEFAULT_REASONING_BUDGET, generateId, nowMs } from '@agent-platform/core';
import type { CompletionMessage, ModelAdapter } from '../model/types.js';

export interface PlanExecuteConfig {
  plannerTemperature?: number;
  plannerMaxTokens?: number;
  /**
   * Per-step retry budget (initial attempt + this many additional tries).
   * Default 1 — i.e. one retry on failure, matching the spec's "동일 단계
   * 2회 연속 실패" replan trigger (§4.4).
   */
  stepRetryLimit?: number;
  /**
   * Maximum replan rounds per turn. After exhausting this, the executor
   * downgrades to the injected ReAct fallback with a fresh budget. Default 2
   * (agent-orchestration.md §4.4).
   */
  replanLimit?: number;
  /**
   * When true, steps within the same dependency level are executed
   * concurrently via `Promise.all`. Assumes tools have no hidden
   * side-effects on each other. Default false (sequential — the spec's v0.1
   * default in §6.1). Events from parallel peers are buffered and yielded
   * after the level completes to keep the trace deterministic.
   */
  parallelExecution?: boolean;
}

export interface PlanExecuteDeps {
  capabilityGuard?: Contracts.CapabilityGuard;
  toolSandbox?: Contracts.ToolSandbox;
  sessionPolicy?: SessionPolicy;
  plannerModel?: ModelAdapter;
  /** Optional per-turn debug trace logger (pipeline block R3). */
  traceLogger?: Contracts.TraceLogger;
}

interface ReplanContext {
  failedStep: PlanStep;
  attempt: number;
}

/**
 * Plan-and-Execute Reasoner — agent-orchestration.md §4.
 *
 * Pipeline:
 *   1. Planner LLM call → JSON plan
 *   2. Sequential step execution via tool sandbox (per step: initial attempt
 *      + `stepRetryLimit` retries)
 *   3. On 2 consecutive step failures: trigger replan (§4.4 trigger #1)
 *      — calls planner again with failure context, replaces the plan, and
 *      resumes execution from the failed step
 *   4. After `replanLimit` exhausted: downgrade to the injected ReAct fallback
 *      with a fresh budget (§4.4)
 *   5. Final answer synthesis via a second LLM call
 *
 * Out of scope:
 *   - Replan triggers #2 (LLM judge contradiction) and #3 (egoRelevance>0.8
 *     goal updates) — both require additional plumbing not yet in
 *     ReasoningContext
 *   - Parallel step execution (sequential topo order only — design §6.1)
 */
export class PlanExecuteExecutor implements Contracts.Reasoner {
  readonly mode: ReasoningMode = 'plan_execute';

  constructor(
    private readonly actorModel: ModelAdapter,
    private readonly reactFallback: Contracts.Reasoner,
    private readonly deps: PlanExecuteDeps = {},
    private readonly config: PlanExecuteConfig = {},
  ) {}

  async *run(ctx: Contracts.ReasoningContext): AsyncIterable<Contracts.ReasoningEvent> {
    if (ctx.abortSignal?.aborted) {
      yield finalEvent('', userAbortState(ctx));
      return;
    }

    const stepRetryLimit = this.config.stepRetryLimit ?? 1;
    const replanLimit = this.config.replanLimit ?? 2;

    // 1. Initial planner call
    const initialPlan = yield* this.callPlanner(ctx, undefined);
    if (!initialPlan) {
      yield* this.downgradeOnPlanError(ctx, 'plan_validation_error');
      return;
    }

    let plan: Plan = initialPlan;
    const state: ReasoningState = {
      mode: 'plan_execute',
      egoDecisionId: ctx.egoDecisionId,
      trace: [{ kind: 'plan', at: nowMs(), content: plan }],
      plan,
      budget: cloneBudget(ctx.budget),
    };
    yield { kind: 'step', step: lastStep(state) };

    ctx.traceLogger?.event({
      traceId: ctx.userMessage.traceId,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      block: 'R3',
      event: 'plan_generated',
      timestamp: Date.now(),
      payload: { stepCount: plan.steps.length },
    });

    let replanCount = 0;

    // 2-3. Execution loop. Reentered after each successful replan.
    while (true) {
      if (ctx.abortSignal?.aborted) {
        state.terminationReason = 'user_abort';
        yield finalEvent('', state);
        return;
      }

      const outcome = yield* this.executePlan(ctx, plan, stepRetryLimit);

      if (outcome.kind === 'aborted') {
        state.terminationReason = 'user_abort';
        yield finalEvent('', state);
        return;
      }

      if (outcome.kind === 'success' || outcome.kind === 'partial') {
        // No remaining unrecovered failures, or only dependency-skipped steps.
        break;
      }

      // outcome.kind === 'replan_needed'
      if (replanCount >= replanLimit) {
        // Downgrade to ReAct with remaining goals + fresh budget.
        ctx.traceLogger?.event({
          traceId: ctx.userMessage.traceId,
          sessionId: ctx.sessionId,
          agentId: ctx.agentId,
          block: 'R3',
          event: 'downgraded_to_react',
          timestamp: Date.now(),
          payload: { replanCount, reason: 'replan_limit_exhausted' },
        });
        yield* this.downgradeToReact(ctx, plan, outcome.failure, replanCount, state);
        return;
      }

      replanCount += 1;
      ctx.traceLogger?.event({
        traceId: ctx.userMessage.traceId,
        sessionId: ctx.sessionId,
        agentId: ctx.agentId,
        block: 'R3',
        event: 'replan',
        timestamp: Date.now(),
        payload: {
          round: replanCount,
          failedStepId: outcome.failure.failedStep.id,
        },
      });
      const newPlan = yield* this.callPlanner(ctx, {
        previousPlan: plan,
        failure: outcome.failure,
        replanRound: replanCount,
      });
      if (!newPlan) {
        // Validation failure on replan — also a downgrade case.
        ctx.traceLogger?.event({
          traceId: ctx.userMessage.traceId,
          sessionId: ctx.sessionId,
          agentId: ctx.agentId,
          block: 'R3',
          event: 'downgraded_to_react',
          timestamp: Date.now(),
          payload: { replanCount, reason: 'plan_validation_error' },
        });
        yield* this.downgradeToReact(ctx, plan, outcome.failure, replanCount, state, 'plan_validation_error');
        return;
      }

      // T9b: preserve prior plan's successful steps. If the LLM's new plan
      // re-uses a step id from a prior success, transfer status + observation
      // so we don't re-execute completed work. IDs that differ are treated as
      // brand-new steps (LLM chose a different approach).
      const preserved: string[] = [];
      const priorSuccesses = new Map(
        plan.steps.filter((s) => s.status === 'success').map((s) => [s.id, s] as const),
      );
      for (const step of newPlan.steps) {
        const prior = priorSuccesses.get(step.id);
        if (prior) {
          step.status = 'success';
          step.observation = prior.observation;
          preserved.push(step.id);
        }
      }

      const replanStep: ReasoningStep = {
        kind: 'replan',
        at: nowMs(),
        content: {
          fromPlanId: plan.id,
          toPlanId: newPlan.id,
          reason: 'step_retry_exhausted',
          failedStepId: outcome.failure.failedStep.id,
          attempt: outcome.failure.attempt,
          preservedStepIds: preserved,
        },
      };
      state.trace.push(replanStep);
      yield { kind: 'step', step: replanStep };

      plan = newPlan;
      state.plan = plan;
      state.trace.push({ kind: 'plan', at: nowMs(), content: plan });
      yield { kind: 'step', step: lastStep(state) };
    }

    // 5. Synthesize final answer using the (possibly replan-adjusted) plan.
    const finalText = yield* this.synthesizeFinal(ctx, plan);
    state.terminationReason = plan.steps.some((s) => s.status === 'failed')
      ? 'hard_error'
      : 'final_answer';
    state.trace.push({ kind: 'final', at: nowMs(), content: { text: finalText } });
    yield { kind: 'final', text: finalText, state };
  }

  // ─── Execution ────────────────────────────────────────────────────────────

  private async *executePlan(
    ctx: Contracts.ReasoningContext,
    plan: Plan,
    stepRetryLimit: number,
  ): AsyncGenerator<
    Contracts.ReasoningEvent,
    | { kind: 'success' }
    | { kind: 'partial' }
    | { kind: 'aborted' }
    | { kind: 'replan_needed'; failure: ReplanContext }
  > {
    const stepById = new Map(plan.steps.map((s) => [s.id, s]));
    const levels = computeLevels(plan);

    for (const level of levels) {
      if (ctx.abortSignal?.aborted) return { kind: 'aborted' };

      // Pre-filter: skip steps already settled (replan-preserved successes
      // or earlier failed/skipped) and cascade dep-failed → skipped before
      // anything actually runs.
      const runnable: PlanStep[] = [];
      for (const step of level) {
        if (step.status === 'success' || step.status === 'failed' || step.status === 'skipped') {
          continue;
        }
        const depFailed = step.dependsOn.some((id) => {
          const dep = stepById.get(id);
          return dep === undefined || dep.status === 'failed' || dep.status === 'skipped';
        });
        if (depFailed) {
          step.status = 'skipped';
          yield { kind: 'step_progress', stepId: step.id, goal: step.goal, status: 'failed' };
          continue;
        }
        runnable.push(step);
      }

      if (runnable.length === 0) continue;

      if (this.config.parallelExecution && runnable.length > 1) {
        const failedStep = yield* this.executeLevelParallel(ctx, runnable, stepRetryLimit);
        if (failedStep) {
          return {
            kind: 'replan_needed',
            failure: { failedStep, attempt: stepRetryLimit + 1 },
          };
        }
      } else {
        for (const step of runnable) {
          const settled = yield* this.runStepWithRetries(ctx, step, stepRetryLimit);
          if (settled === 'failed') {
            return {
              kind: 'replan_needed',
              failure: { failedStep: step, attempt: stepRetryLimit + 1 },
            };
          }
        }
      }
    }

    const anyFailed = plan.steps.some((s) => s.status === 'failed');
    return anyFailed ? { kind: 'partial' } : { kind: 'success' };
  }

  /**
   * Run a level's steps concurrently. Buffers each step's events so the
   * outer trace stays deterministic (events are flushed in step-array order
   * after all peers complete). Returns the first-by-position failed step, or
   * undefined if the whole level succeeded.
   */
  private async *executeLevelParallel(
    ctx: Contracts.ReasoningContext,
    steps: PlanStep[],
    stepRetryLimit: number,
  ): AsyncGenerator<Contracts.ReasoningEvent, PlanStep | undefined> {
    const results = await Promise.all(
      steps.map(async (step) => {
        const events: Contracts.ReasoningEvent[] = [];
        for await (const ev of this.runStepWithRetries(ctx, step, stepRetryLimit)) {
          events.push(ev);
        }
        return { step, events };
      }),
    );
    for (const { events } of results) {
      for (const ev of events) yield ev;
    }
    return results.find((r) => r.step.status === 'failed')?.step;
  }

  private async *runStepWithRetries(
    ctx: Contracts.ReasoningContext,
    step: PlanStep,
    retryLimit: number,
  ): AsyncGenerator<Contracts.ReasoningEvent, 'success' | 'failed'> {
    const totalAttempts = retryLimit + 1;
    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      step.status = 'running';
      yield { kind: 'step_progress', stepId: step.id, goal: step.goal, status: 'running' };

      const ok = await this.executeStep(ctx, step);
      if (ok) {
        step.status = 'success';
        yield { kind: 'step_progress', stepId: step.id, goal: step.goal, status: 'success' };
        return 'success';
      }

      // Attempt failed — record observation in the step. If we have retries
      // left, loop. Otherwise mark failed and signal replan_needed upstream.
      if (attempt < totalAttempts) continue;
      step.status = 'failed';
      yield { kind: 'step_progress', stepId: step.id, goal: step.goal, status: 'failed' };
      return 'failed';
    }
    return 'failed';
  }

  private async executeStep(ctx: Contracts.ReasoningContext, step: PlanStep): Promise<boolean> {
    if (!step.tool) {
      step.observation = { skipped: true, reason: 'no tool assigned' };
      return true;
    }
    const { toolSandbox, capabilityGuard, sessionPolicy } = this.deps;
    if (!toolSandbox || !capabilityGuard || !sessionPolicy) {
      step.observation = { error: 'tool execution not wired' };
      return false;
    }

    const args = (step.args ?? {}) as Record<string, unknown>;
    const decision = await capabilityGuard.check(ctx.sessionId, step.tool, args);
    if (!decision.allowed) {
      step.observation = { error: `permission denied: ${decision.reason}` };
      return false;
    }

    const sandbox = await toolSandbox.acquire(sessionPolicy);
    try {
      const result = await toolSandbox.execute(sandbox, step.tool, args, 30_000);
      step.observation = result;
      return result.success;
    } finally {
      await toolSandbox.release(sandbox);
    }
  }

  // ─── Planning ─────────────────────────────────────────────────────────────

  private async *callPlanner(
    ctx: Contracts.ReasoningContext,
    replan: { previousPlan: Plan; failure: ReplanContext; replanRound: number } | undefined,
  ): AsyncGenerator<Contracts.ReasoningEvent, Plan | null> {
    const planner = this.deps.plannerModel ?? this.actorModel;
    const prompt = replan
      ? buildReplanPrompt(ctx, replan.previousPlan, replan.failure, replan.replanRound)
      : buildPlannerPrompt(ctx);

    let planText = '';
    for await (const chunk of planner.stream({
      systemPrompt: prompt.systemPrompt,
      messages: prompt.messages,
      temperature: this.config.plannerTemperature ?? 0.2,
      maxTokens: this.config.plannerMaxTokens ?? 1024,
    })) {
      if (chunk.type === 'text_delta') planText += chunk.text;
      else if (chunk.type === 'usage') {
        const ev: Contracts.ReasoningEvent = {
          kind: 'usage',
          inputTokens: chunk.inputTokens,
          outputTokens: chunk.outputTokens,
        };
        if (chunk.cost !== undefined) (ev as { cost?: number }).cost = chunk.cost;
        yield ev;
      }
    }

    const parsed = parsePlan(planText);
    if (!parsed.ok) return null;
    if (replan) parsed.value.parentPlanId = replan.previousPlan.id;
    return parsed.value;
  }

  // ─── Downgrade paths ──────────────────────────────────────────────────────

  /**
   * Initial-plan validation failure: emit a replan trace marker and hand off
   * to the ReAct fallback with the original message intact.
   */
  private async *downgradeOnPlanError(
    ctx: Contracts.ReasoningContext,
    reason: 'plan_validation_error',
  ): AsyncGenerator<Contracts.ReasoningEvent, void> {
    const marker: ReasoningStep = {
      kind: 'replan',
      at: nowMs(),
      content: { reason },
    };
    yield { kind: 'step', step: marker };
    for await (const ev of this.reactFallback.run(ctx)) yield ev;
  }

  /**
   * Replan limit exhausted (or replan itself failed): hand off to ReAct with a
   * fresh budget and a message augmented with the remaining unfinished goals.
   */
  private async *downgradeToReact(
    ctx: Contracts.ReasoningContext,
    plan: Plan,
    failure: ReplanContext,
    replanRound: number,
    state: ReasoningState,
    extraReason: 'replan_limit_exceeded' | 'plan_validation_error' = 'replan_limit_exceeded',
  ): AsyncGenerator<Contracts.ReasoningEvent, void> {
    const remaining = plan.steps.filter((s) => s.status === 'pending' || s.status === 'failed');
    const marker: ReasoningStep = {
      kind: 'replan',
      at: nowMs(),
      content: {
        reason: extraReason,
        replanRound,
        failedStepId: failure.failedStep.id,
        remainingGoals: remaining.map((s) => s.goal),
      },
    };
    state.trace.push(marker);
    yield { kind: 'step', step: marker };

    const downgradedCtx: Contracts.ReasoningContext = {
      ...ctx,
      userMessage: augmentUserMessage(ctx.userMessage, remaining),
      // Fresh budget (agent-orchestration.md §4.4 budget handoff rule).
      ...(ctx.budget !== undefined ? {} : {}),
    };
    delete (downgradedCtx as { budget?: unknown }).budget;

    for await (const ev of this.reactFallback.run(downgradedCtx)) yield ev;
  }

  // ─── Synthesis ────────────────────────────────────────────────────────────

  private async *synthesizeFinal(ctx: Contracts.ReasoningContext, plan: Plan): AsyncGenerator<Contracts.ReasoningEvent, string> {
    const summary = plan.steps
      .map((s) => `- [${s.status}] ${s.goal}${s.observation ? `: ${summarizeObservation(s.observation)}` : ''}`)
      .join('\n');
    const prompt =
      `${ctx.systemPrompt}\n\n## 실행 결과\n${summary}\n\n위 실행 결과를 바탕으로 사용자에게 최종 답변을 한국어로 간결히 제공하라.`;
    const messages: CompletionMessage[] = [
      ...ctx.priorMessages.map(copyMessage),
      { role: 'user', content: extractText(ctx.userMessage) },
    ];
    let text = '';
    for await (const chunk of this.actorModel.stream({ systemPrompt: prompt, messages })) {
      if (chunk.type === 'text_delta') text += chunk.text;
      else if (chunk.type === 'usage') {
        const ev: Contracts.ReasoningEvent = {
          kind: 'usage',
          inputTokens: chunk.inputTokens,
          outputTokens: chunk.outputTokens,
        };
        if (chunk.cost !== undefined) (ev as { cost?: number }).cost = chunk.cost;
        yield ev;
      }
    }
    return text;
  }
}

// ─── Planner prompts ───────────────────────────────────────────────────────

function buildPlannerPrompt(ctx: Contracts.ReasoningContext): {
  systemPrompt: string;
  messages: CompletionMessage[];
} {
  const toolList = ctx.availableTools
    .map((t) => `- ${t.name}: ${t.description}`)
    .join('\n');
  const systemPrompt =
    `${ctx.systemPrompt}\n\n## 계획 수립 지시\n` +
    `아래 사용자 요청을 수행하기 위한 단계별 계획을 JSON 으로만 응답하라.\n` +
    `사용 가능 도구:\n${toolList || '(없음)'}\n\n` +
    `출력 스키마:\n` +
    `{\n` +
    `  "rationale": "한 줄 근거",\n` +
    `  "steps": [\n` +
    `    { "id": "s1", "goal": "단계 목표", "tool": "도구명 또는 null", "args": {...}, "dependsOn": [] }\n` +
    `  ]\n` +
    `}\n` +
    `반드시 위 JSON 만 반환. 다른 텍스트 금지.`;
  return {
    systemPrompt,
    messages: [
      ...ctx.priorMessages.map(copyMessage),
      { role: 'user', content: extractText(ctx.userMessage) },
    ],
  };
}

function buildReplanPrompt(
  ctx: Contracts.ReasoningContext,
  previousPlan: Plan,
  failure: ReplanContext,
  replanRound: number,
): { systemPrompt: string; messages: CompletionMessage[] } {
  const toolList = ctx.availableTools.map((t) => `- ${t.name}: ${t.description}`).join('\n');
  const failedStepLine = `${failure.failedStep.id} (${failure.failedStep.goal}) — ${summarizeObservation(failure.failedStep.observation)}`;
  const completedLines = previousPlan.steps
    .filter((s) => s.status === 'success')
    .map((s) => `- ${s.id} (${s.goal}) → success`);
  const systemPrompt =
    `${ctx.systemPrompt}\n\n## 재계획 지시 (${replanRound}회차)\n` +
    `이전 계획의 단계 \`${failure.failedStep.id}\` 가 ${failure.attempt}회 시도 후 실패했다.\n` +
    `실패 단계: ${failedStepLine}\n` +
    `성공한 단계 (재실행 금지):\n${completedLines.join('\n') || '(없음)'}\n\n` +
    `사용 가능 도구:\n${toolList || '(없음)'}\n\n` +
    `남은 목표를 새 계획으로 다시 작성하라. 동일한 실패가 반복되지 않도록 다른 도구·인자·접근을 고려하라.\n` +
    `출력 스키마는 동일:\n` +
    `{ "rationale": "...", "steps": [ { "id": "...", "goal": "...", "tool": "...", "args": {...}, "dependsOn": [] } ] }\n` +
    `JSON 만 반환.`;
  return {
    systemPrompt,
    messages: [
      ...ctx.priorMessages.map(copyMessage),
      { role: 'user', content: extractText(ctx.userMessage) },
    ],
  };
}

// ─── Topological levels ───────────────────────────────────────────────────

/**
 * Group steps into dependency levels. Level 0 = steps with no dependsOn,
 * level N = steps whose deps are all in earlier levels. Steps with missing
 * or cyclic deps are appended as a final level so they still get visited
 * (and will cascade to 'skipped' inside executePlan).
 */
export function computeLevels(plan: Plan): PlanStep[][] {
  const remaining = new Set(plan.steps);
  const placed = new Set<string>();
  const levels: PlanStep[][] = [];
  while (remaining.size > 0) {
    const ready: PlanStep[] = [];
    for (const step of remaining) {
      if (step.dependsOn.every((id) => placed.has(id))) ready.push(step);
    }
    if (ready.length === 0) {
      // Cycle or dangling dep — flush remaining in plan order.
      levels.push([...remaining]);
      break;
    }
    levels.push(ready);
    for (const step of ready) {
      remaining.delete(step);
      placed.add(step.id);
    }
  }
  return levels;
}

// ─── Plan parsing/validation ───────────────────────────────────────────────

export function parsePlan(text: string): { ok: true; value: Plan } | { ok: false; error: string } {
  const stripped = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'not an object' };
  const obj = parsed as { rationale?: unknown; steps?: unknown };
  if (typeof obj.rationale !== 'string') return { ok: false, error: 'missing rationale' };
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) return { ok: false, error: 'missing steps' };

  const steps: PlanStep[] = [];
  for (const raw of obj.steps as unknown[]) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'step is not object' };
    const s = raw as { id?: unknown; goal?: unknown; tool?: unknown; args?: unknown; dependsOn?: unknown };
    if (typeof s.id !== 'string' || s.id.length === 0) return { ok: false, error: 'step.id missing' };
    if (typeof s.goal !== 'string' || s.goal.length === 0) return { ok: false, error: 'step.goal missing' };
    const dependsOn = Array.isArray(s.dependsOn)
      ? (s.dependsOn as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    const step: PlanStep = {
      id: s.id,
      goal: s.goal,
      dependsOn,
      status: 'pending',
    };
    if (typeof s.tool === 'string' && s.tool.length > 0) step.tool = s.tool;
    if (s.args && typeof s.args === 'object') step.args = s.args as Record<string, unknown>;
    steps.push(step);
  }
  const plan: Plan = {
    id: `plan-${generateId()}`,
    createdAt: nowMs(),
    steps,
    rationale: obj.rationale,
  };
  return { ok: true, value: plan };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function cloneBudget(source?: Contracts.ReasoningContext['budget']) {
  const base = source ?? DEFAULT_REASONING_BUDGET;
  return {
    maxSteps: base.maxSteps,
    maxToolCalls: base.maxToolCalls,
    spent: { steps: base.spent.steps, toolCalls: base.spent.toolCalls },
  };
}

function userAbortState(ctx: Contracts.ReasoningContext): ReasoningState {
  return {
    mode: 'plan_execute',
    egoDecisionId: ctx.egoDecisionId,
    trace: [],
    budget: cloneBudget(ctx.budget),
    terminationReason: 'user_abort',
  };
}

function finalEvent(text: string, state: ReasoningState): Contracts.ReasoningEvent {
  return { kind: 'final', text, state };
}

function lastStep(state: ReasoningState): ReasoningStep {
  return state.trace[state.trace.length - 1]!;
}

function copyMessage(m: Contracts.ReasoningContext['priorMessages'][number]): CompletionMessage {
  const out: CompletionMessage = { role: m.role, content: m.content };
  if (m.toolCallId !== undefined) out.toolCallId = m.toolCallId;
  if (m.toolName !== undefined) out.toolName = m.toolName;
  return out;
}

function extractText(msg: Contracts.ReasoningContext['userMessage']): string {
  const c = msg.content;
  if (c.type === 'text') return c.text;
  if (c.type === 'command') return `/${c.name} ${c.args.join(' ')}`;
  if (c.type === 'media') return c.caption ?? '';
  if (c.type === 'reaction') return c.emoji;
  return '';
}

function summarizeObservation(obs: unknown): string {
  if (obs === null || obs === undefined) return '';
  if (typeof obs === 'string') return obs.slice(0, 200);
  try {
    return JSON.stringify(obs).slice(0, 200);
  } catch {
    return String(obs).slice(0, 200);
  }
}

/**
 * Build a synthetic user message for the ReAct fallback that lists the
 * goals not finished by the plan-execute path. Keeps `channel` + `sender`
 * + IDs so downstream observability still has provenance.
 */
function augmentUserMessage(original: StandardMessage, remaining: PlanStep[]): StandardMessage {
  const remainingText =
    remaining.length === 0
      ? ''
      : `\n\n[plan-execute 가 다음 목표를 완료하지 못해 ReAct 로 위임됨]\n` +
        remaining.map((s, i) => `${i + 1}. ${s.goal}`).join('\n');
  const baseText = extractText(original);
  return {
    ...original,
    content: { type: 'text', text: `${baseText}${remainingText}` },
  };
}
