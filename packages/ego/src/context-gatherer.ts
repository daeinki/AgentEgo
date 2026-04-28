import type {
  Contracts,
  EgoFullConfig,
  Goal,
  MemorySearchResult,
  MessageSummary,
  SearchContext,
} from '@agent-platform/core';
import { withTimeout } from '@agent-platform/core';
import type { NormalizedSignal } from './normalize.js';

type MemorySystem = Contracts.MemorySystem;
type GoalStore = Contracts.GoalStore;
type AuditLog = Contracts.AuditLog;
type TraceLogger = Contracts.TraceLogger;

export interface EgoGatheredContext {
  memories: MemorySearchResult[];
  activeGoals: Goal[];
  recentHistory: MessageSummary[];
  memoryTimedOut: boolean;
}

export interface GatherParams {
  signal: NormalizedSignal;
  sessionId: string;
  agentId: string;
  config: EgoFullConfig;
  memory?: MemorySystem;
  goals?: GoalStore;
  recentHistory?: MessageSummary[];
  memoryCache?: Map<string, MemorySearchResult[]>;
  audit?: AuditLog;
  traceId: string;
  /**
   * Optional trace logger. When wired, the EGO memory search emits an `X1`
   * `memory_searched` event so the search internals are visible in
   * `agent trace show` (otherwise the EGO context lookup is invisible).
   */
  traceLogger?: TraceLogger;
}

/**
 * Gather memory + goals + recent history in parallel. Memory search obeys the
 * ego.json `memory.onTimeout` contract (§5.8):
 *
 * - empty_result: on timeout, return [] and record audit
 * - cached: fall back to the most recent good result for this query, else []
 * - abort: let the timeout error propagate (caller decides)
 */
export async function gatherContext(params: GatherParams): Promise<EgoGatheredContext> {
  const { signal, sessionId, agentId, config, memory, goals, memoryCache, audit, traceId } = params;

  const recentHistory = params.recentHistory ?? [];
  let memoryTimedOut = false;

  const memoryPromise: Promise<MemorySearchResult[]> = (async () => {
    if (!memory || !config.memory.searchOnCognize) return [];
    const ctx: SearchContext = {
      sessionId,
      agentId,
      recentTopics: signal.entities.map((e) => e.value),
      maxResults: config.memory.maxSearchResults,
      minRelevanceScore: 0.1,
    };
    const query = signal.rawText;
    try {
      const traceCtx = params.traceLogger
        ? { traceLogger: params.traceLogger, traceId, sessionId, agentId }
        : undefined;
      const results = await withTimeout(
        memory.search(query, ctx, traceCtx),
        config.memory.searchTimeoutMs,
        'memory.search',
      );
      memoryCache?.set(query, results);
      return results;
    } catch (err) {
      memoryTimedOut = true;
      await audit?.record({
        timestamp: Date.now(),
        traceId,
        tag: 'memory_timeout',
        actor: 'ego',
        action: 'memory.search',
        result: 'error',
        riskLevel: 'low',
        sessionId,
        agentId,
        parameters: { error: String(err), mode: config.memory.onTimeout },
      });
      switch (config.memory.onTimeout) {
        case 'empty_result':
          return [];
        case 'cached':
          return memoryCache?.get(query) ?? [];
        case 'abort':
          throw err;
      }
    }
  })();

  const goalsPromise: Promise<Goal[]> = (async () => {
    if (!goals || !config.goals.enabled) return [];
    return goals.list({ status: 'active' });
  })();

  const [memories, activeGoals] = await Promise.all([memoryPromise, goalsPromise]);

  return {
    memories,
    activeGoals: activeGoals.slice(0, config.goals.maxActiveGoals),
    recentHistory,
    memoryTimedOut,
  };
}
