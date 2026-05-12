-- corpus_chunks + corpus_documents — full-text knowledge corpus
-- Project:  authorityandbrand-workspace
-- Dataset:  legal_case (existing)
-- Region:   US
--
-- No embeddings, no vector index, no remote models. BQ SEARCH() does the work.

-- ----------------------------------------------------------------------------
-- 1. Documents — one row per ingested PDF.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `authorityandbrand-workspace.legal_case.corpus_documents` (
  doc_id        STRING NOT NULL,         -- stable hash of r2_key
  r2_key        STRING NOT NULL,         -- exact R2 object key
  cite_as       STRING,                  -- short attribution string for source_document
  title         STRING,
  filename      STRING,
  doc_type      STRING,
  doc_date      DATE,
  page_count    INT64,
  sha256        STRING,
  text_status   STRING,                  -- 'pending','extracted','ocr_required','failed'
  ingested_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  metadata      JSON
)
PARTITION BY DATE(ingested_at)
CLUSTER BY doc_type, doc_id
OPTIONS (
  description = "One row per document in the case corpus. Canonical for full-text search."
);

-- ----------------------------------------------------------------------------
-- 2. Chunks — page/paragraph excerpts.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `authorityandbrand-workspace.legal_case.corpus_chunks` (
  chunk_id     STRING NOT NULL,
  doc_id       STRING NOT NULL,
  r2_key       STRING NOT NULL,
  page         INT64,
  section      STRING,
  char_start   INT64,
  char_end     INT64,
  text         STRING NOT NULL,
  token_count  INT64,
  ingested_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  metadata     JSON
)
PARTITION BY DATE(ingested_at)
CLUSTER BY doc_id, page
OPTIONS (
  description = "Page/paragraph-level excerpts. Searched via BQ SEARCH()."
);

-- ----------------------------------------------------------------------------
-- 3. Full-text search index. Single index, that's the whole search story.
-- ----------------------------------------------------------------------------
CREATE SEARCH INDEX IF NOT EXISTS corpus_chunks_text_idx
ON `authorityandbrand-workspace.legal_case.corpus_chunks`(text)
OPTIONS (analyzer = 'LOG_ANALYZER');
