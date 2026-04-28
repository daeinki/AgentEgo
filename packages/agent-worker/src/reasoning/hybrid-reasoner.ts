import type { Contracts, ReasoningMode, SessionPolicy } from '@agent-platform/core';
import type { ModelAdapter } from '../model/types.js';
import { ReactExecutor, type ReactExecutorConfig, type ReactExecutorDeps } from './react-executor.js';
import { PlanExecuteExecutor, type PlanExecuteConfig } from './plan-execute-executor.js';
import { DefaultComplexityRouter } from './complexity-router.js';
import type { StepMatcher } from './step-matcher.js';

export interface HybridReasonerDeps extends ReactExecutorDeps {
  plannerModel?: ModelAdapter;
  /**
   * Forwarded into `PlanExecuteExecutor` for semantic preservation of
   * successful steps across a replan (see `preservePriorSuccesses`). Omit to
   * keep exact-id-only behavior.
   */
  stepMatcher?: StepMatcher;
}

export interface HybridReasonerConfig {
  react?: ReactExecutorConfig;
  planExecute?: PlanExecuteConfig;
  /**
   * Force-disable plan-execute even when tool deps are wired. Useful during
   * rollout to start with ReAct-only and enable plan-execute after validation.
   */
  disablePlanExecute?: boolean;
}

/**
 * Wraps the complexity router + both executors into a single Reasoner that
 * dispatches per-turn. Agent-orchestration.md §1.2 "hybrid" mode.
 *
 * Plan-Execute is only reachable when all three tool deps (capabilityGuard,
 * toolSandbox, sessionPolicy) are wired — otherwise every turn is routed to
 * ReAct.
 */
export class HybridReasoner implements Contracts.Reasoner {
  // `mode` on the Reasoner interface is informational; real dispatch happens
  // per-turn. Report 'react' as the lowest-common-denominator.
  readonly mode: ReasoningMode = 'react';

  private readonly react: ReactExecutor;
  private readonly planExecute: PlanExecuteExecutor | undefined;
  private readonly router: Contracts.ComplexityRouter;

  constructor(
    modelAdapter: ModelAdapter,
    deps: HybridReasonerDeps = {},
    config: HybridReasonerConfig = {},
    router?: Contracts.ComplexityRouter,
  ) {
    this.react = new ReactExecutor(modelAdapter, deps, config.react);
    this.router = router ?? new DefaultComplexityRouter();

    const toolsWired =
      deps.capabilityGuard !== undefined &&
      deps.toolSandbox !== undefined &&
      deps.sessionPolicy !== undefined;

    if (toolsWired && !config.disablePlanExecute) {
      const planDeps: {
        capabilityGuard: Contracts.CapabilityGuard;
        toolSandbox: Contracts.ToolSandbox;
        sessionPolicy: SessionPolicy;
        plannerModel?: ModelAdapter;
        traceLogger?: Contracts.TraceLogger;
        stepMatcher?: StepMatcher;
      } = {
        capabilityGuard: deps.capabilityGuard!,
        toolSandbox: deps.toolSandbox!,
        sessionPolicy: deps.sessionPolicy!,
      };
      if (deps.plannerModel) planDeps.plannerModel = deps.plannerModel;
      if (deps.traceLogger) planDeps.traceLogger = deps.traceLogger;
      if (deps.stepMatcher) planDeps.stepMatcher = deps.stepMatcher;
      this.planExecute = new PlanExecuteExecutor(
        modelAdapter,
        this.react,
        planDeps,
        config.planExecute ?? {},
      );
    } else {
      this.planExecute = undefined;
    }
  }

  async *run(ctx: Contracts.ReasoningContext): AsyncIterable<Contracts.ReasoningEvent> {
    const mode = this.selectMode(ctx);
    const effectiveMode = mode === 'plan_execute' && this.planExecute ? 'plan_execute' : 'react';
    ctx.traceLogger?.event({
      traceId: ctx.userMessage.traceId,
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      block: 'R1',
      event: 'mode_selected',
      timestamp: Date.now(),
      summary:
        mode !== effectiveMode
          ? `router → ${mode} but plan-execute unavailable; falling back to ${effectiveMode}`
          : `router → ${effectiveMode}`,
      payload: {
        mode: effectiveMode,
        routerSuggested: mode,
        planExecuteAvailable: this.planExecute !== undefined,
      },
    });
    const exec = effectiveMode === 'plan_execute' ? this.planExecute! : this.react;
    yield* exec.run(ctx);
  }

  private selectMode(ctx: Contracts.ReasoningContext): ReasoningMode {
    const input: Contracts.ComplexityRouterInput = {
      userMessage: ctx.userMessage,
      availableTools: ctx.availableTools,
      ...(ctx.egoPerception ? { egoPerception: ctx.egoPerception } : {}),
    };
    return this.router.select(input);
  }
}
