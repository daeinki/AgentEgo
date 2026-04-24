import type { MemorySearchResult, SearchContext } from '@agent-platform/core';
import type { MemoryChunkStore, ChunkRecord } from '../db/store.js';
import { cosineSimilarity } from '../embedding/hash-embedder.js';
import type { EmbeddingProvider } from '../embedding/types.js';

export interface HybridWeights {
  bm25: number;
  vector: number;
  structureBoost: number;
}

/**
 * Internal-facing result shape: `result` is the contract-level
 * `MemorySearchResult`, `chunkId` is the underlying row id so callers that
 * need to record access (e.g. `PalaceMemorySystem`) don't have to re-query.
 */
export interface HybridSearchHit {
  chunkId: string;
  result: MemorySearchResult;
}

const DEFAULT_WEIGHTS: HybridWeights = {
  bm25: 0.45,
  vector: 0.45,
  structureBoost: 0.1,
};

const BM25_CANDIDATES = 50;

/**
 * Like `hybridSearch` but returns `HybridSearchHit[]` so callers can correlate
 * each result with its underlying `chunkId` (needed for access logging).
 */
export async function hybridSearchDetailed(
  query: string,
  ctx: SearchContext,
  store: MemoryChunkStore,
  embedder: EmbeddingProvider,
  weightsOverride?: Partial<HybridWeights>,
): Promise<HybridSearchHit[]> {
  const weights = { ...DEFAULT_WEIGHTS, ...weightsOverride };

  const bm25Results = store.bm25Search(query, BM25_CANDIDATES);
  const bm25Max = bm25Results.reduce((m, r) => Math.max(m, r.bm25Score), 0) || 1;

  const bm25ById = new Map<string, number>();
  for (const r of bm25Results) {
    bm25ById.set(r.id, Math.max(0, r.bm25Score / bm25Max));
  }

  // Load the candidate chunk pool: everything BM25 returned, plus everything in
  // preferred wings (so vector-only hits aren't suppressed).
  const candidateIds = new Set<string>(bm25ById.keys());
  if (ctx.preferredWings) {
    for (const wing of ctx.preferredWings) {
      const wingHits = store.listByWing(wing as ChunkRecord['wing']);
      for (const ch of wingHits) candidateIds.add(ch.id);
    }
  }
  // If still too few candidates, fall back to the latest N chunks overall.
  if (candidateIds.size < ctx.maxResults * 2) {
    for (const ch of store.listAll().slice(0, ctx.maxResults * 4)) {
      candidateIds.add(ch.id);
    }
  }

  const candidates = store.getByIds([...candidateIds]);
  if (candidates.length === 0) return [];

  const queryEmbedding = await embedder.embed(query);

  const scored = candidates.map((chunk) => {
    const bm25 = bm25ById.get(chunk.id) ?? 0;

    let vector = 0;
    if (chunk.embedding && chunk.embedderId === embedder.id) {
      vector = Math.max(0, cosineSimilarity(chunk.embedding, queryEmbedding));
    }

    const structureBoost = ctx.preferredWings?.includes(chunk.wing) ? 1 : 0;

    const combined =
      weights.bm25 * bm25 +
      weights.vector * vector +
      weights.structureBoost * structureBoost;

    return { chunk, bm25, vector, structureBoost, combined };
  });

  scored.sort((a, b) => b.combined - a.combined);

  return scored
    .filter((s) => s.combined >= ctx.minRelevanceScore)
    .slice(0, ctx.maxResults)
    .map(({ chunk, bm25, vector, structureBoost, combined }) => ({
      chunkId: chunk.id,
      result: {
        content: chunk.content,
        source: {
          wing: chunk.wing,
          file: chunk.filePath,
          lineRange: [chunk.lineStart, chunk.lineEnd] as [number, number],
        },
        relevance: {
          bm25Score: bm25,
          vectorScore: vector,
          structureBoost,
          combinedScore: combined,
        },
        metadata: {
          createdAt: new Date(chunk.createdAt).toISOString(),
          lastAccessedAt: new Date(chunk.lastAccessed ?? chunk.createdAt).toISOString(),
          accessCount: chunk.accessCount,
        },
      },
    }));
}

/**
 * Backward-compatible wrapper returning only `MemorySearchResult[]` — preferred
 * for external callers that just need the ranked contract-shaped results.
 */
export async function hybridSearch(
  query: string,
  ctx: SearchContext,
  store: MemoryChunkStore,
  embedder: EmbeddingProvider,
  weightsOverride?: Partial<HybridWeights>,
): Promise<MemorySearchResult[]> {
  const hits = await hybridSearchDetailed(query, ctx, store, embedder, weightsOverride);
  return hits.map((h) => h.result);
}
