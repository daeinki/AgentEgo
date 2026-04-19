import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { nowMs } from '@agent-platform/core';
import type { Wing } from '../palace/layout.js';
import { decodeEmbedding, encodeEmbedding } from '../embedding/types.js';
import { MEMORY_SCHEMA_SQL } from './schema.js';

export interface ChunkRecord {
  id: string;
  wing: Wing;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  embedding?: Float32Array;
  embedderId?: string;
  tokenCount?: number;
  importance: number;
  accessCount: number;
  lastAccessed?: number;
  createdAt: number;
  updatedAt: number;
}

export interface InsertChunkParams {
  id: string;
  wing: Wing;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  embedding?: Float32Array;
  embedderId?: string;
  tokenCount?: number;
  importance?: number;
}

interface ChunkRow {
  id: string;
  wing: string;
  file_path: string;
  line_start: number;
  line_end: number;
  content: string;
  embedding: Uint8Array | null;
  embedder_id: string | null;
  token_count: number | null;
  importance: number;
  access_count: number;
  last_accessed: number | null;
  created_at: number;
  updated_at: number;
}

function rowToChunk(row: ChunkRow): ChunkRecord {
  const chunk: ChunkRecord = {
    id: row.id,
    wing: row.wing as Wing,
    filePath: row.file_path,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    content: row.content,
    importance: row.importance,
    accessCount: row.access_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.embedding) chunk.embedding = decodeEmbedding(row.embedding);
  if (row.embedder_id !== null) chunk.embedderId = row.embedder_id;
  if (row.token_count !== null) chunk.tokenCount = row.token_count;
  if (row.last_accessed !== null) chunk.lastAccessed = row.last_accessed;
  return chunk;
}

/**
 * Low-level CRUD over the `memory_chunks` + FTS5 table. No search strategy
 * logic here — callers compose BM25, vector, and structure boost externally.
 */
export class MemoryChunkStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(MEMORY_SCHEMA_SQL);
  }

  insert(params: InsertChunkParams): ChunkRecord {
    const now = nowMs();
    const stmt = this.db.prepare(
      `INSERT INTO memory_chunks (
        id, wing, file_path, line_start, line_end, content,
        embedding, embedder_id, token_count, importance,
        access_count, last_accessed, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
    );
    stmt.run(
      params.id,
      params.wing,
      params.filePath,
      params.lineStart,
      params.lineEnd,
      params.content,
      params.embedding ? encodeEmbedding(params.embedding) : null,
      params.embedderId ?? null,
      params.tokenCount ?? null,
      params.importance ?? 0.5,
      now,
      now,
    );
    return this.getById(params.id)!;
  }

  getById(id: string): ChunkRecord | null {
    const stmt = this.db.prepare('SELECT * FROM memory_chunks WHERE id = ?');
    const row = stmt.get(id) as ChunkRow | undefined;
    return row ? rowToChunk(row) : null;
  }

  getByIds(ids: string[]): ChunkRecord[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const stmt = this.db.prepare(`SELECT * FROM memory_chunks WHERE id IN (${placeholders})`);
    const rows = stmt.all(...ids) as unknown as ChunkRow[];
    return rows.map(rowToChunk);
  }

  listAll(): ChunkRecord[] {
    const stmt = this.db.prepare('SELECT * FROM memory_chunks ORDER BY updated_at DESC LIMIT 10000');
    const rows = stmt.all() as unknown as ChunkRow[];
    return rows.map(rowToChunk);
  }

  listByWing(wing: Wing, olderThanMs?: number): ChunkRecord[] {
    if (olderThanMs !== undefined) {
      const stmt = this.db.prepare(
        'SELECT * FROM memory_chunks WHERE wing = ? AND updated_at < ? ORDER BY updated_at ASC',
      );
      const rows = stmt.all(wing, olderThanMs) as unknown as ChunkRow[];
      return rows.map(rowToChunk);
    }
    const stmt = this.db.prepare(
      'SELECT * FROM memory_chunks WHERE wing = ? ORDER BY updated_at DESC',
    );
    const rows = stmt.all(wing) as unknown as ChunkRow[];
    return rows.map(rowToChunk);
  }

  /**
   * BM25 search via FTS5. Returns (id, rawBm25Score) tuples. FTS5's bm25()
   * returns *lower is better*; we negate into a higher-is-better score to keep
   * downstream merging intuitive.
   */
  bm25Search(query: string, limit: number): { id: string; bm25Score: number }[] {
    const fts = sanitizeFtsQuery(query);
    if (!fts) return [];
    const stmt = this.db.prepare(`
      SELECT memory_chunks.id AS id, bm25(memory_fts) AS raw
      FROM memory_fts
      JOIN memory_chunks ON memory_chunks.rowid = memory_fts.rowid
      WHERE memory_fts MATCH ?
      ORDER BY raw
      LIMIT ?
    `);
    const rows = stmt.all(fts, limit) as unknown as { id: string; raw: number }[];
    return rows.map((r) => ({ id: r.id, bm25Score: -r.raw }));
  }

  recordAccess(chunkId: string, sessionId: string | undefined, query: string, score: number): void {
    const incr = this.db.prepare(
      'UPDATE memory_chunks SET access_count = access_count + 1, last_accessed = ? WHERE id = ?',
    );
    incr.run(nowMs(), chunkId);
    const log = this.db.prepare(
      `INSERT INTO memory_access_log (chunk_id, session_id, query, relevance_score, was_useful, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    );
    log.run(chunkId, sessionId ?? null, query, score, nowMs());
  }

  deleteByIds(ids: string[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    const stmt = this.db.prepare(`DELETE FROM memory_chunks WHERE id IN (${placeholders})`);
    stmt.run(...ids);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * FTS5 MATCH strings are fussy — any double-quote or odd punctuation can make
 * the parser throw. We fall back to a tokenize-then-OR strategy: split the
 * query into alphanumeric + CJK runs and OR them. This is deliberately lenient
 * so user queries never trip parse errors.
 */
function sanitizeFtsQuery(query: string): string {
  const tokens =
    query
      .toLowerCase()
      .match(/[a-z0-9]+|[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+/g) ?? [];
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}
