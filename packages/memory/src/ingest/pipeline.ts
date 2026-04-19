import { readFile } from 'node:fs/promises';
import type {
  ClassificationResult,
  ConversationTurn,
  IngestResult,
} from '@agent-platform/core';
import { generateId, nowIso } from '@agent-platform/core';
import type { MemoryChunkStore } from '../db/store.js';
import type { EmbeddingProvider } from '../embedding/types.js';
import type { PalaceLayout, Wing } from '../palace/layout.js';
import { wingFile } from '../palace/layout.js';
import { appendWingEntry } from '../palace/writer.js';
import { chunkText, estimateTokenCount } from './chunker.js';
import { classifyContent } from './classifier.js';

export interface IngestDeps {
  layout: PalaceLayout;
  store: MemoryChunkStore;
  embedder: EmbeddingProvider;
}

export interface IngestOptions {
  /**
   * Target tokens per chunk. Default 300.
   */
  targetTokens?: number;
}

function formatTurn(turn: ConversationTurn): string {
  const parts = [`[user] ${turn.userMessage.trim()}`, `[assistant] ${turn.agentResponse.trim()}`];
  return parts.join('\n\n');
}

/**
 * Ingest a single conversation turn into the palace: classify → chunk →
 * append to wing file → insert indexed chunks (with embeddings).
 */
export async function ingestTurn(
  turn: ConversationTurn,
  deps: IngestDeps,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const formatted = formatTurn(turn);
  const classification = classifyContent(formatted);
  const classifications = [`${classification.wing}${classification.subcategory ? `/${classification.subcategory}` : ''}`];

  const chunks = chunkText(formatted, { targetTokens: options.targetTokens ?? 300 });
  if (chunks.length === 0) {
    return { chunksAdded: 0, chunksUpdated: 0, classifications };
  }

  const fileName = `${classification.subcategory ?? 'general'}.md`;
  const filePath = wingFile(deps.layout, classification.wing, fileName);

  // Determine current line count so we can record a lineRange.
  let currentLineCount = 0;
  try {
    const existing = await readFile(filePath, 'utf-8');
    currentLineCount = existing.length === 0 ? 0 : existing.split('\n').length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    currentLineCount = 0;
  }

  let added = 0;
  for (const chunkBody of chunks) {
    const timestampIso = nowIso();
    const heading = `turn ${turn.sessionId}`;
    await appendWingEntry({ filePath, heading, content: chunkBody, timestampIso });

    const lineStart = currentLineCount + 2; // after the blank line + heading
    const lineEnd = lineStart + chunkBody.split('\n').length - 1;
    currentLineCount = lineEnd + 1; // include trailing blank

    const embedding = await deps.embedder.embed(chunkBody);
    deps.store.insert({
      id: generateId(),
      wing: classification.wing,
      filePath,
      lineStart,
      lineEnd,
      content: chunkBody,
      embedding,
      embedderId: deps.embedder.id,
      tokenCount: estimateTokenCount(chunkBody),
      importance: classification.confidence,
    });
    added += 1;
  }

  return { chunksAdded: added, chunksUpdated: 0, classifications };
}

export function classifyAsResult(content: string): ClassificationResult {
  const match = classifyContent(content);
  const result: ClassificationResult = {
    wing: match.wing,
    confidence: match.confidence,
  };
  if (match.subcategory !== undefined) result.subcategory = match.subcategory;
  return result;
}

/**
 * Re-export for callers that want the raw classification without the
 * ClassificationResult shape.
 */
export { classifyContent };
export type { Wing };
