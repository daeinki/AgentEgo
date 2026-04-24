import type { Contracts, GoalUpdate, Plan, PlanStep, ReasoningMode, ReasoningState, ReasoningStep, SessionPolicy, StandardMessage } from '@agent-platform/core';
import { DEFAULT_REASONING_BUDGET, generateId, nowMs } from '@agent-platform/core';
import type { CompletionMessage, ModelAdapter } from '../model/types.js';
import type { StepMatcher } from './step-matcher.js';

/**
 * Minimum EGO `cognition.egoRelevance` score required to fire replan
 * trigger #3 (agent-orchestration.md §4.4). Above this threshold AND with a
 * non-empty `goalUpdates[]`, the executor forces a single planner refresh so
 * the plan can absorb the freshly signaled goal-state changes.
 */
const TRIGGER_3_REL_THRESHOLD = 0.8;

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
  /**
   * Optional semantic matcher for carrying successful steps across a replan.
   * When absent, preservation falls back to exact-id matching only (v0.6
   * behavior). When present, a new plan's step is matched against prior
   * successes by `goal` similarity after id lookup fails — covers the case
   * where the planner re-worded the same step with a fresh id.
   */
  stepMatcher?: StepMatcher;
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
 *   - Replan trigger #2 (LLM judge contradiction) — requires an extra LLM
 *     call per step, intentionally deferred (cost)
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

    // 1b. Trigger #3: if EGO flagged this turn as high-relevance AND produced
    //     goal updates, immediately re-plan once so the planner can absorb
    //     the goal-state context it didn't see on the first call. Counts
    //     against `replanLimit` so combined with trigger #1 we still cap at N.
    if (shouldFireGoalUpdateReplan(ctx) && replanLimit > 0) {
      const refreshed = yield* this.applyGoalUpdateReplan(ctx, plan, state);
      if (refreshed) {
        plan = refreshed;
        replanCount += 1;
      }
    }

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
      // so we don't re-execute completed work. When an id doesn't match and
      // a `stepMatcher` is wired, fall back to semantic similarity on
      // `goal` — catches the case where the planner re-worded the step
      // with a fresh id.
      const preserved = await preservePriorSuccesses(
        plan.steps,
        newPlan.steps,
        this.deps.stepMatcher,
      );

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

  // ─── Trigger #3: goal-update replan ───────────────────────────────────────

  /**
   * Re-run the planner once with the current plan + `goalUpdates[]` surfaced
   * so the new plan can reflect the shifted goal context. Emits a `replan`
   * trace marker with reason `goal_updates_high_relevance` and preserves
   * successful steps via id-match (same rule as trigger #1). Returns the new
   * plan, or `undefined` if the planner produced invalid JSON (caller keeps
   * the original plan in that case — we don't downgrade to ReAct for this
   * trigger; execution still has a chance).
   */
  private async *applyGoalUpdateReplan(
    ctx: Contracts.ReasoningContext,
    previousPlan: Plan,
    state: ReasoningState,
  ): AsyncGenerator<Contracts.ReasoningEvent, Plan | undefined> {
    const goalUpdates = ctx.goalUpdates ?? [];
    ctx.traceLogger?.event({
      traceId: ctx.userMessage.traceId,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      block: 'R3',
      event: 'replan',
      timestamp: Date.now(),
      payload: {
        round: 1,
        reason: 'goal_updates_high_relevance',
        egoRelevance: ctx.egoCognition?.egoRelevance ?? null,
        goalUpdateCount: goalUpdates.length,
      },
    });

    const planner = this.deps.plannerModel ?? this.actorModel;
    const prompt = buildGoalUpdatePrompt(ctx, previousPlan, goalUpdates);
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
    if (!parsed.ok) return undefined;
    parsed.value.parentPlanId = previousPlan.id;

    // Same preservation rule as trigger #1 — exact id first, then optional
    // semantic fallback via `stepMatcher` when id lookup misses.
    const preserved = await preservePriorSuccesses(
      previousPlan.steps,
      parsed.value.steps,
      this.deps.stepMatcher,
    );

    const replanStep: ReasoningStep = {
      kind: 'replan',
      at: nowMs(),
      content: {
        fromPlanId: previousPlan.id,
        toPlanId: parsed.value.id,
        reason: 'goal_updates_high_relevance',
        preservedStepIds: preserved,
        goalUpdateCount: goalUpdates.length,
        egoRelevance: ctx.egoCognition?.egoRelevance ?? null,
      },
    };
    state.trace.push(replanStep);
    yield { kind: 'step', step: replanStep };
    state.plan = parsed.value;
    state.trace.push({ kind: 'plan', at: nowMs(), content: parsed.value });
    yield { kind: 'step', step: lastStep(state) };
    return parsed.value;
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

/**
 * Gate for replan trigger #3. Fires when EGO judged the turn highly relevant
 * to current goals (`egoRelevance > TRIGGER_3_REL_THRESHOLD`) AND produced
 * at least one `goalUpdate`. Both signals together mean the initial plan
 * was formed without the goal-state shift — a single refresh pass lets the
 * planner account for it. Missing EGO context degrades to no-op.
 */
function shouldFireGoalUpdateReplan(ctx: Contracts.ReasoningContext): boolean {
  const rel = ctx.egoCognition?.egoRelevance;
  if (typeof rel !== 'number' || rel <= TRIGGER_3_REL_THRESHOLD) return false;
  return (ctx.goalUpdates?.length ?? 0) > 0;
}

function buildGoalUpdatePrompt(
  ctx: Contracts.ReasoningContext,
  previousPlan: Plan,
  goalUpdates: GoalUpdate[],
): { systemPrompt: string; messages: CompletionMessage[] } {
  const toolList = ctx.availableTools.map((t) => `- ${t.name}: ${t.description}`).join('\n');
  const planLines = previousPlan.steps
    .map((s) => `- ${s.id}: ${s.goal}${s.tool ? ` [tool=${s.tool}]` : ''}`)
    .join('\n');
  const updateLines = goalUpdates
    .map((u) => `- ${u.goalId} Δ=${u.progressDelta}${u.notes ? ` (${u.notes})` : ''}`)
    .join('\n');
  const cognition = ctx.egoCognition;
  const situationBlock = cognition
    ? `\n\n상황 요약: ${cognition.situationSummary}\n` +
      (cognition.opportunities.length > 0
        ? `기회: ${cognition.opportunities.join(' / ')}\n`
        : '') +
      (cognition.risks.length > 0 ? `위험: ${cognition.risks.join(' / ')}\n` : '')
    : '';
  const systemPrompt =
    `${ctx.systemPrompt}\n\n## 목표 갱신 반영 재계획\n` +
    `EGO 가 이번 턴을 고관련(egoRelevance=${cognition?.egoRelevance?.toFixed(2) ?? '?'}) 으로 판정하고 다음 목표 변경을 보고했다:\n` +
    `${updateLines}${situationBlock}\n` +
    `현재 계획:\n${planLines || '(없음)'}\n\n` +
    `사용 가능 도구:\n${toolList || '(없음)'}\n\n` +
    `위 목표 변경을 반영해 계획을 다시 작성하라. 이미 유효한 단계는 동일 \`id\` 로 유지하면 재실행되지 않는다.\n` +
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

/**
 * Mutate `newSteps` in place to inherit `status='success'` + `observation`
 * from `priorSteps` when the planner's new plan either re-uses a prior step
 * id OR (with a `StepMatcher` injected) emits a semantically-equivalent step
 * under a fresh id. Returns the list of preserved step ids — in the order
 * they appear in the new plan — for trace/observability.
 *
 * Rules:
 *   1. **Exact id match** is tried first and always wins when present
 *      (zero-cost, deterministic).
 *   2. **Semantic fallback**: for each new step whose id did not match, the
 *      matcher is asked to find the best candidate among the remaining
 *      prior successes. A prior success can only be bound to a single new
 *      step — whichever new step matches it first wins; later semantic hits
 *      on the same prior id are ignored (prevents double-preservation).
 *   3. When `matcher` is omitted, semantic fallback is skipped and behavior
 *      matches the pre-v0.7 exact-id-only rule.
 */
export async function preservePriorSuccesses(
  priorSteps: ReadonlyArray<PlanStep>,
  newSteps: PlanStep[],
  matcher?: StepMatcher,
): Promise<string[]> {
  const priorSuccessList = priorSteps.filter((s) => s.status === 'success');
  if (priorSuccessList.length === 0) return [];

  const byId = new Map(priorSuccessList.map((s) => [s.id, s] as const));
  const preserved: string[] = [];
  const used = new Set<string>();
  const pendingSemantic: PlanStep[] = [];

  // Pass 1: exact id matches.
  for (const step of newSteps) {
    const prior = byId.get(step.id);
    if (prior && !used.has(prior.id)) {
      step.status = 'success';
      step.observation = prior.observation;
      preserved.push(step.id);
      used.add(prior.id);
    } else {
      pendingSemantic.push(step);
    }
  }

  // Pass 2: semantic fallback — one call per unresolved step.
  if (matcher && pendingSemantic.length > 0) {
    for (const step of pendingSemantic) {
      const remaining = priorSuccessList.filter((p) => !used.has(p.id));
      if (remaining.length === 0) break;
      const matchedId = await matcher.match(
        step.goal,
        remaining.map((p) => ({ id: p.id, goal: p.goal })),
      );
      if (matchedId && !used.has(matchedId)) {
        const prior = byId.get(matchedId)!;
        step.status = 'success';
        step.observation = prior.observation;
        preserved.push(step.id);
        used.add(matchedId);
      }
    }
  }

  return preserved;
}

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
