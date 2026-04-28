import type {
  ClassificationResult,
  ConversationTurn,
  Contracts,
  IngestResult,
  MemorySearchResult,
  SearchContext,
} from '@agent-platform/core';
import { generateId, nowMs } from '@agent-platform/core';
import { MemoryChunkStore } from './db/store.js';
import { HashEmbedder } from './embedding/hash-embedder.js';
import type { EmbeddingProvider } from './embedding/types.js';
import { classifyAsResult, ingestTurn } from './ingest/pipeline.js';
import { hybridSearchDetailed, type HybridWeights } from './search/hybrid.js';
import type { LlmCompactor } from './llm-compactor.js';
import {
  ensurePalaceLayout,
  isWing,
  layoutFor,
  type PalaceLayout,
  type Wing,
} from './palace/layout.js';
import { appendWingEntry } from './palace/writer.js';

type MemorySystem = Contracts.MemorySystem;

export interface PalaceMemoryOptions {
  /**
   * Palace root directory. Defaults to `~/.agent/memory`.
   */
  root?: string;
  embedder?: EmbeddingProvider;
  hybridWeights?: Partial<HybridWeights>;
  /**
   * Optional LLM-backed summarizer for `compact()`. When omitted, compact
   * falls back to a plain concat-of-snippets summary (Phase 3 default).
   */
  compactor?: LlmCompactor;
}

/**
 * Default implementation of `Contracts.MemorySystem` backed by the Palace
 * directory layout and a SQLite-FTS5 index with in-memory vector scoring.
 *
 * Lifecycle: construct → `await init()` → use → `close()`. We don't want
 * async work in the constructor so tests can control setup errors cleanly.
 */
export class PalaceMemorySystem implements MemorySystem {
  readonly layout: PalaceLayout;
  private readonly embedder: EmbeddingProvider;
  private readonly hybridWeights: Partial<HybridWeights>;
  private readonly compactor: LlmCompactor | undefined;
  private store!: MemoryChunkStore;
  private ready = false;

  constructor(options: PalaceMemoryOptions = {}) {
    this.layout = layoutFor(options.root ?? '~/.agent/memory');
    this.embedder = options.embedder ?? new HashEmbedder();
    this.hybridWeights = options.hybridWeights ?? {};
    this.compactor = options.compactor;
  }

  async init(): Promise<void> {
    if (this.ready) return;
    await ensurePalaceLayout(this.layout);
    this.store = new MemoryChunkStore(this.layout.dbPath);
    this.ready = true;
  }

  async close(): Promise<void> {
    if (!this.ready) return;
    this.store.close();
    this.ready = false;
  }

  async search(
    query: string,
    ctx: SearchContext,
    trace?: Contracts.TraceCallContext,
  ): Promise<MemorySearchResult[]> {
    this.assertReady();
    const startedAt = Date.now();
    const hits = await hybridSearchDetailed(query, ctx, this.store, this.embedder, this.hybridWeights);
    // Access logging: bump each returned chunk's access_count + append a
    // memory_access_log row. Enabled by default; `AGENT_MEMORY_ACCESS_LOG=0`
    // (or `='false'` / `='off'`) disables — useful when a caller wants read
    // traffic that doesn't perturb ranking signals.
    if (isAccessLoggingEnabled()) {
      for (const { chunkId, result } of hits) {
        this.store.recordAccess(chunkId, ctx.sessionId, query, result.relevance.combinedScore);
      }
    }
    if (trace) {
      const top = hits[0]?.result.relevance.combinedScore;
      const queryPreview = query.length > 40 ? `${query.slice(0, 40)}…` : query;
      trace.traceLogger.event({
        traceId: trace.traceId,
        ...(trace.sessionId !== undefined ? { sessionId: trace.sessionId } : {}),
        ...(trace.agentId !== undefined ? { agentId: trace.agentId } : {}),
        block: 'X1',
        event: 'memory_searched',
        timestamp: Date.now(),
        durationMs: Date.now() - startedAt,
        summary:
          `memory.search "${queryPreview}" → ${hits.length} hit(s)` +
          (typeof top === 'number' ? `, top score=${top.toFixed(3)}` : '') +
          ` in ${Date.now() - startedAt}ms`,
        payload: {
          query: queryPreview,
          hitCount: hits.length,
          topScores: hits.slice(0, 3).map((h) => h.result.relevance.combinedScore),
          maxResults: ctx.maxResults,
          minRelevanceScore: ctx.minRelevanceScore,
        },
      });
    }
    return hits.map((h) => h.result);
  }

  async ingest(
    turn: ConversationTurn,
    trace?: Contracts.TraceCallContext,
  ): Promise<IngestResult> {
    this.assertReady();
    const startedAt = Date.now();
    const result = await ingestTurn(turn, {
      layout: this.layout,
      store: this.store,
      embedder: this.embedder,
    });
    if (trace) {
      trace.traceLogger.event({
        traceId: trace.traceId,
        ...(trace.sessionId !== undefined ? { sessionId: trace.sessionId } : {}),
        ...(trace.agentId !== undefined ? { agentId: trace.agentId } : {}),
        block: 'X1',
        event: 'memory_ingested',
        timestamp: Date.now(),
        durationMs: Date.now() - startedAt,
        summary:
          `memory.ingest +${result.chunksAdded} new${result.chunksUpdated > 0 ? `, ~${result.chunksUpdated} updated` : ''}` +
          ` (wings: ${result.classifications.join(', ') || 'none'}) in ${Date.now() - startedAt}ms`,
        payload: {
          chunksAdded: result.chunksAdded,
          chunksUpdated: result.chunksUpdated,
          wings: result.classifications,
        },
      });
    }
    return result;
  }

  async classify(content: string): Promise<ClassificationResult> {
    return classifyAsResult(content);
  }

  /**
   * Compact a wing: take everything older than `olderThan`, roll it up into a
   * single summary chunk (concatenation for Phase 3 — LLM summarization can
   * slot in later), and delete the originals.
   */
  async compact(wing: string, olderThan: Date): Promise<Contracts.CompactionResult> {
    this.assertReady();
    if (!isWing(wing)) {
      throw new Error(`Unknown wing: ${wing}`);
    }
    const cutoff = olderThan.getTime();
    const stale = this.store.listByWing(wing, cutoff);
    if (stale.length === 0) {
      return { wing, archivedChunks: 0, summaryChunkId: '' };
    }

    let summaryBody: string;
    if (this.compactor) {
      const llmSummary = await this.compactor.summarize(stale);
      summaryBody = `Compacted ${stale.length} chunks older than ${olderThan.toISOString()} (LLM summary):\n${llmSummary}`;
    } else {
      const summaryText = stale
        .map((c) => `- [${new Date(c.createdAt).toISOString()}] ${c.content.slice(0, 200)}`)
        .join('\n');
      summaryBody = `Compacted ${stale.length} chunks older than ${olderThan.toISOString()}:\n${summaryText}`;
    }

    const fileName = 'compacted.md';
    const filePath = `${this.layout.wingsRoot}/${wing}/${fileName}`;
    await appendWingEntry({
      filePath,
      heading: `compaction (${stale.length} chunks)`,
      content: summaryBody,
      timestampIso: new Date().toISOString(),
    });

    const summaryId = generateId();
    const embedding = await this.embedder.embed(summaryBody);
    this.store.insert({
      id: summaryId,
      wing: wing as Wing,
      filePath,
      lineStart: 1,
      lineEnd: summaryBody.split('\n').length,
      content: summaryBody,
      embedding,
      embedderId: this.embedder.id,
      importance: 0.4,
    });

    this.store.deleteByIds(stale.map((s) => s.id));

    return {
      wing,
      archivedChunks: stale.length,
      summaryChunkId: summaryId,
    };
  }

  // ─── Helpers exposed for tests / admin tools ─────────────────────────────

  /**
   * Lightweight stat probe: total chunks per wing. Not part of the
   * MemorySystem contract; useful for CLI "memory status".
   */
  countByWing(): Record<Wing, number> {
    this.assertReady();
    const all = this.store.listAll();
    const counts: Record<Wing, number> = {
      personal: 0,
      work: 0,
      knowledge: 0,
      interactions: 0,
    };
    for (const c of all) counts[c.wing] += 1;
    return counts;
  }

  private assertReady(): void {
    if (!this.ready) {
      throw new Error('PalaceMemorySystem not initialized — call init() first');
    }
    void nowMs;
  }
}

/**
 * `AGENT_MEMORY_ACCESS_LOG` semantics: default on; `='0' | 'false' | 'off' |
 * 'no'` (case-insensitive) turns logging off. Anything else including the env
 * var being unset leaves logging enabled — replacing the pre-v0.7 stub that
 * never recorded access.
 */
function isAccessLoggingEnabled(): boolean {
  const raw = process.env['AGENT_MEMORY_ACCESS_LOG'];
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}
