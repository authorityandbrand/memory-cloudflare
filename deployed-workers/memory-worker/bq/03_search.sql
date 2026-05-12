-- Hybrid search examples — FTS + vector union, deduped, ranked.
-- All queries are parameterized on @q (search string) and @top (limit).
-- Reference: paste these into BQ Studio or invoke via /corpus/search worker route.

-- ----------------------------------------------------------------------------
-- 1. Pure FTS (exact tokens, fast, no embedding cost)
-- ----------------------------------------------------------------------------
SELECT chunk_id, doc_id, r2_key, page, text
FROM `authorityandbrand-workspace.legal_case.corpus_chunks`
WHERE SEARCH(text, @q)
LIMIT @top;

-- ----------------------------------------------------------------------------
-- 2. Pure vector (semantic, catches paraphrases)
-- ----------------------------------------------------------------------------
SELECT base.chunk_id, base.doc_id, base.r2_key, base.page, base.text, distance
FROM VECTOR_SEARCH(
  TABLE `authorityandbrand-workspace.legal_case.corpus_chunks`,
  'embedding',
  (
    SELECT ml_generate_embedding_result AS embedding
    FROM ML.GENERATE_EMBEDDING(
      MODEL `authorityandbrand-workspace.legal_case.text_embedding_005`,
      (SELECT @q AS content),
      STRUCT(TRUE AS flatten_json_output)
    )
  ),
  top_k => @top,
  distance_type => 'COSINE'
);

-- ----------------------------------------------------------------------------
-- 3. Hybrid (UNION + dedupe + simple rank fusion)
-- ----------------------------------------------------------------------------
WITH q_embed AS (
  SELECT ml_generate_embedding_result AS embedding
  FROM ML.GENERATE_EMBEDDING(
    MODEL `authorityandbrand-workspace.legal_case.text_embedding_005`,
    (SELECT @q AS content),
    STRUCT(TRUE AS flatten_json_output)
  )
),
fts AS (
  SELECT chunk_id, doc_id, r2_key, page, text,
         1.0 AS fts_score, NULL AS vec_distance
  FROM `authorityandbrand-workspace.legal_case.corpus_chunks`
  WHERE SEARCH(text, @q)
  LIMIT 100
),
vec AS (
  SELECT base.chunk_id, base.doc_id, base.r2_key, base.page, base.text,
         NULL AS fts_score, distance AS vec_distance
  FROM VECTOR_SEARCH(
    TABLE `authorityandbrand-workspace.legal_case.corpus_chunks`,
    'embedding',
    TABLE q_embed,
    top_k => 100,
    distance_type => 'COSINE'
  )
)
SELECT
  chunk_id, doc_id, r2_key, page, text,
  MAX(fts_score)    AS fts_score,
  MIN(vec_distance) AS vec_distance,
  -- Reciprocal-rank fusion: 1/(60+rank) per source, summed.
  (CASE WHEN MAX(fts_score) IS NOT NULL THEN 1.0/60 ELSE 0 END
   + CASE WHEN MIN(vec_distance) IS NOT NULL
          THEN 1.0/(60 + RANK() OVER (ORDER BY MIN(vec_distance) ASC NULLS LAST))
          ELSE 0 END) AS hybrid_score
FROM (SELECT * FROM fts UNION ALL SELECT * FROM vec)
GROUP BY chunk_id, doc_id, r2_key, page, text
ORDER BY hybrid_score DESC
LIMIT @top;

-- ----------------------------------------------------------------------------
-- 4. Citation/audit query — given a violation_id, find every excerpt that
--    supports it (joins corpus_chunks to violation_matrix via document_violation_links).
-- ----------------------------------------------------------------------------
SELECT
  v.id              AS violation_id,
  v.violation_type,
  c.chunk_id, c.doc_id, c.r2_key, c.page,
  d.cite_as,
  c.text
FROM `authorityandbrand-workspace.legal_case.d1_violation_matrix` v
JOIN `authorityandbrand-workspace.legal_case.d1_document_violation_links` link
  ON link.violation_id = v.id
JOIN `authorityandbrand-workspace.legal_case.corpus_documents` d
  ON d.r2_key = link.document_r2_key OR d.title = link.document_title
JOIN `authorityandbrand-workspace.legal_case.corpus_chunks` c
  ON c.doc_id = d.doc_id
WHERE v.id = @violation_id;
