-- One-time backfill: seed corpus_documents. Idempotent.
--
-- Note: actual text extraction + chunking happens in scripts/extract-corpus/.
-- This file only seeds the document inventory from d1_r2_document_registry.

-- ----------------------------------------------------------------------------
-- Seed corpus_documents from d1_r2_document_registry (PDFs only).
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
