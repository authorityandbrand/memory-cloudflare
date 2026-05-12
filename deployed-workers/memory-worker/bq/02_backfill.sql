-- One-time backfill: seed corpus_documents, chunk extracted text.
-- Idempotent — safe to re-run.

-- ----------------------------------------------------------------------------
-- A. Seed corpus_documents from d1_r2_document_registry (PDFs only).
-- ----------------------------------------------------------------------------
INSERT INTO `authorityandbrand-workspace.legal_case.corpus_documents`
  (doc_id, r2_key, cite_as, title, filename, doc_type, text_status, ingested_at, metadata)
SELECT
  TO_HEX(SHA256(r.r2_key))             AS doc_id,
  r.r2_key                             AS r2_key,
  COALESCE(r.filename, r.r2_key)       AS cite_as,
  r.filename                           AS title,
  r.filename                           AS filename,
  COALESCE(r.content_type, 'unknown')  AS doc_type,
  'pending'                            AS text_status,
  CURRENT_TIMESTAMP()                  AS ingested_at,
  TO_JSON(STRUCT(r.bucket AS bucket,
                 r.case_number AS case_number,
                 r.tags AS tags))      AS metadata
FROM `authorityandbrand-workspace.legal_case.d1_r2_document_registry` r
WHERE r.content_type LIKE '%pdf%'
  AND NOT EXISTS (
    SELECT 1 FROM `authorityandbrand-workspace.legal_case.corpus_documents` c
    WHERE c.r2_key = r.r2_key
  );

-- ----------------------------------------------------------------------------
-- B. Chunk already-extracted text from d1_knowledge_articles.
--    Worker ingest pipeline replaces this with page-level chunks once OCR runs
--    on the other ~9,600 PDFs that lack extracted_text.
-- ----------------------------------------------------------------------------
MERGE `authorityandbrand-workspace.legal_case.corpus_chunks` AS t
USING (
  SELECT
    TO_HEX(SHA256(CONCAT(d.doc_id, '|', CAST(offset AS STRING)))) AS chunk_id,
    d.doc_id,
    d.r2_key,
    offset + 1                          AS page,
    NULL                                AS section,
    NULL                                AS char_start,
    NULL                                AS char_end,
    chunk_text                          AS text,
    LENGTH(chunk_text) / 4              AS token_count,
    CURRENT_TIMESTAMP()                 AS ingested_at,
    NULL                                AS metadata
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
-- C. Mark documents that successfully chunked as 'extracted'.
-- ----------------------------------------------------------------------------
UPDATE `authorityandbrand-workspace.legal_case.corpus_documents` d
SET text_status = 'extracted', updated_at = CURRENT_TIMESTAMP()
WHERE doc_id IN (
  SELECT DISTINCT doc_id FROM `authorityandbrand-workspace.legal_case.corpus_chunks`
)
AND d.text_status != 'extracted';
