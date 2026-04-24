export { PalaceMemorySystem } from './palace-memory.js';
export type { PalaceMemoryOptions } from './palace-memory.js';

export { WINGS, isWing, layoutFor, ensurePalaceLayout, wingDir, wingFile } from './palace/layout.js';
export type { Wing, PalaceLayout } from './palace/layout.js';

export { MemoryChunkStore } from './db/store.js';
export type { ChunkRecord, InsertChunkParams } from './db/store.js';

export { HashEmbedder, cosineSimilarity } from './embedding/hash-embedder.js';
export {
  HttpEmbedder,
  openAIEmbedder,
  voyageEmbedder,
  ollamaEmbedder,
} from './embedding/http-embedder.js';
export type { HttpEmbedderConfig } from './embedding/http-embedder.js';
export {
  encodeEmbedding,
  decodeEmbedding,
  type EmbeddingProvider,
} from './embedding/types.js';

export { chunkText, estimateTokenCount } from './ingest/chunker.js';
export { classifyContent, classifyAsResult } from './ingest/pipeline.js';
export type { ClassificationMatch } from './ingest/classifier.js';

export { hybridSearch, hybridSearchDetailed } from './search/hybrid.js';
export type { HybridWeights, HybridSearchHit } from './search/hybrid.js';

export { appendWingEntry, lineRangeFor } from './palace/writer.js';

export { LlmCompactor } from './llm-compactor.js';
export type { LlmCompactorOptions, CompactorModelAdapter } from './llm-compactor.js';
