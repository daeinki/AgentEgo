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
import { hybridSearch, type HybridWeights } from './search/hybrid.js';
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

  async search(query: string, ctx: SearchContext): Promise<MemorySearchResult[]> {
    this.assertReady();
    const results = await hybridSearch(query, ctx, this.store, this.embedder, this.hybridWeights);
    // Record access for the returned chunks so that future ranking can learn.
    for (const r of results) {
      const chunkLookup = this.store.bm25Search(query, 1);
      void chunkLookup; // no-op; keep access log simple for now
    }
    return results;
  }

  async ingest(turn: ConversationTurn): Promise<IngestResult> {
    this.assertReady();
    return ingestTurn(turn, {
      layout: this.layout,
      store: this.store,
      embedder: this.embedder,
    });
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
