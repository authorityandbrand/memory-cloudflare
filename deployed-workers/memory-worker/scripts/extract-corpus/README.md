# extract-corpus

One-shot backfill: pull every PDF in R2 `case-files`, run hybrid text extraction (pdf.js for native, Document AI for scans), chunk per page, write to BigQuery `legal_case.corpus_chunks`. Marks each `corpus_documents.text_status` to `extracted` / `failed` / `oversize`.

Resumable — re-run anytime to pick up any remaining `text_status='pending'`.

## One-time prereqs

```bash
# 1. Create the BQ schema (from ../bq/)
bq query --use_legacy_sql=false < ../bq/01_schema.sql
bq query --use_legacy_sql=false < ../bq/02_backfill.sql   # seeds corpus_documents

# 2. Create a Document AI OCR processor in Cloud Console:
#    https://console.cloud.google.com/ai/document-ai/processors/create
#    Type: "Document OCR"  Region: us
#    Copy the processor ID (looks like "abc123def456").

# 3. Service account with these IAM roles in authorityandbrand-workspace:
#    - BigQuery Data Editor (on dataset legal_case)
#    - BigQuery Job User (project-level)
#    - Document AI API User
#    Download the JSON key file.

# 4. Cloudflare R2 API token with read access to case-files bucket.
```

## Run

```bash
cd deployed-workers/memory-worker/scripts/extract-corpus
npm install

export GCP_PROJECT_ID=authorityandbrand-workspace
export GCP_LOCATION=us
export DOCAI_PROCESSOR_ID=<from step 2>
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa-key.json

export R2_ACCOUNT_ID=e105d76aa6c851abdbd13d34d901cc7c
export R2_ACCESS_KEY_ID=<r2 token id>
export R2_SECRET_ACCESS_KEY=<r2 token secret>
export R2_BUCKET=case-files

# Dry run first (no BQ writes) — confirms auth and shows decisions:
DRY_RUN=1 MAX_DOCS=20 npm start

# Real run — process all pending:
npm start

# Tune for speed (default 4 parallel):
CONCURRENCY=8 BATCH_SIZE=100 npm start
```

## Expected outcome

- 9,612 PDFs without extracted text → `text_status='extracted'` (or `failed`/`oversize`)
- ~50k–150k page-level chunks in `corpus_chunks`
- ~70% extracted via free pdf.js, ~30% via Document AI fallback
- Estimated cost: **$25–75** (one-time)
- Estimated time: **2–6 hours** at default concurrency

## Tuning knobs

| Env | Default | Why bump it |
|---|---|---|
| `CONCURRENCY` | 4 | More parallel R2/extract calls. Watch Doc AI quotas. |
| `BATCH_SIZE` | 50 | Bigger BQ poll between batches. Reduces poll overhead. |
| `MIN_CHARS_PER_PAGE` | 80 | Lower to trust pdf.js more (cheaper but risks bad text); raise to push more to OCR. |
| `MAX_PDF_BYTES` | 50MB | Raise for the 19 docs > 5MB and 1 max-235MB beast. Doc AI sync max is 20MB; for larger use the batch endpoint (not currently wired). |
| `MAX_DOCS` | ∞ | Cap for testing. |
| `DRY_RUN` | off | Skips BQ writes, just logs decisions. |

## Limitations / not handled

- **Docs > 20MB go through pdf.js or fail.** Document AI sync mode caps at 20MB; the 19 docs over 5MB and the 235MB outlier need the batch processor endpoint, which is not wired here. Mark as `oversize` and handle manually for now.
- **No re-extraction.** Re-run only picks up `text_status='pending'`. To re-process, manually `UPDATE corpus_documents SET text_status='pending' WHERE …` first.
- **Doc AI billing**: charged per page processed. Set quotas in GCP if you want a hard cost cap.
- **No image extraction**: ignores embedded images/charts; text only.

## Resuming after a crash

The script is idempotent on `doc_id`:
- Already-extracted docs are skipped (filtered by `text_status='pending'`)
- Already-inserted chunks would duplicate-key insert; if you hit that, `DELETE FROM corpus_chunks WHERE doc_id IN (…unfinished doc_ids)` and re-run.
