import { describe, it, expect } from 'vitest';
import type { Contracts, StandardMessage } from '@agent-platform/core';
import { generateMessageId, generateTraceId, nowMs } from '@agent-platform/core';
import type { CompletionRequest, ModelAdapter, StreamChunk } from '../model/types.js';
import { ReactExecutor } from './react-executor.js';

function makeMsg(text: string): StandardMessage {
  return {
    id: generateMessageId(),
    traceId: generateTraceId(),
    timestamp: nowMs(),
    channel: { type: 'webchat', id: 'w-1', metadata: {} },
    sender: { id: 'user-1', isOwner: true },
    conversation: { type: 'dm', id: 'c-1' },
    content: { type: 'text', text },
  };
}

class TextOnlyAdapter implements ModelAdapter {
  public lastRequest: CompletionRequest | undefined;
  constructor(private readonly chunks: string[]) {}
  async *stream(req: CompletionRequest): AsyncIterable<StreamChunk> {
    this.lastRequest = req;
    for (const t of this.chunks) yield { type: 'text_delta', text: t };
    yield { type: 'usage', inputTokens: 3, outputTokens: 2 };
    yield { type: 'done', stopReason: 'end_turn' };
  }
  getModelInfo() {
    return { provider: 'mock', model: 'mock' };
  }
}

// Adapter that on the first call asks for a tool, on the second call gives a
// final answer. Used to exercise the ReAct loop.
class ToolThenFinalAdapter implements ModelAdapter {
  private call = 0;
  async *stream(_req: CompletionRequest): AsyncIterable<StreamChunk> {
    this.call += 1;
    if (this.call === 1) {
      yield { type: 'tool_call_start', id: 'tc-1', name: 'echo' };
      yield { type: 'tool_call_delta', id: 'tc-1', args: '{"x":1}' };
      yield { type: 'tool_call_end', id: 'tc-1' };
      yield { type: 'done', stopReason: 'tool_use' };
      return;
    }
    yield { type: 'text_delta', text: 'done.' };
    yield { type: 'done', stopReason: 'end_turn' };
  }
  getModelInfo() {
    return { provider: 'mock', model: 'mock' };
  }
}

// Adapter that keeps asking for tools forever — used to hit budget caps.
class InfiniteToolAdapter implements ModelAdapter {
  async *stream(_req: CompletionRequest): AsyncIterable<StreamChunk> {
    yield { type: 'tool_call_start', id: `tc-${Math.random()}`, name: 'spin' };
    yield { type: 'tool_call_delta', id: 'unused', args: '{}' };
    yield { type: 'tool_call_end', id: 'unused' };
    yield { type: 'done', stopReason: 'tool_use' };
  }
  getModelInfo() {
    return { provider: 'mock', model: 'mock' };
  }
}

// Adapter that asks for tools while it has any in the request, but if it
// receives a request with no tools (the synthesis follow-up call) it answers
// with text. Used to verify the P0 synthesis fallback fires after budget
// exhaustion and feeds its result into the final event.
class ToolThenSynthAdapter implements ModelAdapter {
  public synthSystemPromptSeen?: string;
  async *stream(req: CompletionRequest): AsyncIterable<StreamChunk> {
    if (!req.tools || req.tools.length === 0) {
      this.synthSystemPromptSeen = req.systemPrompt;
      yield { type: 'text_delta', text: '도구 결과 요약: 답변' };
      yield { type: 'usage', inputTokens: 5, outputTokens: 4 };
      yield { type: 'done', stopReason: 'end_turn' };
      return;
    }
    yield { type: 'tool_call_start', id: 'tc-x', name: 'spin' };
    yield { type: 'tool_call_delta', id: 'tc-x', args: '{}' };
    yield { type: 'tool_call_end', id: 'tc-x' };
    yield { type: 'done', stopReason: 'tool_use' };
  }
  getModelInfo() {
    return { provider: 'mock', model: 'mock' };
  }
}

function makeCtx(overrides: Partial<Contracts.ReasoningContext> = {}): Contracts.ReasoningContext {
  return {
    sessionId: 's-1',
    agentId: 'a-1',
    userMessage: makeMsg('hi'),
    systemPrompt: 'sys',
    priorMessages: [],
    availableTools: [],
    egoDecisionId: null,
    ...overrides,
  };
}

async function collect(
  iter: AsyncIterable<Contracts.ReasoningEvent>,
): Promise<Contracts.ReasoningEvent[]> {
  const out: Contracts.ReasoningEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe('ReactExecutor', () => {
  it('text-only path (no tools): yields deltas, usage, and a final event with final_answer', async () => {
    const model = new TextOnlyAdapter(['hel', 'lo']);
    const ex = new ReactExecutor(model);
    const events = await collect(ex.run(makeCtx()));

    const deltas = events
      .filter((e) => e.kind === 'delta')
      .map((e) => (e as { text: string }).text);
    expect(deltas.join('')).toBe('hello');

    const usage = events.find((e) => e.kind === 'usage');
    expect(usage).toBeDefined();

    const final = events.find((e) => e.kind === 'final');
    expect(final).toBeDefined();
    const state = (final as { state: { terminationReason: string; trace: unknown[] } }).state;
    expect(state.terminationReason).toBe('final_answer');
    expect((final as { text: string }).text).toBe('hello');
  });

  it('does NOT pass tools to the model when availableTools is empty', async () => {
    const model = new TextOnlyAdapter(['ok']);
    const ex = new ReactExecutor(model);
    await collect(ex.run(makeCtx()));
    expect(model.lastRequest?.tools).toBeUndefined();
  });

  it('tool-use loop: executes tool via sandbox, feeds observation back, final answer on next turn', async () => {
    const calls: string[] = [];
    const guard: Contracts.CapabilityGuard = {
      async check() {
        return { allowed: true };
      },
    };
    const sandbox: Contracts.ToolSandbox = {
      async acquire() {
        return {
          id: 'sb-1',
          status: 'ready',
          startedAt: nowMs(),
          resourceUsage: { cpuSeconds: 0, memoryMb: 0, diskMb: 0 },
        };
      },
      async execute(_sb, name, args) {
        calls.push(`${name}:${JSON.stringify(args)}`);
        return { toolName: name, success: true, output: 'ECHO(1)', durationMs: 1 };
      },
      async release() {},
    };
    const model = new ToolThenFinalAdapter();
    const ex = new ReactExecutor(model, {
      capabilityGuard: guard,
      toolSandbox: sandbox,
      sessionPolicy: {
        sessionId: 's-1',
        trustLevel: 'owner',
        grantedCapabilities: [],
        deniedCapabilities: [],
        sandboxMode: 'never',
        resourceLimits: { maxCpuSeconds: 1, maxMemoryMb: 1, maxDiskMb: 1, networkEnabled: false },
      },
    });
    const events = await collect(
      ex.run(
        makeCtx({
          availableTools: [{ name: 'echo', description: 'echo', inputSchema: {} }],
        }),
      ),
    );

    expect(calls).toEqual(['echo:{"x":1}']);
    const final = events.find((e) => e.kind === 'final') as {
      text: string;
      state: { trace: { kind: string }[] };
    };
    expect(final.text).toBe('done.');
    const kinds = final.state.trace.map((s) => s.kind);
    expect(kinds).toContain('tool_call');
    expect(kinds).toContain('observation');
    expect(kinds).toContain('final');
  });

  it('enforces maxToolCalls budget by setting terminationReason to tool_exhaustion', async () => {
    const guard: Contracts.CapabilityGuard = {
      async check() {
        return { allowed: true };
      },
    };
    const sandbox: Contracts.ToolSandbox = {
      async acquire() {
        return {
          id: 'sb-1',
          status: 'ready',
          startedAt: nowMs(),
          resourceUsage: { cpuSeconds: 0, memoryMb: 0, diskMb: 0 },
        };
      },
      async execute(_sb, name) {
        return { toolName: name, success: true, output: 'ok', durationMs: 1 };
      },
      async release() {},
    };
    const model = new InfiniteToolAdapter();
    const ex = new ReactExecutor(
      model,
      {
        capabilityGuard: guard,
        toolSandbox: sandbox,
        sessionPolicy: {
          sessionId: 's',
          trustLevel: 'owner',
          grantedCapabilities: [],
          deniedCapabilities: [],
          sandboxMode: 'never',
          resourceLimits: { maxCpuSeconds: 1, maxMemoryMb: 1, maxDiskMb: 1, networkEnabled: false },
        },
      },
      { maxSteps: 10, maxToolCalls: 2 },
    );
    const events = await collect(
      ex.run(
        makeCtx({
          availableTools: [{ name: 'spin', description: 'spin', inputSchema: {} }],
        }),
      ),
    );
    const final = events.find((e) => e.kind === 'final') as {
      state: { terminationReason: string };
    };
    expect(final.state.terminationReason).toBe('tool_exhaustion');
  });

  it('synthesizes a final answer when budget exhausts mid-tool-loop (P0)', async () => {
    const guard: Contracts.CapabilityGuard = {
      async check() {
        return { allowed: true };
      },
    };
    const sandbox: Contracts.ToolSandbox = {
      async acquire() {
        return {
          id: 'sb',
          status: 'ready',
          startedAt: nowMs(),
          resourceUsage: { cpuSeconds: 0, memoryMb: 0, diskMb: 0 },
        };
      },
      async execute(_sb, name) {
        return { toolName: name, success: true, output: 'observation-payload', durationMs: 1 };
      },
      async release() {},
    };
    const model = new ToolThenSynthAdapter();
    const ex = new ReactExecutor(
      model,
      {
        capabilityGuard: guard,
        toolSandbox: sandbox,
        sessionPolicy: {
          sessionId: 's',
          trustLevel: 'owner',
          grantedCapabilities: [],
          deniedCapabilities: [],
          sandboxMode: 'never',
          resourceLimits: { maxCpuSeconds: 1, maxMemoryMb: 1, maxDiskMb: 1, networkEnabled: false },
        },
      },
      { maxSteps: 2, maxToolCalls: 5 },
    );
    const events = await collect(
      ex.run(
        makeCtx({
          availableTools: [{ name: 'spin', description: 'spin', inputSchema: {} }],
        }),
      ),
    );
    const final = events.find((e) => e.kind === 'final') as {
      text: string;
      state: { terminationReason: string; trace: { kind: string; content: unknown }[] };
    };
    // The reasoner ran out of step budget but we synthesized something.
    expect(final.state.terminationReason).toBe('max_steps');
    expect(final.text).toBe('도구 결과 요약: 답변');
    // Synthesis prompt must include the collected trace observations so the
    // model can answer from them.
    expect(model.synthSystemPromptSeen).toContain('observation-payload');
    expect(model.synthSystemPromptSeen).toContain('max_steps');
    // The synthesized step is recorded so audit/state stays coherent.
    const finals = final.state.trace.filter((s) => s.kind === 'final');
    expect(finals.length).toBeGreaterThan(0);
    const last = finals[finals.length - 1]!.content as { synthesized?: boolean };
    expect(last.synthesized).toBe(true);
  });

  it('returns user_abort termination when AbortSignal is set', async () => {
    const ac = new AbortController();
    ac.abort();
    const model = new TextOnlyAdapter(['never seen']);
    const ex = new ReactExecutor(model);
    const events = await collect(ex.run(makeCtx({ abortSignal: ac.signal })));
    const final = events.find((e) => e.kind === 'final') as {
      state: { terminationReason: string };
    };
    expect(final.state.terminationReason).toBe('user_abort');
  });

  it('mid-turn tool registration: liveTools() refresh exposes a new tool to the next step', async () => {
    // Simulates the same-turn skill.create flow:
    //   Step 1 — model calls 'register_new'. Tool execution mutates the live
    //            registry (this is what skill.create's remount does in prod).
    //   Step 2 — model calls 'fresh_tool' which only just appeared. ReactExecutor
    //            must have re-snapshotted ctx.liveTools() before sending the
    //            request, otherwise the LLM would see no such tool.
    const liveMap = new Map<string, Contracts.ToolDescriptor>([
      ['register_new', { name: 'register_new', description: 'reg', inputSchema: {} }],
    ]);

    const requestsSent: Array<string[]> = [];
    let call = 0;
    const model: ModelAdapter = {
      async *stream(req: CompletionRequest): AsyncIterable<StreamChunk> {
        requestsSent.push((req.tools ?? []).map((t) => t.name));
        call += 1;
        if (call === 1) {
          yield { type: 'tool_call_start', id: 'tc-1', name: 'register_new' };
          yield { type: 'tool_call_delta', id: 'tc-1', args: '{}' };
          yield { type: 'tool_call_end', id: 'tc-1' };
          yield { type: 'done', stopReason: 'tool_use' };
          return;
        }
        if (call === 2) {
          yield { type: 'tool_call_start', id: 'tc-2', name: 'fresh_tool' };
          yield { type: 'tool_call_delta', id: 'tc-2', args: '{"y":2}' };
          yield { type: 'tool_call_end', id: 'tc-2' };
          yield { type: 'done', stopReason: 'tool_use' };
          return;
        }
        yield { type: 'text_delta', text: 'all good.' };
        yield { type: 'done', stopReason: 'end_turn' };
      },
      getModelInfo: () => ({ provider: 'mock', model: 'mock' }),
    };

    const guard: Contracts.CapabilityGuard = {
      async check() {
        return { allowed: true };
      },
    };
    const calls: string[] = [];
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
        calls.push(`${name}:${JSON.stringify(args)}`);
        if (name === 'register_new') {
          // Simulate skill.create's remount → registry gains a new tool.
          liveMap.set('fresh_tool', {
            name: 'fresh_tool',
            description: 'mid-turn skill',
            inputSchema: {},
          });
          return {
            toolName: name,
            success: true,
            output: '{"mountedNow":true}',
            durationMs: 1,
          };
        }
        return { toolName: name, success: true, output: 'ok', durationMs: 1 };
      },
      async release() {},
    };

    const ex = new ReactExecutor(model, {
      capabilityGuard: guard,
      toolSandbox: sandbox,
      sessionPolicy: {
        sessionId: 's-1',
        trustLevel: 'owner',
        grantedCapabilities: [],
        deniedCapabilities: [],
        sandboxMode: 'never',
        resourceLimits: { maxCpuSeconds: 1, maxMemoryMb: 1, maxDiskMb: 1, networkEnabled: false },
      },
    });
    await collect(
      ex.run(
        makeCtx({
          availableTools: [...liveMap.values()],
          liveTools: () => [...liveMap.values()],
        }),
      ),
    );

    // Step 1 sees only the original tool.
    expect(requestsSent[0]).toEqual(['register_new']);
    // Step 2 sees the freshly-registered tool — proof that liveTools() was
    // re-evaluated AFTER step 1's tool execution mutated the registry.
    expect(requestsSent[1]).toEqual(expect.arrayContaining(['register_new', 'fresh_tool']));
    // The 'fresh_tool' was actually invocable in step 2.
    expect(calls.some((c) => c.startsWith('fresh_tool:'))).toBe(true);
  });
});
