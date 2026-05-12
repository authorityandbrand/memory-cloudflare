# memory-worker (deployed)

Source-of-truth for the live Cloudflare Worker `memory-worker` (account `e105d76aa6c851abdbd13d34d901cc7c`, deployed at `https://memory-worker.authorityandbrand.workers.dev`).

## Origin

Reconstructed from the deployed bundle on 2026-05-11. The original source repo for this worker is unknown / not in this monorepo; this directory exists so future edits can be made against a real source.

## Patches applied (vs. live bundle 2026-03-24)

1. **`session_state` INSERTs** — all 6 INSERTs (saveMemory, preCompactSnapshot, handleHook×4) now provide both `created_at` and `updated_at` to match the live D1 schema. The live bundle inserted only `created_at`, but the live `session_state` table has only `updated_at` — causing `SQLITE_ERROR: no such column: created_at` on every hook call. Bug was hot-patched in prod by `ALTER TABLE session_state ADD COLUMN created_at TEXT;` on 2026-05-11; this source matches the patched schema going forward.

2. **`scheduled()` handler** — new cron entrypoint that runs `healGaps(env)` daily and writes a `cron:auto_heal` row to `session_state`. Failures log to `error_log`. Paired with `crons = ["0 13 * * *"]` in `wrangler.toml` (13:00 UTC ≈ 8am Central).

3. **`/corpus/*` routes** — hybrid (FTS + vector) search over case PDFs backed by BigQuery (`authorityandbrand-workspace.legal_case.corpus_chunks`). Routes:
   - `GET /corpus/search?q=&top=20&mode=hybrid|fts|vector` — search excerpts
   - `POST /corpus/audit  {violation_id}` — every excerpt supporting a violation
   - `POST /corpus/ingest {r2_key|doc_id, force?}` — queue a doc for chunk+embed
   - `GET /corpus/status` — counts of docs/chunks, embedding progress
   - All proxy through the `GWS_WORKER` service binding (gws-worker holds the BQ credentials).

## Corpus layer (BigQuery)

Today: 10,000 docs in `d1_r2_document_registry` (9,912 PDFs), **zero vectorized**. The `vectorized` / `embedding_status` columns are stubbed but unused. The new `corpus_documents` + `corpus_chunks` tables close that gap.

**Bootstrap** (one-time, run from `bq/` in this directory):

```bash
# 1. Create Vertex AI connection (Cloud Console or bq CLI)
bq mk --connection --location=us --connection_type=CLOUD_RESOURCE \
   --project_id=authorityandbrand-workspace vertex_ai
# Grant the connection's service-account roles/aiplatform.user

# 2. Create schema + remote model
bq query --use_legacy_sql=false < bq/01_schema.sql

# 3. Seed corpus_documents from d1_r2_document_registry + chunk known text
bq query --use_legacy_sql=false < bq/02_backfill.sql

# 4. Run section C of 02_backfill.sql in a loop until embed_status='complete'
```

**gws-worker contract** — `/corpus/*` routes require the gws-worker to expose:
```
POST /bq/query
Body:  { project: string, query: string, params: object, mode: "read"|"write" }
Resp:  { rows: object[], schema: object[] }
```
If that route doesn't yet exist on gws-worker, it's a small wrapper around `@google-cloud/bigquery` using the existing OAuth identity.

## Deploy

```bash
cd deployed-workers/memory-worker
wrangler deploy
```

Requires `CLOUDFLARE_API_TOKEN` with Workers write permission and account `e105d76aa6c851abdbd13d34d901cc7c` in scope.

## Notes

- The MCP `workers deploy` tool in this Claude Code environment is hardcoded to service-worker syntax and cannot deploy ES modules, so this worker must be deployed via `wrangler` directly. See PR / branch `claude/load-memory-worker-fHKC0` for full audit.
- Secrets are not in version control; set them via `wrangler secret put <NAME>` against the live account before deploy.
- The DO migration tag is `v1` with `new_sqlite_classes = ["SessionStateDO"]`. Do not change without coordinating a DO migration step.
