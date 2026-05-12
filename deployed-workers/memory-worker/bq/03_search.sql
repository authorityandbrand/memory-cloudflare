-- Reference queries — paste into BQ Studio or invoke via /corpus/* worker routes.
-- All search is BQ SEARCH() on the corpus_chunks_text_idx index.

-- ----------------------------------------------------------------------------
-- 1. Basic search — every chunk matching the query.
--    @q is a search expression: bare words ('reinstatement quote'), AND/OR,
--    quoted phrases ("notice of default"), field qualifiers (text:RESPA).
-- ----------------------------------------------------------------------------
SELECT chunk_id, doc_id, r2_key, page, text
FROM `authorityandbrand-workspace.legal_case.corpus_chunks`
WHERE SEARCH(text, @q)
LIMIT @top;

-- ----------------------------------------------------------------------------
-- 2. Search with document attribution (joins back to corpus_documents).
-- ----------------------------------------------------------------------------
SELECT
  c.chunk_id, c.doc_id, c.r2_key, c.page, c.text,
  d.cite_as, d.title, d.doc_type, d.doc_date
FROM `authorityandbrand-workspace.legal_case.corpus_chunks` c
JOIN `authorityandbrand-workspace.legal_case.corpus_documents` d USING (doc_id)
WHERE SEARCH(c.text, @q)
ORDER BY d.doc_date DESC
LIMIT @top;

-- ----------------------------------------------------------------------------
-- 3. Citation / audit query — every excerpt that supports a violation.
-- ----------------------------------------------------------------------------
SELECT
  v.id AS violation_id, v.violation_type,
  c.chunk_id, c.doc_id, c.r2_key, c.page, d.cite_as, c.text
FROM `authorityandbrand-workspace.legal_case.d1_violation_matrix` v
JOIN `authorityandbrand-workspace.legal_case.d1_document_violation_links` link
  ON link.violation_id = v.id
JOIN `authorityandbrand-workspace.legal_case.corpus_documents` d
  ON d.r2_key = link.document_r2_key OR d.title = link.document_title
JOIN `authorityandbrand-workspace.legal_case.corpus_chunks` c
  ON c.doc_id = d.doc_id
WHERE v.id = @violation_id;
