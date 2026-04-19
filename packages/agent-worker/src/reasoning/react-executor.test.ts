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

async function collect(iter: AsyncIterable<Contracts.ReasoningEvent>): Promise<Contracts.ReasoningEvent[]> {
  const out: Contracts.ReasoningEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe('ReactExecutor', () => {
  it('text-only path (no tools): yields deltas, usage, and a final event with final_answer', async () => {
    const model = new TextOnlyAdapter(['hel', 'lo']);
    const ex = new ReactExecutor(model);
    const events = await collect(ex.run(makeCtx()));

    const deltas = events.filter((e) => e.kind === 'delta').map((e) => (e as { text: string }).text);
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
    const final = events.find((e) => e.kind === 'final') as { text: string; state: { trace: { kind: string }[] } };
    expect(final.text).toBe('done.');
    const kinds = final.state.trace.map((s) => s.kind);
    expect(kinds).toContain('tool_call');
    expect(kinds).toContain('observation');
    expect(kinds).toContain('final');
  });

  it('enforces maxToolCalls budget by setting terminationReason to tool_exhaustion', async () => {
    const guard: Contracts.CapabilityGuard = { async check() { return { allowed: true }; } };
    const sandbox: Contracts.ToolSandbox = {
      async acquire() {
        return { id: 'sb-1', status: 'ready', startedAt: nowMs(), resourceUsage: { cpuSeconds: 0, memoryMb: 0, diskMb: 0 } };
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
    const final = events.find((e) => e.kind === 'final') as { state: { terminationReason: string } };
    expect(final.state.terminationReason).toBe('tool_exhaustion');
  });

  it('returns user_abort termination when AbortSignal is set', async () => {
    const ac = new AbortController();
    ac.abort();
    const model = new TextOnlyAdapter(['never seen']);
    const ex = new ReactExecutor(model);
    const events = await collect(ex.run(makeCtx({ abortSignal: ac.signal })));
    const final = events.find((e) => e.kind === 'final') as { state: { terminationReason: string } };
    expect(final.state.terminationReason).toBe('user_abort');
  });
});
