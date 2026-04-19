import { describe, it, expect } from 'vitest';
import type { Contracts, StandardMessage, SessionPolicy } from '@agent-platform/core';
import { generateMessageId, generateTraceId, nowMs } from '@agent-platform/core';
import type { CompletionRequest, ModelAdapter, StreamChunk } from '../model/types.js';
import { DefaultComplexityRouter } from './complexity-router.js';
import { ReactExecutor } from './react-executor.js';
import { PlanExecuteExecutor } from './plan-execute-executor.js';

/**
 * End-to-end scenario (agent-orchestration.md §7.2):
 *   user prompt → ComplexityRouter → PlanExecuteExecutor → tool steps → final answer
 *
 * Exercises the full Phase U2-U4 pipeline without a real LLM or tool daemon.
 */

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
    yield { type: 'usage', inputTokens: 8, outputTokens: 8 };
    yield { type: 'done', stopReason: 'end_turn' };
  }
  getModelInfo() {
    return { provider: 'mock', model: 'mock' };
  }
}

const ownerPolicy: SessionPolicy = {
  sessionId: 's-e2e',
  trustLevel: 'owner',
  grantedCapabilities: [],
  deniedCapabilities: [],
  sandboxMode: 'never',
  resourceLimits: { maxCpuSeconds: 1, maxMemoryMb: 1, maxDiskMb: 1, networkEnabled: false },
};

const allowAll: Contracts.CapabilityGuard = { async check() { return { allowed: true }; } };

describe('reasoning pipeline e2e — router → plan-execute → final', () => {
  it('routes a multi-step prompt to plan_execute and executes the plan end-to-end', async () => {
    const toolLog: string[] = [];
    const sandbox: Contracts.ToolSandbox = {
      async acquire() {
        return {
          id: 'sb',
          status: 'ready',
          startedAt: nowMs(),
          resourceUsage: { cpuSeconds: 0, memoryMb: 0, diskMb: 0 },
        };
      },
      async execute(_sb, name, args) {
        toolLog.push(`${name}:${JSON.stringify(args)}`);
        if (name === 'glob_files') {
          return { toolName: name, success: true, output: 'a.md\nb.md\nc.md', durationMs: 1 };
        }
        if (name === 'read_file') {
          return { toolName: name, success: true, output: '# Heading\ncontent', durationMs: 1 };
        }
        if (name === 'extract_headings') {
          return { toolName: name, success: true, output: '["# Heading"]', durationMs: 1 };
        }
        return { toolName: name, success: false, error: 'unknown', durationMs: 0 };
      },
      async release() {},
    };

    // The planner must return valid JSON; the final-synth call must return the
    // user-facing text.
    const planJson = JSON.stringify({
      rationale: 'three tools in order',
      steps: [
        { id: 's1', goal: 'list markdown files', tool: 'glob_files', args: { pattern: '*.md' }, dependsOn: [] },
        { id: 's2', goal: 'read them', tool: 'read_file', args: {}, dependsOn: ['s1'] },
        { id: 's3', goal: 'pull headings', tool: 'extract_headings', args: {}, dependsOn: ['s2'] },
      ],
    });
    const model = new ScriptedAdapter([planJson, '완료: 3개 파일의 제목을 추출했습니다.']);

    const tools: Contracts.ToolDescriptor[] = [
      { name: 'glob_files', description: 'glob', inputSchema: {} },
      { name: 'read_file', description: 'read', inputSchema: {} },
      { name: 'extract_headings', description: 'headings', inputSchema: {} },
    ];

    const router = new DefaultComplexityRouter();
    const mode = router.select({
      userMessage: makeMsg('이 폴더의 모든 .md 파일을 읽고 섹션 제목만 추출해줘'),
      availableTools: tools,
      egoPerception: {
        requestType: 'workflow_execution',
        patterns: [],
        isFollowUp: false,
        requiresToolUse: true,
        estimatedComplexity: 'medium',
      },
    });
    expect(mode).toBe('plan_execute');

    const reactFallback = new ReactExecutor(model);
    const planExecutor = new PlanExecuteExecutor(
      model,
      reactFallback,
      { capabilityGuard: allowAll, toolSandbox: sandbox, sessionPolicy: ownerPolicy },
    );

    const ctx: Contracts.ReasoningContext = {
      sessionId: 's-e2e',
      agentId: 'a-1',
      userMessage: makeMsg('이 폴더의 모든 .md 파일을 읽고 섹션 제목만 추출해줘'),
      systemPrompt: '너는 유용한 도우미야.',
      priorMessages: [],
      availableTools: tools,
      egoDecisionId: 'ego-e2e-1',
    };

    const events: Contracts.ReasoningEvent[] = [];
    for await (const ev of planExecutor.run(ctx)) events.push(ev);

    // Assertion 1: every planned tool was invoked in order
    expect(toolLog).toEqual([
      'glob_files:{"pattern":"*.md"}',
      'read_file:{}',
      'extract_headings:{}',
    ]);

    // Assertion 2: plan was persisted in the final state
    const final = events.find((e) => e.kind === 'final') as {
      text: string;
      state: { terminationReason: string; plan?: { steps: { id: string; status: string }[] } };
    };
    expect(final).toBeDefined();
    expect(final.state.terminationReason).toBe('final_answer');
    expect(final.state.plan?.steps.map((s) => s.status)).toEqual(['success', 'success', 'success']);

    // Assertion 3: user-facing text comes from the synth call
    expect(final.text).toBe('완료: 3개 파일의 제목을 추출했습니다.');

    // Assertion 4: step_progress events were emitted for each step
    const progressByStep = new Map<string, string[]>();
    for (const ev of events) {
      if (ev.kind === 'step_progress') {
        const list = progressByStep.get(ev.stepId) ?? [];
        list.push(ev.status);
        progressByStep.set(ev.stepId, list);
      }
    }
    expect(progressByStep.size).toBe(3);
    for (const [, statuses] of progressByStep) {
      expect(statuses).toContain('running');
      expect(statuses).toContain('success');
    }

    // Assertion 5: egoDecisionId is carried through to final state
    expect(final.state).toMatchObject({ egoDecisionId: 'ego-e2e-1' });
  });

  it('low-complexity prompt routes to react and produces a single-call answer', async () => {
    const model = new ScriptedAdapter(['지금은 오후 3시입니다.']);
    const router = new DefaultComplexityRouter();
    const mode = router.select({
      userMessage: makeMsg('지금 몇 시야?'),
      availableTools: [
        { name: 'get_time', description: 't', inputSchema: {} },
        { name: 'misc', description: 'm', inputSchema: {} },
      ],
      egoPerception: {
        requestType: 'direct_answer',
        patterns: [],
        isFollowUp: false,
        requiresToolUse: false,
        estimatedComplexity: 'low',
      },
    });
    expect(mode).toBe('react');

    const exec = new ReactExecutor(model);
    const events: Contracts.ReasoningEvent[] = [];
    for await (const ev of exec.run({
      sessionId: 's-low',
      agentId: 'a-1',
      userMessage: makeMsg('지금 몇 시야?'),
      systemPrompt: 'sys',
      priorMessages: [],
      availableTools: [],
      egoDecisionId: null,
    })) {
      events.push(ev);
    }
    const final = events.find((e) => e.kind === 'final') as { text: string; state: { terminationReason: string } };
    expect(final.text).toBe('지금은 오후 3시입니다.');
    expect(final.state.terminationReason).toBe('final_answer');
  });
});
