import { describe, it, expect } from 'vitest';
import type { Cognition, Contracts, StandardMessage, SessionPolicy } from '@agent-platform/core';
import { generateMessageId, generateTraceId, nowMs } from '@agent-platform/core';
import type { CompletionRequest, ModelAdapter, StreamChunk } from '../model/types.js';
import {
  PlanExecuteExecutor,
  parsePlan,
  computeLevels,
  preservePriorSuccesses,
} from './plan-execute-executor.js';
import type { Plan, PlanStep } from '@agent-platform/core';
import { ReactExecutor } from './react-executor.js';
import type { StepMatcher } from './step-matcher.js';

function makeMsg(text: string): StandardMessage {
  return {
    id: generateMessageId(),
    traceId: generateTraceId(),
    timestamp: nowMs(),
    channel: { type: 'webchat', id: 'w-1', metadata: {} },
    sender: { id: 'u', isOwner: true },
    conversation: { type: 'dm', id: 'c-1' },
    content: { type: 'text', text },
  };
}

class ScriptedAdapter implements ModelAdapter {
  private call = 0;
  constructor(private readonly scripts: string[]) {}
  async *stream(_req: CompletionRequest): AsyncIterable<StreamChunk> {
    const text = this.scripts[this.call] ?? '';
    this.call += 1;
    yield { type: 'text_delta', text };
    yield { type: 'usage', inputTokens: 5, outputTokens: 5 };
    yield { type: 'done', stopReason: 'end_turn' };
  }
  getModelInfo() {
    return { provider: 'mock', model: 'mock' };
  }
}

const ownerPolicy: SessionPolicy = {
  sessionId: 's-1',
  trustLevel: 'owner',
  grantedCapabilities: [],
  deniedCapabilities: [],
  sandboxMode: 'never',
  resourceLimits: { maxCpuSeconds: 1, maxMemoryMb: 1, maxDiskMb: 1, networkEnabled: false },
};

const alwaysAllow: Contracts.CapabilityGuard = { async check() { return { allowed: true }; } };

const makeSandbox = (log: string[] = []): Contracts.ToolSandbox => ({
  async acquire() {
    return {
      id: 'sb-1',
      status: 'ready',
      startedAt: nowMs(),
      resourceUsage: { cpuSeconds: 0, memoryMb: 0, diskMb: 0 },
    };
  },
  async execute(_sb, name, args) {
    log.push(`${name}:${JSON.stringify(args)}`);
    return { toolName: name, success: true, output: `ok(${name})`, durationMs: 1 };
  },
  async release() {},
});

function makeCtx(overrides: Partial<Contracts.ReasoningContext> = {}): Contracts.ReasoningContext {
  return {
    sessionId: 's-1',
    agentId: 'a-1',
    userMessage: makeMsg('파일 목록 보여주고 첫 줄만 요약해'),
    systemPrompt: 'sys',
    priorMessages: [],
    availableTools: [
      { name: 'list', description: 'list files', inputSchema: {} },
      { name: 'head', description: 'head first line', inputSchema: {} },
    ],
    egoDecisionId: null,
    ...overrides,
  };
}

async function collect(iter: AsyncIterable<Contracts.ReasoningEvent>): Promise<Contracts.ReasoningEvent[]> {
  const out: Contracts.ReasoningEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe('parsePlan', () => {
  it('parses a valid plan JSON', () => {
    const txt = JSON.stringify({
      rationale: 'two-step',
      steps: [
        { id: 's1', goal: 'list files', tool: 'list', args: {}, dependsOn: [] },
        { id: 's2', goal: 'head first', tool: 'head', args: { n: 1 }, dependsOn: ['s1'] },
      ],
    });
    const out = parsePlan(txt);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.steps).toHaveLength(2);
      expect(out.value.steps[0]?.tool).toBe('list');
      expect(out.value.steps[1]?.dependsOn).toEqual(['s1']);
    }
  });

  it('strips markdown code fences before parsing', () => {
    const txt = '```json\n{"rationale":"r","steps":[{"id":"a","goal":"g","dependsOn":[]}]}\n```';
    const out = parsePlan(txt);
    expect(out.ok).toBe(true);
  });

  it('rejects invalid JSON', () => {
    expect(parsePlan('not json').ok).toBe(false);
    expect(parsePlan('{"rationale": "only"}').ok).toBe(false);
    expect(parsePlan('{"steps": []}').ok).toBe(false);
  });
});

describe('PlanExecuteExecutor', () => {
  it('happy path: planner returns valid plan, all steps execute, final answer synthesized', async () => {
    const planJson = JSON.stringify({
      rationale: 'do it in two steps',
      steps: [
        { id: 's1', goal: 'list', tool: 'list', args: {}, dependsOn: [] },
        { id: 's2', goal: 'head', tool: 'head', args: {}, dependsOn: ['s1'] },
      ],
    });
    const model = new ScriptedAdapter([planJson, '최종 요약']);
    const execLog: string[] = [];
    const reactFallback = new ReactExecutor(model);
    const ex = new PlanExecuteExecutor(
      model,
      reactFallback,
      { capabilityGuard: alwaysAllow, toolSandbox: makeSandbox(execLog), sessionPolicy: ownerPolicy },
    );

    const events = await collect(ex.run(makeCtx()));
    expect(execLog).toEqual(['list:{}', 'head:{}']);

    const finals = events.filter((e) => e.kind === 'final') as { text: string; state: { terminationReason: string; plan?: unknown } }[];
    expect(finals).toHaveLength(1);
    expect(finals[0]?.state.terminationReason).toBe('final_answer');
    expect(finals[0]?.text).toBe('최종 요약');

    const progressKinds = events.filter((e) => e.kind === 'step_progress').map((e) => (e as { status: string }).status);
    expect(progressKinds).toContain('running');
    expect(progressKinds).toContain('success');
  });

  it('plan_validation_error: invalid planner output triggers ReAct downgrade', async () => {
    const badPlan = 'not a json';
    const fallbackAnswer = 'answered directly';
    const model = new ScriptedAdapter([badPlan, fallbackAnswer]);
    const reactFallback = new ReactExecutor(model);
    const ex = new PlanExecuteExecutor(
      model,
      reactFallback,
      { capabilityGuard: alwaysAllow, toolSandbox: makeSandbox(), sessionPolicy: ownerPolicy },
    );

    const events = await collect(ex.run(makeCtx()));
    const replan = events.find(
      (e) => e.kind === 'step' && (e as { step: { kind: string } }).step.kind === 'replan',
    );
    expect(replan).toBeDefined();

    // The ReAct fallback's final event should be forwarded
    const final = events.find((e) => e.kind === 'final') as { text: string };
    expect(final.text).toBe(fallbackAnswer);
  });

  it('step failure with replanLimit=0 + retries=0 immediately downgrades to ReAct', async () => {
    const planJson = JSON.stringify({
      rationale: 'will fail',
      steps: [{ id: 's1', goal: 'fail me', tool: 'broken', args: {}, dependsOn: [] }],
    });
    const model = new ScriptedAdapter([planJson, 'react fallback answer']);

    const failingSandbox: Contracts.ToolSandbox = {
      async acquire() {
        return { id: 'sb', status: 'ready', startedAt: nowMs(), resourceUsage: { cpuSeconds: 0, memoryMb: 0, diskMb: 0 } };
      },
      async execute(_sb, name) {
        if (name === 'broken') return { toolName: name, success: false, error: 'boom', durationMs: 0 };
        return { toolName: name, success: true, output: 'ok', durationMs: 1 };
      },
      async release() {},
    };
    const reactFallback = new ReactExecutor(model);
    const ex = new PlanExecuteExecutor(
      model,
      reactFallback,
      { capabilityGuard: alwaysAllow, toolSandbox: failingSandbox, sessionPolicy: ownerPolicy },
      { stepRetryLimit: 0, replanLimit: 0 },
    );

    const events = await collect(ex.run(makeCtx()));
    const replanMarkers = events.filter(
      (e) => e.kind === 'step' && (e as { step: { kind: string; content?: { reason?: string } } }).step.kind === 'replan',
    );
    expect(replanMarkers).toHaveLength(1);
    expect(
      (replanMarkers[0] as { step: { content: { reason: string } } }).step.content.reason,
    ).toBe('replan_limit_exceeded');
    const final = events.find((e) => e.kind === 'final') as { text: string };
    expect(final.text).toBe('react fallback answer');
  });

  it('replan triggered after retry exhaustion: planner produces a new plan and resumes', async () => {
    const initialPlan = JSON.stringify({
      rationale: 'first try',
      steps: [{ id: 's1', goal: 'flaky step', tool: 'flaky', args: {}, dependsOn: [] }],
    });
    const replanPlan = JSON.stringify({
      rationale: 'after replan',
      steps: [{ id: 's2', goal: 'alt step', tool: 'works', args: {}, dependsOn: [] }],
    });
    const model = new ScriptedAdapter([initialPlan, replanPlan, '복구 완료']);

    const sandbox: Contracts.ToolSandbox = {
      async acquire() {
        return { id: 'sb', status: 'ready', startedAt: nowMs(), resourceUsage: { cpuSeconds: 0, memoryMb: 0, diskMb: 0 } };
      },
      async execute(_sb, name) {
        if (name === 'flaky') return { toolName: name, success: false, error: 'boom', durationMs: 0 };
        if (name === 'works') return { toolName: name, success: true, output: 'ok', durationMs: 1 };
        return { toolName: name, success: false, error: 'unknown', durationMs: 0 };
      },
      async release() {},
    };
    const reactFallback = new ReactExecutor(model);
    const ex = new PlanExecuteExecutor(
      model,
      reactFallback,
      { capabilityGuard: alwaysAllow, toolSandbox: sandbox, sessionPolicy: ownerPolicy },
      { stepRetryLimit: 1, replanLimit: 2 },
    );

    const events = await collect(ex.run(makeCtx()));
    const replanMarkers = events.filter(
      (e) => e.kind === 'step' && (e as { step: { kind: string } }).step.kind === 'replan',
    ) as { step: { content: { reason: string } } }[];
    expect(replanMarkers).toHaveLength(1);
    expect(replanMarkers[0]?.step.content.reason).toBe('step_retry_exhausted');

    const final = events.find((e) => e.kind === 'final') as {
      text: string;
      state: { terminationReason: string; plan?: { id: string; parentPlanId?: string; steps: { id: string; status: string }[] } };
    };
    expect(final.state.terminationReason).toBe('final_answer');
    expect(final.state.plan?.parentPlanId).toBeDefined();
    expect(final.state.plan?.steps[0]?.id).toBe('s2');
    expect(final.state.plan?.steps[0]?.status).toBe('success');
    expect(final.text).toBe('복구 완료');
  });

  it('parallelExecution=true runs same-level steps concurrently', async () => {
    const planJson = JSON.stringify({
      rationale: 'three independent steps',
      steps: [
        { id: 's1', goal: 'a', tool: 'a', args: {}, dependsOn: [] },
        { id: 's2', goal: 'b', tool: 'b', args: {}, dependsOn: [] },
        { id: 's3', goal: 'c', tool: 'c', args: {}, dependsOn: [] },
      ],
    });
    const model = new ScriptedAdapter([planJson, '완료']);

    // Each tool sleeps 30ms before returning. If executed sequentially total
    // wall time ≥ 90ms; if parallel ≈ 30ms.
    const slowSandbox: Contracts.ToolSandbox = {
      async acquire() {
        return { id: 'sb', status: 'ready', startedAt: nowMs(), resourceUsage: { cpuSeconds: 0, memoryMb: 0, diskMb: 0 } };
      },
      async execute(_sb, name) {
        await new Promise((r) => setTimeout(r, 30));
        return { toolName: name, success: true, output: 'ok', durationMs: 30 };
      },
      async release() {},
    };
    const reactFallback = new ReactExecutor(model);
    const ex = new PlanExecuteExecutor(
      model,
      reactFallback,
      { capabilityGuard: alwaysAllow, toolSandbox: slowSandbox, sessionPolicy: ownerPolicy },
      { parallelExecution: true },
    );

    const start = performance.now();
    const events = await collect(ex.run(makeCtx()));
    const elapsed = performance.now() - start;

    const final = events.find((e) => e.kind === 'final') as { state: { plan?: { steps: { status: string }[] } } };
    expect(final.state.plan?.steps.every((s) => s.status === 'success')).toBe(true);
    // Generous bound: parallel ≈ 30ms, sequential ≈ 90ms+. Anything <70ms
    // means the steps overlapped.
    expect(elapsed).toBeLessThan(70);
  });

  it('parallelExecution=true respects dependsOn (chain runs serialized)', async () => {
    const planJson = JSON.stringify({
      rationale: 'chained',
      steps: [
        { id: 's1', goal: 'a', tool: 'a', args: {}, dependsOn: [] },
        { id: 's2', goal: 'b', tool: 'b', args: {}, dependsOn: ['s1'] },
        { id: 's3', goal: 'c', tool: 'c', args: {}, dependsOn: ['s2'] },
      ],
    });
    const model = new ScriptedAdapter([planJson, '완료']);
    const order: string[] = [];
    const sandbox: Contracts.ToolSandbox = {
      async acquire() {
        return { id: 'sb', status: 'ready', startedAt: nowMs(), resourceUsage: { cpuSeconds: 0, memoryMb: 0, diskMb: 0 } };
      },
      async execute(_sb, name) {
        order.push(`start:${name}`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`end:${name}`);
        return { toolName: name, success: true, output: 'ok', durationMs: 5 };
      },
      async release() {},
    };
    const reactFallback = new ReactExecutor(model);
    const ex = new PlanExecuteExecutor(
      model,
      reactFallback,
      { capabilityGuard: alwaysAllow, toolSandbox: sandbox, sessionPolicy: ownerPolicy },
      { parallelExecution: true },
    );
    await collect(ex.run(makeCtx()));
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
  });

  it('replan preserves prior success: matching step id is not re-executed', async () => {
    const initialPlan = JSON.stringify({
      rationale: 'two steps, second fails',
      steps: [
        { id: 's-keep', goal: 'cheap success', tool: 'cheap', args: {}, dependsOn: [] },
        { id: 's-flaky', goal: 'will fail', tool: 'flaky', args: {}, dependsOn: ['s-keep'] },
      ],
    });
    // Replan re-emits s-keep (should be auto-success-preserved, not re-run)
    // and replaces s-flaky with s-alt.
    const replanPlan = JSON.stringify({
      rationale: 'redo flaky branch',
      steps: [
        { id: 's-keep', goal: 'cheap success', tool: 'cheap', args: {}, dependsOn: [] },
        { id: 's-alt', goal: 'try alt', tool: 'works', args: {}, dependsOn: ['s-keep'] },
      ],
    });
    const model = new ScriptedAdapter([initialPlan, replanPlan, '완료']);

    const calls: string[] = [];
    const sandbox: Contracts.ToolSandbox = {
      async acquire() {
        return { id: 'sb', status: 'ready', startedAt: nowMs(), resourceUsage: { cpuSeconds: 0, memoryMb: 0, diskMb: 0 } };
      },
      async execute(_sb, name) {
        calls.push(name);
        if (name === 'cheap') return { toolName: name, success: true, output: 'cheap-ok', durationMs: 1 };
        if (name === 'flaky') return { toolName: name, success: false, error: 'boom', durationMs: 1 };
        if (name === 'works') return { toolName: name, success: true, output: 'works-ok', durationMs: 1 };
        return { toolName: name, success: false, error: 'unknown', durationMs: 0 };
      },
      async release() {},
    };
    const reactFallback = new ReactExecutor(model);
    const ex = new PlanExecuteExecutor(
      model,
      reactFallback,
      { capabilityGuard: alwaysAllow, toolSandbox: sandbox, sessionPolicy: ownerPolicy },
      { stepRetryLimit: 1, replanLimit: 2 },
    );
    const events = await collect(ex.run(makeCtx()));

    // 'cheap' runs once initially. After replan, the new plan re-uses id
    // 's-keep' so it must NOT be re-executed. 'flaky' fires twice (initial +
    // 1 retry), then 'works' runs once in the new plan.
    expect(calls).toEqual(['cheap', 'flaky', 'flaky', 'works']);

    const replanMarker = events.find(
      (e) => e.kind === 'step' && (e as { step: { kind: string } }).step.kind === 'replan',
    ) as { step: { content: { preservedStepIds?: string[] } } };
    expect(replanMarker.step.content.preservedStepIds).toEqual(['s-keep']);
  });
});

describe('computeLevels', () => {
  it('groups independent steps into the same level', () => {
    const plan: Plan = {
      id: 'p1',
      createdAt: 0,
      rationale: '',
      steps: [
        { id: 'a', goal: 'a', dependsOn: [], status: 'pending' },
        { id: 'b', goal: 'b', dependsOn: [], status: 'pending' },
        { id: 'c', goal: 'c', dependsOn: ['a', 'b'], status: 'pending' },
      ],
    };
    const levels = computeLevels(plan);
    expect(levels).toHaveLength(2);
    expect(levels[0]?.map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(levels[1]?.map((s) => s.id)).toEqual(['c']);
  });

  it('flushes cyclic/dangling deps as a final level rather than infinite-looping', () => {
    const plan: Plan = {
      id: 'p2',
      createdAt: 0,
      rationale: '',
      steps: [
        { id: 'a', goal: 'a', dependsOn: ['ghost'], status: 'pending' },
      ],
    };
    const levels = computeLevels(plan);
    expect(levels).toHaveLength(1);
    expect(levels[0]?.[0]?.id).toBe('a');
  });
});

describe('PlanExecuteExecutor — trigger #3 (goalUpdates + egoRelevance)', () => {
  const cognitionHigh: Cognition = {
    relevantMemoryIndices: [],
    relatedGoalId: null,
    situationSummary: 'goal state shifted mid-turn',
    opportunities: ['re-scope'],
    risks: [],
    egoRelevance: 0.9,
  };

  it('fires an extra planner pass when egoRelevance>0.8 AND goalUpdates present', async () => {
    const initialPlan = JSON.stringify({
      rationale: 'first pass',
      steps: [{ id: 's1', goal: 'original goal', tool: 'list', args: {}, dependsOn: [] }],
    });
    // Trigger #3 reruns the planner before execution. This refreshed plan
    // must succeed and be the one that's actually executed.
    const refreshedPlan = JSON.stringify({
      rationale: 'refreshed with new goals',
      steps: [{ id: 's-new', goal: 'revised goal', tool: 'list', args: {}, dependsOn: [] }],
    });
    const model = new ScriptedAdapter([initialPlan, refreshedPlan, '완료']);
    const execLog: string[] = [];
    const reactFallback = new ReactExecutor(model);
    const ex = new PlanExecuteExecutor(
      model,
      reactFallback,
      { capabilityGuard: alwaysAllow, toolSandbox: makeSandbox(execLog), sessionPolicy: ownerPolicy },
    );

    const events = await collect(
      ex.run(
        makeCtx({
          egoCognition: cognitionHigh,
          goalUpdates: [{ goalId: 'goal-abc', progressDelta: 0.25, notes: 'scope widened' }],
        }),
      ),
    );

    const replanMarkers = events.filter(
      (e) => e.kind === 'step' && (e as { step: { kind: string } }).step.kind === 'replan',
    ) as { step: { content: { reason?: string; goalUpdateCount?: number; egoRelevance?: number } } }[];
    expect(replanMarkers).toHaveLength(1);
    expect(replanMarkers[0]?.step.content.reason).toBe('goal_updates_high_relevance');
    expect(replanMarkers[0]?.step.content.goalUpdateCount).toBe(1);
    expect(replanMarkers[0]?.step.content.egoRelevance).toBe(0.9);

    // Refreshed plan should have been executed, not the initial one.
    expect(execLog).toEqual(['list:{}']);
    const final = events.find((e) => e.kind === 'final') as {
      state: { plan?: { steps: { id: string; status: string }[] } };
    };
    expect(final.state.plan?.steps[0]?.id).toBe('s-new');
  });

  it('does NOT fire when egoRelevance is below threshold', async () => {
    const plan = JSON.stringify({
      rationale: 'plain',
      steps: [{ id: 's1', goal: 'do it', tool: 'list', args: {}, dependsOn: [] }],
    });
    const model = new ScriptedAdapter([plan, '완료']);
    const reactFallback = new ReactExecutor(model);
    const ex = new PlanExecuteExecutor(
      model,
      reactFallback,
      { capabilityGuard: alwaysAllow, toolSandbox: makeSandbox(), sessionPolicy: ownerPolicy },
    );

    const events = await collect(
      ex.run(
        makeCtx({
          egoCognition: { ...cognitionHigh, egoRelevance: 0.5 },
          goalUpdates: [{ goalId: 'goal-xyz', progressDelta: 0.1 }],
        }),
      ),
    );
    const replanMarkers = events.filter(
      (e) => e.kind === 'step' && (e as { step: { kind: string } }).step.kind === 'replan',
    );
    expect(replanMarkers).toHaveLength(0);
  });

  it('does NOT fire when goalUpdates is empty', async () => {
    const plan = JSON.stringify({
      rationale: 'plain',
      steps: [{ id: 's1', goal: 'do it', tool: 'list', args: {}, dependsOn: [] }],
    });
    const model = new ScriptedAdapter([plan, '완료']);
    const reactFallback = new ReactExecutor(model);
    const ex = new PlanExecuteExecutor(
      model,
      reactFallback,
      { capabilityGuard: alwaysAllow, toolSandbox: makeSandbox(), sessionPolicy: ownerPolicy },
    );

    const events = await collect(
      ex.run(makeCtx({ egoCognition: cognitionHigh, goalUpdates: [] })),
    );
    const replanMarkers = events.filter(
      (e) => e.kind === 'step' && (e as { step: { kind: string } }).step.kind === 'replan',
    );
    expect(replanMarkers).toHaveLength(0);
  });

  it('counts against replanLimit: one trigger-3 + one step-retry = 2 replans total', async () => {
    // Refreshed plan points at a flaky tool; retry exhaustion fires trigger #1,
    // producing a second replan round. With replanLimit=2 we should NOT
    // downgrade to ReAct (budget not exceeded).
    const initialPlan = JSON.stringify({
      rationale: 'initial',
      steps: [{ id: 's0', goal: 'original', tool: 'list', args: {}, dependsOn: [] }],
    });
    const refreshedPlan = JSON.stringify({
      rationale: 'refreshed after goal update',
      steps: [{ id: 's1', goal: 'flaky step', tool: 'flaky', args: {}, dependsOn: [] }],
    });
    const retryReplan = JSON.stringify({
      rationale: 'after retry',
      steps: [{ id: 's2', goal: 'fallback', tool: 'works', args: {}, dependsOn: [] }],
    });
    const model = new ScriptedAdapter([initialPlan, refreshedPlan, retryReplan, '완료']);

    const sandbox: Contracts.ToolSandbox = {
      async acquire() {
        return { id: 'sb', status: 'ready', startedAt: nowMs(), resourceUsage: { cpuSeconds: 0, memoryMb: 0, diskMb: 0 } };
      },
      async execute(_sb, name) {
        if (name === 'flaky') return { toolName: name, success: false, error: 'boom', durationMs: 0 };
        return { toolName: name, success: true, output: 'ok', durationMs: 1 };
      },
      async release() {},
    };
    const reactFallback = new ReactExecutor(model);
    const ex = new PlanExecuteExecutor(
      model,
      reactFallback,
      { capabilityGuard: alwaysAllow, toolSandbox: sandbox, sessionPolicy: ownerPolicy },
      { stepRetryLimit: 1, replanLimit: 2 },
    );

    const events = await collect(
      ex.run(
        makeCtx({
          egoCognition: cognitionHigh,
          goalUpdates: [{ goalId: 'goal-1', progressDelta: 0.2 }],
        }),
      ),
    );
    const replanMarkers = events.filter(
      (e) => e.kind === 'step' && (e as { step: { kind: string } }).step.kind === 'replan',
    ) as { step: { content: { reason?: string } } }[];
    // Expect trigger-3 marker + trigger-1 marker, but NO replan_limit_exceeded
    // (we haven't exceeded the budget).
    expect(replanMarkers.map((m) => m.step.content.reason)).toEqual([
      'goal_updates_high_relevance',
      'step_retry_exhausted',
    ]);
    const final = events.find((e) => e.kind === 'final') as {
      text: string;
      state: { terminationReason: string };
    };
    expect(final.state.terminationReason).toBe('final_answer');
    expect(final.text).toBe('완료');
  });
});

describe('PlanExecuteExecutor — planner JSON mode', () => {
  // Adapter that records the `responseFormat` field on every stream() call
  // so we can assert which calls opted into JSON mode.
  class CapturingAdapter implements ModelAdapter {
    public readonly seen: Array<{ format?: { type: 'json_object' | 'text' } }> = [];
    private call = 0;
    constructor(private readonly scripts: string[]) {}
    async *stream(req: CompletionRequest): AsyncIterable<StreamChunk> {
      this.seen.push({ format: req.responseFormat });
      const text = this.scripts[this.call] ?? '';
      this.call += 1;
      yield { type: 'text_delta', text };
      yield { type: 'usage', inputTokens: 1, outputTokens: 1 };
      yield { type: 'done', stopReason: 'end_turn' };
    }
    getModelInfo() {
      return { provider: 'mock', model: 'mock' };
    }
  }

  it('passes responseFormat=json_object on planner calls but NOT on synthesis', async () => {
    const planJson = JSON.stringify({
      rationale: 'one',
      steps: [{ id: 's1', goal: 'x', tool: 'list', args: {}, dependsOn: [] }],
    });
    const model = new CapturingAdapter([planJson, '최종']);
    const reactFallback = new ReactExecutor(model);
    const ex = new PlanExecuteExecutor(
      model,
      reactFallback,
      { capabilityGuard: alwaysAllow, toolSandbox: makeSandbox(), sessionPolicy: ownerPolicy },
    );
    await collect(ex.run(makeCtx()));

    // Two stream() calls: [0] planner, [1] synthesis.
    expect(model.seen).toHaveLength(2);
    expect(model.seen[0]?.format).toEqual({ type: 'json_object' });
    expect(model.seen[1]?.format).toBeUndefined();
  });

  it('replan planner calls also request json_object', async () => {
    const initialPlan = JSON.stringify({
      rationale: 'first',
      steps: [{ id: 's1', goal: 'flaky step', tool: 'flaky', args: {}, dependsOn: [] }],
    });
    const replanPlan = JSON.stringify({
      rationale: 'after replan',
      steps: [{ id: 's2', goal: 'alt', tool: 'works', args: {}, dependsOn: [] }],
    });
    const model = new CapturingAdapter([initialPlan, replanPlan, '복구']);
    const sandbox: Contracts.ToolSandbox = {
      async acquire() {
        return { id: 'sb', status: 'ready', startedAt: nowMs(), resourceUsage: { cpuSeconds: 0, memoryMb: 0, diskMb: 0 } };
      },
      async execute(_sb, name) {
        if (name === 'flaky') return { toolName: name, success: false, error: 'boom', durationMs: 0 };
        return { toolName: name, success: true, output: 'ok', durationMs: 1 };
      },
      async release() {},
    };
    const reactFallback = new ReactExecutor(model);
    const ex = new PlanExecuteExecutor(
      model,
      reactFallback,
      { capabilityGuard: alwaysAllow, toolSandbox: sandbox, sessionPolicy: ownerPolicy },
      { stepRetryLimit: 1, replanLimit: 2 },
    );
    await collect(ex.run(makeCtx()));

    // Three calls: initial planner, replan planner, synthesis.
    expect(model.seen).toHaveLength(3);
    expect(model.seen[0]?.format).toEqual({ type: 'json_object' });
    expect(model.seen[1]?.format).toEqual({ type: 'json_object' });
    expect(model.seen[2]?.format).toBeUndefined();
  });

  it('goal-update replan planner call also requests json_object', async () => {
    const initialPlan = JSON.stringify({
      rationale: 'first pass',
      steps: [{ id: 's1', goal: 'orig', tool: 'list', args: {}, dependsOn: [] }],
    });
    const refreshedPlan = JSON.stringify({
      rationale: 'refreshed',
      steps: [{ id: 's-new', goal: 'revised', tool: 'list', args: {}, dependsOn: [] }],
    });
    const model = new CapturingAdapter([initialPlan, refreshedPlan, '완료']);
    const reactFallback = new ReactExecutor(model);
    const ex = new PlanExecuteExecutor(
      model,
      reactFallback,
      { capabilityGuard: alwaysAllow, toolSandbox: makeSandbox(), sessionPolicy: ownerPolicy },
    );
    await collect(
      ex.run(
        makeCtx({
          egoCognition: {
            relevantMemoryIndices: [],
            relatedGoalId: null,
            situationSummary: 's',
            opportunities: [],
            risks: [],
            egoRelevance: 0.95,
          },
          goalUpdates: [{ goalId: 'g', progressDelta: 0.3 }],
        }),
      ),
    );

    // initial planner + goal-update replan + synthesis
    expect(model.seen).toHaveLength(3);
    expect(model.seen[0]?.format).toEqual({ type: 'json_object' });
    expect(model.seen[1]?.format).toEqual({ type: 'json_object' });
    expect(model.seen[2]?.format).toBeUndefined();
  });
});

describe('PlanExecuteExecutor — replan downgrade (continued)', () => {
  it('exhausts replanLimit=2 then downgrades to ReAct with augmented user message', async () => {
    const failingPlan = JSON.stringify({
      rationale: 'always fail',
      steps: [{ id: 's1', goal: '실패할 단계', tool: 'broken', args: {}, dependsOn: [] }],
    });
    // Initial plan + 2 replans (all fail) + ReAct fallback answer = 4 scripts.
    const model = new ScriptedAdapter([failingPlan, failingPlan, failingPlan, 'react 결과']);

    const failingSandbox: Contracts.ToolSandbox = {
      async acquire() {
        return { id: 'sb', status: 'ready', startedAt: nowMs(), resourceUsage: { cpuSeconds: 0, memoryMb: 0, diskMb: 0 } };
      },
      async execute(_sb, name) {
        return { toolName: name, success: false, error: 'always boom', durationMs: 0 };
      },
      async release() {},
    };
    const reactFallback = new ReactExecutor(model);
    const ex = new PlanExecuteExecutor(
      model,
      reactFallback,
      { capabilityGuard: alwaysAllow, toolSandbox: failingSandbox, sessionPolicy: ownerPolicy },
      { stepRetryLimit: 1, replanLimit: 2 },
    );

    const events = await collect(ex.run(makeCtx()));
    const replanMarkers = events.filter(
      (e) => e.kind === 'step' && (e as { step: { kind: string } }).step.kind === 'replan',
    ) as { step: { content: { reason: string; remainingGoals?: string[] } } }[];
    // 2 replan-triggered re-plan markers + 1 final replan_limit_exceeded marker.
    expect(replanMarkers).toHaveLength(3);
    expect(replanMarkers[2]?.step.content.reason).toBe('replan_limit_exceeded');
    expect(replanMarkers[2]?.step.content.remainingGoals).toContain('실패할 단계');

    const final = events.find((e) => e.kind === 'final') as { text: string };
    expect(final.text).toBe('react 결과');
  });
});

describe('preservePriorSuccesses', () => {
  function step(id: string, goal: string, overrides: Partial<PlanStep> = {}): PlanStep {
    return {
      id,
      goal,
      dependsOn: [],
      status: 'pending',
      ...overrides,
    };
  }

  const alwaysMatchFirst: StepMatcher = {
    async match(_q, candidates) {
      return candidates[0]?.id ?? null;
    },
  };

  const neverMatch: StepMatcher = {
    async match() {
      return null;
    },
  };

  it('exact id match carries status + observation', async () => {
    const prior = [step('s1', 'do it', { status: 'success', observation: { ok: true } })];
    const next = [step('s1', 'do it')];
    const preserved = await preservePriorSuccesses(prior, next);
    expect(preserved).toEqual(['s1']);
    expect(next[0]?.status).toBe('success');
    expect(next[0]?.observation).toEqual({ ok: true });
  });

  it('without a matcher, differing ids are NOT preserved', async () => {
    const prior = [step('old-id', 'same thing', { status: 'success' })];
    const next = [step('new-id', 'same thing')];
    const preserved = await preservePriorSuccesses(prior, next);
    expect(preserved).toEqual([]);
    expect(next[0]?.status).toBe('pending');
  });

  it('with a matcher, a different id + same intent is preserved', async () => {
    const prior = [step('old-id', 'same thing', { status: 'success', observation: 'x' })];
    const next = [step('new-id', 'same thing, reworded')];
    const preserved = await preservePriorSuccesses(prior, next, alwaysMatchFirst);
    expect(preserved).toEqual(['new-id']);
    expect(next[0]?.status).toBe('success');
    expect(next[0]?.observation).toBe('x');
  });

  it('matcher returning null does NOT preserve (no false positive)', async () => {
    const prior = [step('old', 'step A', { status: 'success' })];
    const next = [step('new', 'step B, totally unrelated')];
    const preserved = await preservePriorSuccesses(prior, next, neverMatch);
    expect(preserved).toEqual([]);
    expect(next[0]?.status).toBe('pending');
  });

  it('exact id match wins over semantic — matcher is never consulted when id hits', async () => {
    let matcherCalls = 0;
    const noisyMatcher: StepMatcher = {
      async match(_q, candidates) {
        matcherCalls += 1;
        return candidates[0]?.id ?? null;
      },
    };
    const prior = [
      step('s1', 'A', { status: 'success' }),
      step('s2', 'B', { status: 'success' }),
    ];
    const next = [step('s1', 'A'), step('s2', 'B')];
    await preservePriorSuccesses(prior, next, noisyMatcher);
    expect(matcherCalls).toBe(0);
  });

  it('a prior success can only bind to one new step (no double-preservation)', async () => {
    const prior = [step('old', 'only one', { status: 'success', observation: 'obs' })];
    const next = [step('new1', 'step one'), step('new2', 'step two')];
    const preserved = await preservePriorSuccesses(prior, next, alwaysMatchFirst);
    // Either new1 or new2 gets preserved (matcher always returns the first
    // remaining candidate — which for the 2nd call is empty), but not both.
    expect(preserved).toHaveLength(1);
    const successCount = next.filter((s) => s.status === 'success').length;
    expect(successCount).toBe(1);
  });

  it('only prior success steps are eligible (pending/failed ignored)', async () => {
    const prior = [
      step('s1', 'done', { status: 'success' }),
      step('s2', 'failed', { status: 'failed' }),
      step('s3', 'pending', { status: 'pending' }),
    ];
    const next = [step('new', 'whatever')];
    const preserved = await preservePriorSuccesses(prior, next, alwaysMatchFirst);
    // Matcher sees only s1. With alwaysMatchFirst that's preserved.
    expect(preserved).toEqual(['new']);
  });
});

describe('PlanExecuteExecutor — semantic preservation on replan', () => {
  it('same intent different id is preserved when stepMatcher is wired', async () => {
    // Initial plan succeeds on "cheap"; second step "flaky" fails and triggers
    // a replan. The replan emits a **new id** for the already-succeeded step —
    // exact-id preservation would miss it, but the semantic matcher binds it.
    const initialPlan = JSON.stringify({
      rationale: 'two steps',
      steps: [
        { id: 'cheap-1', goal: 'gather the files', tool: 'cheap', args: {}, dependsOn: [] },
        { id: 'flaky-1', goal: 'transform them', tool: 'flaky', args: {}, dependsOn: ['cheap-1'] },
      ],
    });
    const replanPlan = JSON.stringify({
      rationale: 'reworded',
      steps: [
        // Same semantic goal, fresh id.
        { id: 'g-renamed', goal: 'gather the files', tool: 'cheap', args: {}, dependsOn: [] },
        { id: 't-alt', goal: 'transform them', tool: 'works', args: {}, dependsOn: ['g-renamed'] },
      ],
    });
    const model = new ScriptedAdapter([initialPlan, replanPlan, '완료']);

    const calls: string[] = [];
    const sandbox: Contracts.ToolSandbox = {
      async acquire() {
        return { id: 'sb', status: 'ready', startedAt: nowMs(), resourceUsage: { cpuSeconds: 0, memoryMb: 0, diskMb: 0 } };
      },
      async execute(_sb, name) {
        calls.push(name);
        if (name === 'cheap') return { toolName: name, success: true, output: 'cheap-ok', durationMs: 1 };
        if (name === 'flaky') return { toolName: name, success: false, error: 'boom', durationMs: 1 };
        if (name === 'works') return { toolName: name, success: true, output: 'works-ok', durationMs: 1 };
        return { toolName: name, success: false, error: 'unknown', durationMs: 0 };
      },
      async release() {},
    };

    // Matcher binds by shared goal prefix — 'gather' maps across old/new id.
    const matcher: StepMatcher = {
      async match(q, cands) {
        const hit = cands.find((c) => c.goal === q);
        return hit ? hit.id : null;
      },
    };

    const reactFallback = new ReactExecutor(model);
    const ex = new PlanExecuteExecutor(
      model,
      reactFallback,
      {
        capabilityGuard: alwaysAllow,
        toolSandbox: sandbox,
        sessionPolicy: ownerPolicy,
        stepMatcher: matcher,
      },
      { stepRetryLimit: 1, replanLimit: 2 },
    );
    const events = await collect(ex.run(makeCtx()));

    // 'cheap' should run ONCE (initial plan) — renamed step in the replan
    // must inherit status='success' via the matcher, so no second 'cheap'.
    const cheapCalls = calls.filter((c) => c === 'cheap').length;
    expect(cheapCalls).toBe(1);
    // 'flaky' fires twice (initial + 1 retry), then 'works' runs in the new plan.
    expect(calls).toEqual(['cheap', 'flaky', 'flaky', 'works']);

    // The replan marker should list 'g-renamed' as preserved.
    const replanMarker = events.find(
      (e) => e.kind === 'step' && (e as { step: { kind: string } }).step.kind === 'replan',
    ) as { step: { content: { preservedStepIds?: string[] } } };
    expect(replanMarker.step.content.preservedStepIds).toEqual(['g-renamed']);
  });

  it('no matcher → renamed step IS re-executed (behavior unchanged for pre-v0.7 callers)', async () => {
    const initialPlan = JSON.stringify({
      rationale: 'two steps',
      steps: [
        { id: 'cheap-1', goal: 'gather', tool: 'cheap', args: {}, dependsOn: [] },
        { id: 'flaky-1', goal: 'xf', tool: 'flaky', args: {}, dependsOn: ['cheap-1'] },
      ],
    });
    const replanPlan = JSON.stringify({
      rationale: 'reworded',
      steps: [
        { id: 'g-renamed', goal: 'gather', tool: 'cheap', args: {}, dependsOn: [] },
        { id: 't-alt', goal: 'xf', tool: 'works', args: {}, dependsOn: ['g-renamed'] },
      ],
    });
    const model = new ScriptedAdapter([initialPlan, replanPlan, '완료']);
    const calls: string[] = [];
    const sandbox: Contracts.ToolSandbox = {
      async acquire() {
        return { id: 'sb', status: 'ready', startedAt: nowMs(), resourceUsage: { cpuSeconds: 0, memoryMb: 0, diskMb: 0 } };
      },
      async execute(_sb, name) {
        calls.push(name);
        if (name === 'cheap') return { toolName: name, success: true, output: 'ok', durationMs: 1 };
        if (name === 'flaky') return { toolName: name, success: false, error: 'x', durationMs: 1 };
        if (name === 'works') return { toolName: name, success: true, output: 'ok', durationMs: 1 };
        return { toolName: name, success: false, error: 'x', durationMs: 0 };
      },
      async release() {},
    };
    const reactFallback = new ReactExecutor(model);
    const ex = new PlanExecuteExecutor(
      model,
      reactFallback,
      { capabilityGuard: alwaysAllow, toolSandbox: sandbox, sessionPolicy: ownerPolicy },
      { stepRetryLimit: 1, replanLimit: 2 },
    );
    await collect(ex.run(makeCtx()));
    // Without a matcher, 'cheap' re-executes after replan since id changed.
    expect(calls.filter((c) => c === 'cheap').length).toBe(2);
  });
});
