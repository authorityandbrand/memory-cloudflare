#!/usr/bin/env node
// extract-corpus — backfill text from R2 PDFs into BigQuery corpus_chunks.
//
// Strategy:
//   1. SELECT pending docs from corpus_documents (limit BATCH_SIZE)
//   2. For each: pull PDF from R2, try pdf.js text extraction.
//   3. If pdf.js yields < MIN_CHARS_PER_PAGE on average -> Document AI OCR.
//   4. Chunk per page, write to corpus_chunks via BQ streaming insert.
//   5. UPDATE text_status. Loop until no pending.
//
// Env (required):
//   GCP_PROJECT_ID                authorityandbrand-workspace
//   GCP_LOCATION                  us
//   DOCAI_PROCESSOR_ID            <created via Cloud Console: OCR processor>
//   GOOGLE_APPLICATION_CREDENTIALS path to service-account JSON
//   R2_ACCOUNT_ID                 Cloudflare account id
//   R2_ACCESS_KEY_ID              R2 API token
//   R2_SECRET_ACCESS_KEY          R2 API token secret
//   R2_BUCKET                     case-files
//
// Env (optional):
//   BATCH_SIZE=50                 docs per BQ poll
//   CONCURRENCY=4                 parallel extractions
//   MAX_DOCS                      stop after this many (testing)
//   MIN_CHARS_PER_PAGE=80         pdf.js empty-threshold; below -> OCR fallback
//   MAX_PDF_BYTES=52428800        50MB safety cap; larger docs marked 'oversize'
//   DRY_RUN=1                     log decisions, don't write to BQ
//
// Run:  npm install && npm start
// Resume: just re-run; uses BQ state to skip done docs.

import { BigQuery } from "@google-cloud/bigquery";
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import pLimit from "p-limit";
import { createHash } from "node:crypto";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

// ---- config ----
const cfg = {
  project: requireEnv("GCP_PROJECT_ID"),
  location: process.env.GCP_LOCATION || "us",
  processorId: requireEnv("DOCAI_PROCESSOR_ID"),
  r2: {
    accountId: requireEnv("R2_ACCOUNT_ID"),
    accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
    bucket: process.env.R2_BUCKET || "case-files"
  },
  batchSize: int(process.env.BATCH_SIZE, 50),
  concurrency: int(process.env.CONCURRENCY, 4),
  maxDocs: int(process.env.MAX_DOCS, Number.POSITIVE_INFINITY),
  minCharsPerPage: int(process.env.MIN_CHARS_PER_PAGE, 80),
  maxBytes: int(process.env.MAX_PDF_BYTES, 50 * 1024 * 1024),
  dryRun: process.env.DRY_RUN === "1"
};

const bq = new BigQuery({ projectId: cfg.project });
const docai = new DocumentProcessorServiceClient();
const s3 = new S3Client({
  region: "auto",
  endpoint: `https://${cfg.r2.accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: cfg.r2.accessKeyId, secretAccessKey: cfg.r2.secretAccessKey }
});

const PROCESSOR = `projects/${cfg.project}/locations/${cfg.location}/processors/${cfg.processorId}`;
const TABLE_DOCS   = `${cfg.project}.legal_case.corpus_documents`;
const TABLE_CHUNKS = `${cfg.project}.legal_case.corpus_chunks`;

// ---- main loop ----
const stats = { processed: 0, viaPdfjs: 0, viaDocAI: 0, failed: 0, oversize: 0, chunks: 0 };
let totalSeen = 0;

while (totalSeen < cfg.maxDocs) {
  const remaining = Math.min(cfg.batchSize, cfg.maxDocs - totalSeen);
  const docs = await fetchPending(remaining);
  if (docs.length === 0) {
    console.log("No more pending docs. Done.");
    break;
  }
  totalSeen += docs.length;
  console.log(`[batch] picked up ${docs.length} pending docs (total seen: ${totalSeen})`);

  const limit = pLimit(cfg.concurrency);
  await Promise.all(docs.map(d => limit(() => processDoc(d).catch(err => recordFailure(d, err)))));
  console.log(`[stats]`, stats);
}

console.log(`\n=== DONE ===`);
console.log(stats);

// ---- functions ----

async function fetchPending(limit) {
  const [rows] = await bq.query({
    query: `SELECT doc_id, r2_key, filename
            FROM \`${TABLE_DOCS}\`
            WHERE text_status = 'pending'
            LIMIT @limit`,
    params: { limit }
  });
  return rows;
}

async function processDoc(doc) {
  const { doc_id, r2_key } = doc;
  console.log(`[doc] ${r2_key}`);
  const buf = await fetchR2(r2_key);
  if (!buf) return recordFailure(doc, new Error("R2 object missing"));
  if (buf.length > cfg.maxBytes) {
    stats.oversize++;
    return updateStatus(doc_id, "oversize", `Size ${buf.length} > maxBytes`);
  }

  // Path 1: pdf.js
  let pages = await tryPdfJs(buf);
  let extractor = "pdf.js";

  // Path 2: Doc AI fallback if pdf.js yielded too little text
  if (!pages || avgCharsPerPage(pages) < cfg.minCharsPerPage) {
    pages = await tryDocAI(buf);
    extractor = "docai";
  }

  if (!pages || pages.length === 0) {
    return recordFailure(doc, new Error("No text from either extractor"));
  }

  const chunks = buildChunks(doc, pages);
  await writeChunks(chunks);
  await updateStatus(doc_id, "extracted", `via ${extractor}, ${pages.length} pages, ${chunks.length} chunks`);

  stats.processed++;
  if (extractor === "pdf.js") stats.viaPdfjs++; else stats.viaDocAI++;
  stats.chunks += chunks.length;
}

async function fetchR2(key) {
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: cfg.r2.bucket, Key: key }));
    const chunks = [];
    for await (const c of obj.Body) chunks.push(c);
    return Buffer.concat(chunks);
  } catch (e) {
    if (e.Code === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

async function tryPdfJs(buf) {
  try {
    const pdf = await getDocument({ data: new Uint8Array(buf), disableFontFace: true, useSystemFonts: false }).promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      const text = tc.items.map(it => it.str).join(" ").replace(/\s+/g, " ").trim();
      pages.push({ page: i, text });
    }
    return pages;
  } catch (e) {
    console.warn(`  pdf.js failed: ${e.message}`);
    return null;
  }
}

async function tryDocAI(buf) {
  try {
    const [result] = await docai.processDocument({
      name: PROCESSOR,
      rawDocument: { content: buf, mimeType: "application/pdf" }
    });
    const doc = result.document;
    if (!doc || !doc.pages) return null;
    // Doc AI returns full text + per-page layout offsets. Reconstruct per page.
    return doc.pages.map((p, idx) => {
      const segments = p.layout?.textAnchor?.textSegments || [];
      const text = segments.map(s => {
        const start = parseInt(s.startIndex || "0", 10);
        const end = parseInt(s.endIndex || "0", 10);
        return doc.text.substring(start, end);
      }).join(" ").replace(/\s+/g, " ").trim();
      return { page: idx + 1, text };
    });
  } catch (e) {
    console.warn(`  docai failed: ${e.message}`);
    return null;
  }
}

function buildChunks(doc, pages) {
  const out = [];
  for (const { page, text } of pages) {
    if (!text) continue;
    // Split on paragraph breaks; keep chunks 200-3000 chars.
    const paragraphs = text.split(/(?<=[.!?])\s{2,}|\n\n+/).filter(p => p.trim().length >= 80);
    let offset = 0;
    paragraphs.forEach((p, idx) => {
      const trimmed = p.trim();
      if (trimmed.length < 80) return;
      // If a paragraph is too long, slice into ~1500-char windows.
      const slices = trimmed.length <= 3000 ? [trimmed] : sliceText(trimmed, 1500);
      slices.forEach(slice => {
        out.push({
          chunk_id: sha256(`${doc.doc_id}|${page}|${offset}`),
          doc_id: doc.doc_id,
          r2_key: doc.r2_key,
          page,
          section: null,
          char_start: offset,
          char_end: offset + slice.length,
          text: slice,
          token_count: Math.ceil(slice.length / 4),
          ingested_at: new Date().toISOString(),
          metadata: null
        });
        offset += slice.length + 1;
      });
    });
  }
  return out;
}

function sliceText(s, size) {
  const out = [];
  let i = 0;
  while (i < s.length) { out.push(s.slice(i, i + size)); i += size; }
  return out;
}

async function writeChunks(chunks) {
  if (chunks.length === 0) return;
  if (cfg.dryRun) { console.log(`  [dry] would insert ${chunks.length} chunks`); return; }
  const table = bq.dataset("legal_case").table("corpus_chunks");
  await table.insert(chunks, { ignoreUnknownValues: false, skipInvalidRows: false });
}

async function updateStatus(doc_id, status, note) {
  console.log(`  -> ${status} (${note})`);
  if (cfg.dryRun) return;
  await bq.query({
    query: `UPDATE \`${TABLE_DOCS}\`
            SET text_status = @status,
                updated_at = CURRENT_TIMESTAMP(),
                metadata = JSON_SET(IFNULL(metadata, JSON '{}'), '$.extract_note', @note)
            WHERE doc_id = @doc_id`,
    params: { status, doc_id, note }
  });
}

async function recordFailure(doc, err) {
  stats.failed++;
  console.error(`  FAILED ${doc.r2_key}: ${err.message}`);
  await updateStatus(doc.doc_id, "failed", err.message?.slice(0, 200) || "unknown");
}

function avgCharsPerPage(pages) {
  if (!pages || pages.length === 0) return 0;
  return pages.reduce((s, p) => s + (p.text?.length || 0), 0) / pages.length;
}

function sha256(s) { return createHash("sha256").update(s).digest("hex"); }
function requireEnv(k) { const v = process.env[k]; if (!v) { console.error(`Missing env: ${k}`); process.exit(1); } return v; }
function int(v, dflt) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : dflt; }
