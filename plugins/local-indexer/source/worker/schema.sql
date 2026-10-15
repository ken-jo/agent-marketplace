-- Ave Local Indexer SQLite schema (Phase 1)
-- ------------------------------------------------------------
-- Pattern B: Kiwi morpheme pre-tokenized text stored in
-- chunks_fts.content_ko; FTS5 tokenizer is unicode61 so that
-- already-tokenized (space-joined morphemes) text is indexed
-- literally. Queries must be tokenized through the same
-- KiwiTokenizer before MATCH'ing this column.
-- ------------------------------------------------------------

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS documents (
  doc_id        TEXT PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  doc_name      TEXT NOT NULL,
  doc_type      TEXT NOT NULL,          -- 'pdf' | 'md' | 'docx' | 'pptx' | 'xlsx' | 'txt' | 'html'
  page_count    INTEGER,
  line_count    INTEGER,
  mtime_ms      INTEGER NOT NULL,
  indexed_at    INTEGER NOT NULL,
  status        TEXT NOT NULL,          -- 'pending' | 'indexed' | 'failed'
  -- content_state refines an 'indexed' status without overloading it: the host
  -- hard-filters documents by status == 'indexed', so degraded/empty docs must
  -- stay 'indexed' to remain listable. content_state distinguishes the three
  -- successful-registration outcomes:
  --   'ok'           — text chunks + vector embeddings present
  --   'empty'        — parsed but no extractable text (0 chunks)
  --   'embed_failed' — text indexed (BM25/FTS5) but embeddings missing
  -- For status == 'failed' the column keeps its 'ok' default (irrelevant).
  content_state TEXT NOT NULL DEFAULT 'ok',
  -- content_hash is sha256 of the normalized, chunked text for the document.
  -- It lets index_file short-circuit a re-index when the file's visible content
  -- is unchanged (editor touch, metadata-only write, cloud-sync mtime bump) so
  -- we skip the embedding API call entirely. NULL = unknown (legacy row predates
  -- this column) and is always treated as "changed" to force one reindex+backfill.
  content_hash  TEXT
);

CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_mtime  ON documents(mtime_ms);

CREATE TABLE IF NOT EXISTS chunks (
  chunk_id     TEXT PRIMARY KEY,
  doc_id       TEXT NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
  chunk_index  INTEGER NOT NULL,
  page         INTEGER,
  raw_text     TEXT NOT NULL,
  token_count  INTEGER NOT NULL,
  chunk_hash   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc  ON chunks(doc_id);
CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(chunk_hash);

-- FTS5 virtual table for Korean BM25.
-- content_ko holds Kiwi-tokenized morphemes joined by single spaces;
-- unicode61 tokenizer then splits on whitespace so BM25 scoring
-- operates on morpheme boundaries instead of naive whitespace.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  chunk_id UNINDEXED,
  doc_id   UNINDEXED,
  raw_text UNINDEXED,
  content_ko,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS embeddings_meta (
  chunk_id     TEXT PRIMARY KEY REFERENCES chunks(chunk_id) ON DELETE CASCADE,
  model        TEXT NOT NULL,
  dimensions   INTEGER NOT NULL,
  embedded_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_embeddings_meta_model ON embeddings_meta(model);
