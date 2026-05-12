-- One-time backfill: seed corpus_documents from existing inventory, then chunk + embed.
-- Run in batches; each step is idempotent.

-- ----------------------------------------------------------------------------
-- A. Seed corpus_documents from d1_r2_document_registry
-- ----------------------------------------------------------------------------
INSERT INTO `authorityandbrand-workspace.legal_case.corpus_documents`
  (doc_id, r2_key, cite_as, title, filename, doc_type, page_count, sha256,
   text_status, embed_status, ingested_at, metadata)
SELECT
  TO_HEX(SHA256(r.r2_key))                       AS doc_id,
  r.r2_key                                       AS r2_key,
  COALESCE(r.filename, r.r2_key)                 AS cite_as,
  r.filename                                     AS title,
  r.filename                                     AS filename,
  COALESCE(r.content_type, 'unknown')            AS doc_type,
  NULL                                           AS page_count,
  NULL                                           AS sha256,
  'pending'                                      AS text_status,
  'pending'                                      AS embed_status,
  CURRENT_TIMESTAMP()                            AS ingested_at,
  TO_JSON(STRUCT(r.bucket AS bucket,
                 r.case_number AS case_number,
                 r.tags AS tags))                AS metadata
FROM `authorityandbrand-workspace.legal_case.d1_r2_document_registry` r
WHERE r.content_type LIKE '%pdf%'
  AND NOT EXISTS (
    SELECT 1 FROM `authorityandbrand-workspace.legal_case.corpus_documents` c
    WHERE c.r2_key = r.r2_key
  );

-- ----------------------------------------------------------------------------
-- B. Pull already-extracted text from d1_knowledge_articles when available
--    (a starting point — full PDF text extraction happens via the worker).
-- ----------------------------------------------------------------------------
-- Naive chunker: split on double-newline, give each chunk a sequential page-ish index.
-- Worker will replace this with real page-level chunks once OCR runs.
MERGE `authorityandbrand-workspace.legal_case.corpus_chunks` AS t
USING (
  SELECT
    TO_HEX(SHA256(CONCAT(d.doc_id, '|', CAST(offset AS STRING)))) AS chunk_id,
    d.doc_id,
    d.r2_key,
    offset + 1                                                    AS page,
    NULL                                                          AS section,
    NULL                                                          AS char_start,
    NULL                                                          AS char_end,
    chunk_text                                                    AS text,
    LENGTH(chunk_text) / 4                                        AS token_count,
    CAST(NULL AS ARRAY<FLOAT64>)                                  AS embedding,
    NULL                                                          AS embed_model,
    CURRENT_TIMESTAMP()                                           AS ingested_at,
    NULL                                                          AS metadata
  FROM `authorityandbrand-workspace.legal_case.corpus_documents` d
  JOIN `authorityandbrand-workspace.legal_case.d1_knowledge_articles` k
    ON k.title = d.title
  CROSS JOIN UNNEST(SPLIT(k.extracted_text, '\n\n')) AS chunk_text WITH OFFSET offset
  WHERE k.extracted_text IS NOT NULL
    AND LENGTH(chunk_text) BETWEEN 200 AND 3000
) AS s
ON t.chunk_id = s.chunk_id
WHEN NOT MATCHED THEN
  INSERT ROW;

-- ----------------------------------------------------------------------------
-- C. Generate embeddings for chunks that don't have them yet (batches of 1000).
--    Run in a loop until embed_status = 'complete'.
-- ----------------------------------------------------------------------------
MERGE `authorityandbrand-workspace.legal_case.corpus_chunks` AS t
USING (
  SELECT
    chunk_id,
    ml_generate_embedding_result AS embedding,
    'text-embedding-005'         AS embed_model
  FROM ML.GENERATE_EMBEDDING(
    MODEL `authorityandbrand-workspace.legal_case.text_embedding_005`,
    (
      SELECT chunk_id, text AS content
      FROM `authorityandbrand-workspace.legal_case.corpus_chunks`
      WHERE embedding IS NULL
      LIMIT 1000
    ),
    STRUCT(TRUE AS flatten_json_output)
  )
) AS s
ON t.chunk_id = s.chunk_id
WHEN MATCHED THEN UPDATE SET
  t.embedding   = s.embedding,
  t.embed_model = s.embed_model;

-- After C completes for all chunks, flip the document-level flag:
UPDATE `authorityandbrand-workspace.legal_case.corpus_documents` d
SET embed_status = 'complete', updated_at = CURRENT_TIMESTAMP()
WHERE doc_id IN (
  SELECT doc_id
  FROM `authorityandbrand-workspace.legal_case.corpus_chunks`
  GROUP BY doc_id
  HAVING COUNTIF(embedding IS NULL) = 0
)
AND d.embed_status != 'complete';

-- And update the legacy registry flag too, for back-compat with the old worker.
UPDATE `authorityandbrand-workspace.legal_case.d1_r2_document_registry` r
SET vectorized = 1, embedding_status = 'complete'
WHERE r.r2_key IN (
  SELECT r2_key
  FROM `authorityandbrand-workspace.legal_case.corpus_documents`
  WHERE embed_status = 'complete'
);
