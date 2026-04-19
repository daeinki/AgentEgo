export const MEMORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_chunks (
  id            TEXT PRIMARY KEY,
  wing          TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  line_start    INTEGER NOT NULL,
  line_end      INTEGER NOT NULL,
  content       TEXT NOT NULL,
  embedding     BLOB,
  embedder_id   TEXT,
  token_count   INTEGER,
  importance    REAL NOT NULL DEFAULT 0.5,
  access_count  INTEGER NOT NULL DEFAULT 0,
  last_accessed INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_chunks_wing ON memory_chunks(wing, updated_at);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  content,
  wing UNINDEXED,
  content='memory_chunks',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS memory_chunks_ai AFTER INSERT ON memory_chunks BEGIN
  INSERT INTO memory_fts(rowid, content, wing) VALUES (new.rowid, new.content, new.wing);
END;

CREATE TRIGGER IF NOT EXISTS memory_chunks_ad AFTER DELETE ON memory_chunks BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content, wing) VALUES('delete', old.rowid, old.content, old.wing);
END;

CREATE TRIGGER IF NOT EXISTS memory_chunks_au AFTER UPDATE ON memory_chunks BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, content, wing) VALUES('delete', old.rowid, old.content, old.wing);
  INSERT INTO memory_fts(rowid, content, wing) VALUES (new.rowid, new.content, new.wing);
END;

CREATE TABLE IF NOT EXISTS memory_access_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id        TEXT REFERENCES memory_chunks(id) ON DELETE CASCADE,
  session_id      TEXT,
  query           TEXT,
  relevance_score REAL,
  was_useful      INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_access_chunk ON memory_access_log(chunk_id);
`;
