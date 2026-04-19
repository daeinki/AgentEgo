import type {
  SearchContext,
  MemorySearchResult,
  ConversationTurn,
  IngestResult,
  ClassificationResult,
} from '../schema/memory.js';

export interface CompactionResult {
  wing: string;
  archivedChunks: number;
  summaryChunkId: string;
}

export interface MemorySystem {
  search(query: string, ctx: SearchContext): Promise<MemorySearchResult[]>;
  ingest(turn: ConversationTurn): Promise<IngestResult>;
  classify(content: string): Promise<ClassificationResult>;
  compact(wing: string, olderThan: Date): Promise<CompactionResult>;
}
