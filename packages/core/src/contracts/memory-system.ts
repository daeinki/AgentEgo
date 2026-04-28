import type {
  SearchContext,
  MemorySearchResult,
  ConversationTurn,
  IngestResult,
  ClassificationResult,
} from '../schema/memory.js';
import type { TraceCallContext } from './trace-logger.js';

export interface CompactionResult {
  wing: string;
  archivedChunks: number;
  summaryChunkId: string;
}

export interface MemorySystem {
  search(
    query: string,
    ctx: SearchContext,
    trace?: TraceCallContext,
  ): Promise<MemorySearchResult[]>;
  ingest(turn: ConversationTurn, trace?: TraceCallContext): Promise<IngestResult>;
  classify(content: string): Promise<ClassificationResult>;
  compact(wing: string, olderThan: Date): Promise<CompactionResult>;
}
