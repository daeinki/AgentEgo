import { describe, it, expect } from 'vitest';
import type { Contracts, StandardMessage, SessionPolicy } from '@agent-platform/core';
import { generateMessageId, generateTraceId, nowMs } from '@agent-platform/core';
import type { CompletionRequest, ModelAdapter, StreamChunk } from '../model/types.js';
import { HybridReasoner } from './hybrid-reasoner.js';

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
    yield { type: 'usage', inputTokens: 3, outputTokens: 3 };
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

const allowAll: Contracts.CapabilityGuard = { async check() { return { allowed: true }; } };

const mkSandbox = (log: string[]): Contracts.ToolSandbox => ({
  async acquire() {
    return { id: 'sb', status: 'ready', startedAt: nowMs(), resourceUsage: { cpuSeconds: 0, memoryMb: 0, diskMb: 0 } };
  },
  async execute(_sb, name, args) {
    log.push(`${name}:${JSON.stringify(args)}`);
    return { toolName: name, success: true, output: 'ok', durationMs: 1 };
  },
  async release() {},
});

function ctxWith(tools: Contracts.ToolDescriptor[], text: string): Contracts.ReasoningContext {
  return {
    sessionId: 's-1',
    agentId: 'a-1',
    userMessage: makeMsg(text),
    systemPrompt: 'sys',
    priorMessages: [],
    availableTools: tools,
    egoDecisionId: null,
  };
}

async function collect(iter: AsyncIterable<Contracts.ReasoningEvent>): Promise<Contracts.ReasoningEvent[]> {
  const out: Contracts.ReasoningEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe('HybridReasoner', () => {
  it('routes simple prompt to ReAct (final_answer, no plan)', async () => {
    const model = new ScriptedAdapter(['답변']);
    const reasoner = new HybridReasoner(model);
    const events = await collect(reasoner.run(ctxWith([], '지금 몇 시야?')));
    const final = events.find((e) => e.kind === 'final') as { state: { mode: string; plan?: unknown } };
    expect(final.state.mode).toBe('react');
    expect(final.state.plan).toBeUndefined();
  });

  it('without tool deps: plan-execute path is disabled, everything goes to ReAct', async () => {
    const model = new ScriptedAdapter(['직접 답변']);
    const reasoner = new HybridReasoner(model); // no deps
    const events = await collect(
      reasoner.run(
        ctxWith(
          [
            { name: 'a', description: '', inputSchema: {} },
            { name: 'b', description: '', inputSchema: {} },
            { name: 'c', description: '', inputSchema: {} },
          ],
          '파일 읽고 요약해. 그리고 저장해.',
        ),
      ),
    );
    const final = events.find((e) => e.kind === 'final') as { state: { mode: string } };
    expect(final.state.mode).toBe('react');
  });

  it('with tool deps: multi-step prompt routes to plan-execute', async () => {
    const planJson = JSON.stringify({
      rationale: 'two tools',
      steps: [
        { id: 's1', goal: 'read', tool: 'a', args: {}, dependsOn: [] },
        { id: 's2', goal: 'save', tool: 'b', args: {}, dependsOn: ['s1'] },
      ],
    });
    const model = new ScriptedAdapter([planJson, '완료']);
    const execLog: string[] = [];
    const reasoner = new HybridReasoner(model, {
      capabilityGuard: allowAll,
      toolSandbox: mkSandbox(execLog),
      sessionPolicy: ownerPolicy,
    });
    const tools = [
      { name: 'a', description: 'a', inputSchema: {} },
      { name: 'b', description: 'b', inputSchema: {} },
      { name: 'c', description: 'c', inputSchema: {} },
    ];
    const events = await collect(
      reasoner.run(ctxWith(tools, '파일 읽고 요약해. 그리고 CSV 저장해.')),
    );
    expect(execLog).toEqual(['a:{}', 'b:{}']);
    const final = events.find((e) => e.kind === 'final') as { text: string; state: { mode: string; plan?: unknown } };
    expect(final.state.mode).toBe('plan_execute');
    expect(final.state.plan).toBeDefined();
    expect(final.text).toBe('완료');
  });

  it('forwards ctx.egoPerception into ComplexityRouter input', async () => {
    const captured: Contracts.ComplexityRouterInput[] = [];
    const stubRouter: Contracts.ComplexityRouter = {
      select(input) {
        captured.push(input);
        return 'react';
      },
    };
    const model = new ScriptedAdapter(['ok']);
    const reasoner = new HybridReasoner(model, {}, {}, stubRouter);
    const ctx: Contracts.ReasoningContext = {
      sessionId: 's-1',
      agentId: 'a-1',
      userMessage: makeMsg('hi'),
      systemPrompt: 'sys',
      priorMessages: [],
      availableTools: [{ name: 't', description: 't', inputSchema: {} }],
      egoDecisionId: 'ego-x',
      egoPerception: {
        requestType: 'workflow_execution',
        patterns: ['plan'],
        isFollowUp: false,
        requiresToolUse: true,
        estimatedComplexity: 'high',
      },
    };
    await collect(reasoner.run(ctx));
    expect(captured).toHaveLength(1);
    expect(captured[0]?.egoPerception?.estimatedComplexity).toBe('high');
    expect(captured[0]?.egoPerception?.requestType).toBe('workflow_execution');
  });

  it('disablePlanExecute flag forces ReAct even when tool deps are wired', async () => {
    const model = new ScriptedAdapter(['직접 답변']);
    const reasoner = new HybridReasoner(
      model,
      { capabilityGuard: allowAll, toolSandbox: mkSandbox([]), sessionPolicy: ownerPolicy },
      { disablePlanExecute: true },
    );
    const tools = [
      { name: 'a', description: 'a', inputSchema: {} },
      { name: 'b', description: 'b', inputSchema: {} },
      { name: 'c', description: 'c', inputSchema: {} },
    ];
    const events = await collect(
      reasoner.run(ctxWith(tools, '파일 읽고 요약해. 그리고 저장해.')),
    );
    const final = events.find((e) => e.kind === 'final') as { state: { mode: string } };
    expect(final.state.mode).toBe('react');
  });
});
