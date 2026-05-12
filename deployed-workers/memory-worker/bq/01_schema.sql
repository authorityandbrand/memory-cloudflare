-- corpus_chunks + corpus_documents — knowledge corpus for hybrid (FTS + vector) search
-- Project:  authorityandbrand-workspace
-- Dataset:  legal_case (existing)
-- Region:   US
--
-- Prereqs (one-time, run via `bq` CLI or Cloud Console):
--   1. Vertex AI connection (for ML.GENERATE_EMBEDDING):
--        bq mk --connection --location=us --connection_type=CLOUD_RESOURCE \
--          --project_id=authorityandbrand-workspace vertex_ai
--      Grant the connection's service-account `roles/aiplatform.user`.
--   2. text-embedding-005 model must be available in the project's Vertex region.

-- ----------------------------------------------------------------------------
-- 1. Documents — one row per ingested PDF (mirrors d1_r2_document_registry but
--    canonical for the corpus layer).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `authorityandbrand-workspace.legal_case.corpus_documents` (
  doc_id          STRING NOT NULL,        -- stable hash of r2_key
  r2_key          STRING NOT NULL,        -- exact R2 object key
  cite_as         STRING,                 -- short attribution string for source_document
  title           STRING,
  filename        STRING,
  doc_type        STRING,                 -- 'pleading','correspondence','exhibit','recorded_instrument',...
  doc_date        DATE,
  page_count      INT64,
  sha256          STRING,
  text_status     STRING,                 -- 'pending','extracted','ocr_required','failed'
  embed_status    STRING,                 -- 'pending','complete','failed'
  embed_model     STRING,                 -- 'text-embedding-005'
  ingested_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  metadata        JSON                    -- free-form (party, defendant_ids, exhibit_id...)
)
PARTITION BY DATE(ingested_at)
CLUSTER BY doc_type, doc_id
OPTIONS (
  description = "One row per document in the case corpus. Mirrors d1_r2_document_registry but canonical for hybrid search."
);

-- ----------------------------------------------------------------------------
-- 2. Chunks — page/paragraph-level excerpts with embeddings.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `authorityandbrand-workspace.legal_case.corpus_chunks` (
  chunk_id     STRING NOT NULL,           -- deterministic: hash(doc_id, page, char_start)
  doc_id       STRING NOT NULL,           -- FK -> corpus_documents.doc_id
  r2_key       STRING NOT NULL,           -- denormalized for fast cite-back
  page         INT64,                     -- 1-based page number
  section      STRING,                    -- optional named section (e.g. "ARGUMENT")
  char_start   INT64,
  char_end     INT64,
  text         STRING NOT NULL,           -- raw excerpt (target ~500-1500 chars)
  token_count  INT64,
  embedding    ARRAY<FLOAT64>,            -- 768-dim from text-embedding-005
  embed_model  STRING,
  ingested_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP(),
  metadata     JSON
)
PARTITION BY DATE(ingested_at)
CLUSTER BY doc_id, page
OPTIONS (
  description = "Page/paragraph-level excerpts with embeddings for hybrid FTS + vector search."
);

-- ----------------------------------------------------------------------------
-- 3. Full-text search index on chunk text (BQ SEARCH() function).
-- ----------------------------------------------------------------------------
CREATE SEARCH INDEX IF NOT EXISTS corpus_chunks_text_idx
ON `authorityandbrand-workspace.legal_case.corpus_chunks`(text)
OPTIONS (analyzer = 'LOG_ANALYZER');

-- ----------------------------------------------------------------------------
-- 4. Vector index for fast ANN search.
--    NOTE: requires >=5,000 rows before BQ will build it; safe to declare early.
-- ----------------------------------------------------------------------------
CREATE VECTOR INDEX IF NOT EXISTS corpus_chunks_embedding_idx
ON `authorityandbrand-workspace.legal_case.corpus_chunks`(embedding)
OPTIONS (
  index_type      = 'IVF',
  distance_type   = 'COSINE'
);

-- ----------------------------------------------------------------------------
-- 5. Remote model for embedding generation.
--    Requires the `vertex_ai` connection from prereqs.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE MODEL `authorityandbrand-workspace.legal_case.text_embedding_005`
REMOTE WITH CONNECTION `authorityandbrand-workspace.us.vertex_ai`
OPTIONS (endpoint = 'text-embedding-005');
