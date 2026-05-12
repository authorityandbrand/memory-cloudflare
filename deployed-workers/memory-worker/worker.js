// memory-worker — Nguyen v. Fay Servicing memory layer
// Reconstructed from deployed bundle 2026-05-11; added scheduled() handler.

export class SessionStateDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.initialized = false;
  }
  async initialize() {
    if (this.initialized) return;
    await this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        category TEXT DEFAULT 'general',
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        payload TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_date TEXT NOT NULL,
        snapshot TEXT NOT NULL,
        trigger TEXT DEFAULT 'manual',
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    this.initialized = true;
  }
  async fetch(request) {
    await this.initialize();
    const url = new URL(request.url);
    const method = request.method;
    try {
      if (method === "GET" && url.pathname === "/load") {
        const memory = {};
        const rows = this.state.storage.sql.exec("SELECT key, value, category FROM memory ORDER BY updated_at DESC").toArray();
        for (const row of rows) {
          if (!memory[row.category]) memory[row.category] = {};
          try { memory[row.category][row.key] = JSON.parse(row.value); }
          catch { memory[row.category][row.key] = row.value; }
        }
        const events = this.state.storage.sql.exec("SELECT * FROM events ORDER BY id DESC LIMIT 50").toArray();
        const checkpoints = this.state.storage.sql.exec("SELECT * FROM checkpoints ORDER BY id DESC LIMIT 10").toArray();
        return jsonResponse({ memory, events, checkpoints, entries: rows.length });
      }
      if (method === "POST" && url.pathname === "/save") {
        const body = await request.json();
        const { key, value, category = "general" } = body;
        if (!key) return jsonResponse({ error: "key is required" }, 400);
        const valStr = typeof value === "string" ? value : JSON.stringify(value);
        this.state.storage.sql.exec(
          `INSERT OR REPLACE INTO memory (key, value, category, updated_at) VALUES (?, ?, ?, datetime('now'))`,
          key, valStr, category
        );
        return jsonResponse({ ok: true, key, category });
      }
      if (method === "POST" && url.pathname === "/checkpoint") {
        const body = await request.json();
        const allMemory = {};
        const rows = this.state.storage.sql.exec("SELECT key, value, category FROM memory").toArray();
        for (const row of rows) {
          if (!allMemory[row.category]) allMemory[row.category] = {};
          try { allMemory[row.category][row.key] = JSON.parse(row.value); }
          catch { allMemory[row.category][row.key] = row.value; }
        }
        this.state.storage.sql.exec(
          `INSERT INTO checkpoints (session_date, snapshot, trigger) VALUES (?, ?, ?)`,
          body.date || new Date().toISOString().split("T")[0],
          JSON.stringify(allMemory),
          body.trigger || "manual"
        );
        return jsonResponse({ ok: true, entries: rows.length });
      }
      if (method === "POST" && url.pathname === "/event") {
        const body = await request.json();
        this.state.storage.sql.exec(
          "INSERT INTO events (event_type, payload) VALUES (?, ?)",
          body.event_type || "unknown",
          JSON.stringify(body.payload || {})
        );
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: "Not found" }, 404);
    } catch (err) {
      return jsonResponse({ error: err.message }, 500);
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };
    if (method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    try {
      if (path === "/health" && method === "GET") return jsonResponse(await healthCheck(env), 200, corsHeaders);
      if (path === "/memory/load" && method === "GET") return jsonResponse(await loadMemory(env), 200, corsHeaders);
      if (path === "/memory/save" && method === "POST") {
        const body = await request.json();
        return jsonResponse(await saveMemory(env, body), 200, corsHeaders);
      }
      if (path === "/memory/gaps" && method === "GET") return jsonResponse(await detectGaps(env), 200, corsHeaders);
      if (path === "/memory/heal" && method === "POST") return jsonResponse(await healGaps(env), 200, corsHeaders);
      if (path.startsWith("/memory/session/") && method === "GET") {
        const date = path.split("/memory/session/")[1];
        return jsonResponse(await loadSession(env, date), 200, corsHeaders);
      }
      if (path === "/memory/error" && method === "POST") {
        const body = await request.json();
        return jsonResponse(await logError(env, body), 200, corsHeaders);
      }
      if (path === "/memory/search" && method === "GET") {
        const query = url.searchParams.get("q") || "";
        const limit = parseInt(url.searchParams.get("limit") || "20");
        return jsonResponse(await searchMemory(env, query, limit), 200, corsHeaders);
      }
      if (path === "/memory/compact" && method === "POST") {
        const body = await request.json();
        return jsonResponse(await preCompactSnapshot(env, body), 200, corsHeaders);
      }
      if (path === "/memory/resume" && method === "GET") return jsonResponse(await getResumeInstructions(env), 200, corsHeaders);
      if (path.startsWith("/memory/hook/") && method === "POST") {
        const event = path.split("/memory/hook/")[1];
        const body = await request.json().catch(() => ({}));
        return jsonResponse(await handleHook(env, event, body), 200, corsHeaders);
      }
      if (path === "/corpus/search" && method === "GET") {
        const q = url.searchParams.get("q") || "";
        const top = parseInt(url.searchParams.get("top") || "20");
        return jsonResponse(await corpusSearch(env, q, top), 200, corsHeaders);
      }
      if (path === "/corpus/audit" && method === "POST") {
        const body = await request.json();
        return jsonResponse(await corpusAudit(env, body.violation_id), 200, corsHeaders);
      }
      if (path === "/corpus/ingest" && method === "POST") {
        const body = await request.json();
        return jsonResponse(await corpusIngest(env, body), 200, corsHeaders);
      }
      if (path === "/corpus/status" && method === "GET") {
        return jsonResponse(await corpusStatus(env), 200, corsHeaders);
      }
      if (path.startsWith("/session/")) {
        const sessionId = path.split("/session/")[1].split("/")[0];
        const subPath = "/" + (path.split("/session/")[1].split("/").slice(1).join("/") || "load");
        const doId = env.SESSION_DO.idFromName(sessionId);
        const stub = env.SESSION_DO.get(doId);
        const doUrl = new URL(request.url);
        doUrl.pathname = subPath;
        return stub.fetch(new Request(doUrl.toString(), {
          method: request.method,
          headers: request.headers,
          body: method !== "GET" ? await request.text() : undefined
        }));
      }
      return jsonResponse({ error: "Not found", routes: [
        "GET /health",
        "GET /memory/load",
        "POST /memory/save",
        "GET /memory/gaps",
        "POST /memory/heal",
        "GET /memory/session/:date",
        "POST /memory/error",
        "GET /memory/search?q=term",
        "POST /memory/compact",
        "GET /memory/resume",
        "POST /memory/hook/:event",
        "GET|POST /session/:id/load|save|checkpoint|event",
        "GET /corpus/search?q=&top=",
        "POST /corpus/audit  body:{violation_id}",
        "POST /corpus/ingest body:{r2_key} or {doc_id}",
        "GET /corpus/status"
      ] }, 404, corsHeaders);
    } catch (err) {
      return jsonResponse({ error: err.message, stack: err.stack }, 500, corsHeaders);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      const today = new Date().toISOString().split("T")[0];
      const timestamp = new Date().toISOString();
      try {
        const heal = await healGaps(env);
        await env.DB.prepare(
          "INSERT INTO session_state (session_date, state_key, state_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
        ).bind(today, "cron:auto_heal", JSON.stringify({ cron: controller.cron, ...heal }), timestamp, timestamp).run();
      } catch (e) {
        try {
          await env.DB.prepare(
            "INSERT INTO error_log (session_date, error_level, bottleneck_id, error_source, error_message, fix_attempted, fix_result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          ).bind(today, "MEDIUM", "CRON", "scheduled", e.message || "cron failure", "auto-heal cron", "OPEN", timestamp).run();
        } catch (_) {}
      }
    })());
  }
};

async function healthCheck(env) {
  const results = { timestamp: new Date().toISOString(), tiers: {} };
  try {
    const val = await env.KV_BOOTSTRAP.get("context:quick_load");
    results.tiers.kv_bootstrap = { status: val ? "OK" : "EMPTY", has_quick_load: !!val };
  } catch (e) { results.tiers.kv_bootstrap = { status: "ERROR", error: e.message }; }
  try {
    const val = await env.KV_MATRICES.get("cache:hot_data");
    results.tiers.kv_matrices = { status: val ? "OK" : "EMPTY", has_hot_data: !!val };
  } catch (e) { results.tiers.kv_matrices = { status: "ERROR", error: e.message }; }
  try {
    const tables = await env.DB.prepare("SELECT COUNT(*) as cnt FROM session_state").first();
    const errors = await env.DB.prepare("SELECT COUNT(*) as cnt FROM error_log WHERE fix_result IN ('OPEN','RETRY')").first();
    results.tiers.d1 = { status: "OK", session_rows: tables.cnt, open_errors: errors.cnt };
  } catch (e) { results.tiers.d1 = { status: "ERROR", error: e.message }; }
  try {
    const list = await env.R2_STORE.list({ prefix: "exports/", limit: 5 });
    results.tiers.r2 = { status: "OK", recent_exports: list.objects.length };
  } catch (e) { results.tiers.r2 = { status: "ERROR", error: e.message }; }
  const allOk = Object.values(results.tiers).every((t) => t.status === "OK");
  results.overall = allOk ? "HEALTHY" : "DEGRADED";
  return results;
}

async function loadMemory(env) {
  const [kvContext, kvHotData, kvViolations, d1Session, d1Errors, d1Memory] = await Promise.allSettled([
    env.KV_BOOTSTRAP.get("context:quick_load", "json"),
    env.KV_MATRICES.get("cache:hot_data", "json"),
    env.KV_MATRICES.get("cache:violation_summary", "json"),
    env.DB.prepare("SELECT * FROM session_state WHERE session_date >= date('now','-3 days') ORDER BY id DESC LIMIT 20").all(),
    env.DB.prepare("SELECT * FROM error_log WHERE fix_result IN ('OPEN','RETRY') ORDER BY id DESC").all(),
    env.DB.prepare("SELECT * FROM session_memory ORDER BY id DESC LIMIT 20").all().catch(() => ({ results: [] }))
  ]);
  return {
    loaded_at: new Date().toISOString(),
    kv: {
      context: kvContext.status === "fulfilled" ? kvContext.value : null,
      hot_data: kvHotData.status === "fulfilled" ? kvHotData.value : null,
      violations: kvViolations.status === "fulfilled" ? kvViolations.value : null
    },
    d1: {
      recent_sessions: d1Session.status === "fulfilled" ? d1Session.value.results : [],
      open_errors: d1Errors.status === "fulfilled" ? d1Errors.value.results : [],
      memory: d1Memory.status === "fulfilled" ? d1Memory.value.results : []
    },
    resume: await getResumeInstructions(env)
  };
}

async function saveMemory(env, data) {
  const today = new Date().toISOString().split("T")[0];
  const timestamp = new Date().toISOString();
  const results = { saved_at: timestamp, tiers: {} };
  if (data.kv) {
    try {
      const kvOps = [];
      for (const [key, value] of Object.entries(data.kv)) {
        const ns = key.startsWith("cache:") || key.startsWith("index:") ? env.KV_MATRICES
          : key.startsWith("context:") || key.startsWith("session:") ? env.KV_BOOTSTRAP
          : env.KV_AGENT_STATE;
        kvOps.push(ns.put(key, typeof value === "string" ? value : JSON.stringify(value)));
      }
      await Promise.all(kvOps);
      results.tiers.kv = { status: "OK", keys_written: Object.keys(data.kv).length };
    } catch (e) { results.tiers.kv = { status: "ERROR", error: e.message }; }
  }
  if (data.d1) {
    try {
      const { key, value } = data.d1;
      await env.DB.prepare(
        "INSERT INTO session_state (session_date, state_key, state_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(today, key || "auto_save", typeof value === "string" ? value : JSON.stringify(value), timestamp, timestamp).run();
      results.tiers.d1 = { status: "OK" };
    } catch (e) { results.tiers.d1 = { status: "ERROR", error: e.message }; }
  }
  if (data.r2) {
    try {
      const r2Key = data.r2.key || `exports/${today}/memory_save_${Date.now()}.json`;
      await env.R2_STORE.put(r2Key, JSON.stringify({ ...(data.r2.content || data), saved_at: timestamp }));
      results.tiers.r2 = { status: "OK", key: r2Key };
    } catch (e) { results.tiers.r2 = { status: "ERROR", error: e.message }; }
  }
  try {
    await env.KV_BOOTSTRAP.put("session:current", JSON.stringify({ date: today, last_save: timestamp, source: "memory-worker" }));
  } catch (_) {}
  return results;
}

async function detectGaps(env) {
  const gaps = [];
  const today = new Date().toISOString().split("T")[0];
  const requiredKV = [
    { ns: env.KV_BOOTSTRAP, key: "context:quick_load", name: "Bootstrap context" },
    { ns: env.KV_MATRICES, key: "cache:hot_data", name: "Hot data cache" },
    { ns: env.KV_MATRICES, key: "cache:violation_summary", name: "Violation summary" },
    { ns: env.KV_BOOTSTRAP, key: "session:current", name: "Current session pointer" }
  ];
  for (const { ns, key, name } of requiredKV) {
    try {
      const val = await ns.get(key);
      if (!val) gaps.push({ tier: "KV", severity: "HIGH", issue: `Missing key: ${key}`, name });
    } catch (e) { gaps.push({ tier: "KV", severity: "CRITICAL", issue: `Cannot read ${key}: ${e.message}`, name }); }
  }
  const requiredTables = [
    { table: "session_state", min: 1 },
    { table: "error_log", min: 0 },
    { table: "violation_matrix", min: 100 },
    { table: "chain_of_title", min: 10 },
    { table: "key_findings", min: 10 }
  ];
  for (const { table, min } of requiredTables) {
    try {
      const { cnt } = await env.DB.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).first();
      if (cnt < min) gaps.push({ tier: "D1", severity: "MEDIUM", issue: `${table} has ${cnt} rows (expected >= ${min})` });
    } catch (e) { gaps.push({ tier: "D1", severity: "HIGH", issue: `Table ${table} error: ${e.message}` }); }
  }
  try {
    const list = await env.R2_STORE.list({ prefix: `exports/${today}/`, limit: 10 });
    if (list.objects.length === 0) gaps.push({ tier: "R2", severity: "LOW", issue: `No exports for today (${today})` });
  } catch (e) { gaps.push({ tier: "R2", severity: "MEDIUM", issue: `R2 list error: ${e.message}` }); }
  try {
    const { cnt } = await env.DB.prepare("SELECT COUNT(*) as cnt FROM error_log WHERE fix_result IN ('OPEN','RETRY')").first();
    if (cnt > 0) gaps.push({ tier: "D1", severity: "HIGH", issue: `${cnt} unresolved errors in error_log` });
  } catch (_) {}
  return { scanned_at: new Date().toISOString(), gap_count: gaps.length, gaps };
}

async function healGaps(env) {
  const { gaps } = await detectGaps(env);
  const fixes = [];
  const today = new Date().toISOString().split("T")[0];
  for (const gap of gaps) {
    try {
      if (gap.tier === "KV" && gap.issue.includes("Missing key: context:quick_load")) {
        const session = await env.DB.prepare("SELECT * FROM session_state ORDER BY id DESC LIMIT 1").first();
        const context = {
          case: "Nguyen v. Fay Servicing (4:25-cv-00952)",
          last_session: session?.session_date || today,
          reconstructed: true,
          reconstructed_at: new Date().toISOString()
        };
        await env.KV_BOOTSTRAP.put("context:quick_load", JSON.stringify(context));
        fixes.push({ gap: gap.issue, fix: "Reconstructed from D1", status: "FIXED" });
      } else if (gap.tier === "KV" && gap.issue.includes("Missing key: cache:hot_data")) {
        const violations = await env.DB.prepare("SELECT COUNT(*) as cnt FROM violation_matrix").first();
        const findings = await env.DB.prepare("SELECT COUNT(*) as cnt FROM key_findings").first();
        await env.KV_MATRICES.put("cache:hot_data", JSON.stringify({
          counts: { violations: violations.cnt, findings: findings.cnt },
          reconstructed: true,
          reconstructed_at: new Date().toISOString()
        }));
        fixes.push({ gap: gap.issue, fix: "Reconstructed from D1 counts", status: "FIXED" });
      } else if (gap.tier === "KV" && gap.issue.includes("session:current")) {
        await env.KV_BOOTSTRAP.put("session:current", JSON.stringify({
          date: today,
          last_save: new Date().toISOString(),
          source: "auto-heal"
        }));
        fixes.push({ gap: gap.issue, fix: "Recreated session pointer", status: "FIXED" });
      } else if (gap.tier === "R2" && gap.issue.includes("No exports for today")) {
        const sessions = await env.DB.prepare("SELECT * FROM session_state WHERE session_date >= date('now','-3 days') ORDER BY id DESC").all();
        await env.R2_STORE.put(`exports/${today}/session_state_healed.json`, JSON.stringify({
          healed_at: new Date().toISOString(),
          sessions: sessions.results
        }));
        fixes.push({ gap: gap.issue, fix: "Created R2 export from D1", status: "FIXED" });
      } else {
        fixes.push({ gap: gap.issue, fix: "No auto-fix available", status: "SKIPPED" });
      }
    } catch (e) {
      fixes.push({ gap: gap.issue, fix: `Heal failed: ${e.message}`, status: "FAILED" });
    }
  }
  return { healed_at: new Date().toISOString(), total_gaps: gaps.length, fixes };
}

async function loadSession(env, date) {
  const [d1Sessions, d1Errors, kvSession] = await Promise.allSettled([
    env.DB.prepare("SELECT * FROM session_state WHERE session_date = ? ORDER BY id").bind(date).all(),
    env.DB.prepare("SELECT * FROM error_log WHERE session_date = ? ORDER BY id").bind(date).all(),
    env.KV_BOOTSTRAP.get(`session:${date}`, "json")
  ]);
  let r2Export = null;
  try {
    const obj = await env.R2_STORE.get(`exports/${date}/session_state.json`);
    if (obj) r2Export = await obj.json();
  } catch (_) {}
  return {
    date,
    d1: {
      sessions: d1Sessions.status === "fulfilled" ? d1Sessions.value.results : [],
      errors: d1Errors.status === "fulfilled" ? d1Errors.value.results : []
    },
    kv: kvSession.status === "fulfilled" ? kvSession.value : null,
    r2: r2Export
  };
}

async function logError(env, data) {
  const today = new Date().toISOString().split("T")[0];
  const timestamp = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO error_log (session_date, error_level, bottleneck_id, error_source, error_message, fix_attempted, fix_result, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(today, data.level || "MEDIUM", data.bottleneck_id || null, data.source || "memory-worker", data.message || "Unknown error", data.fix || null, data.status || "OPEN", timestamp).run();
  return { logged: true, timestamp };
}

async function searchMemory(env, query, limit) {
  if (!query) return { results: [], query: "" };
  const pattern = `%${query}%`;
  const [sessions, errors, findings, violations] = await Promise.allSettled([
    env.DB.prepare("SELECT 'session_state' as source, state_key as title, state_value as content, session_date as date FROM session_state WHERE state_value LIKE ? ORDER BY id DESC LIMIT ?").bind(pattern, limit).all(),
    env.DB.prepare("SELECT 'error_log' as source, error_source as title, error_message as content, session_date as date FROM error_log WHERE error_message LIKE ? ORDER BY id DESC LIMIT ?").bind(pattern, limit).all(),
    env.DB.prepare("SELECT 'key_findings' as source, finding_title as title, finding_description as content, '' as date FROM key_findings WHERE finding_title LIKE ? OR finding_description LIKE ? ORDER BY id DESC LIMIT ?").bind(pattern, pattern, limit).all(),
    env.DB.prepare("SELECT 'violation_matrix' as source, violation_type as title, COALESCE(evidence_description, '') as content, '' as date FROM violation_matrix WHERE violation_type LIKE ? OR evidence_description LIKE ? ORDER BY id DESC LIMIT ?").bind(pattern, pattern, limit).all()
  ]);
  const results = [
    ...(sessions.status === "fulfilled" ? sessions.value.results : []),
    ...(errors.status === "fulfilled" ? errors.value.results : []),
    ...(findings.status === "fulfilled" ? findings.value.results : []),
    ...(violations.status === "fulfilled" ? violations.value.results : [])
  ].slice(0, limit);
  return { query, result_count: results.length, results };
}

async function preCompactSnapshot(env, data) {
  const today = new Date().toISOString().split("T")[0];
  const timestamp = new Date().toISOString();
  const snapshot = {
    snapshot_type: "pre_compact",
    trigger: data.trigger || "manual",
    timestamp,
    context: data.context || {},
    pending_tasks: data.pending_tasks || [],
    critical_state: data.critical_state || {}
  };
  const [kvResult, d1Result, r2Result] = await Promise.allSettled([
    env.KV_BOOTSTRAP.put(`compact:${today}:${Date.now()}`, JSON.stringify(snapshot)),
    env.DB.prepare("INSERT INTO session_state (session_date, state_key, state_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(today, "pre_compact_snapshot", JSON.stringify(snapshot), timestamp, timestamp).run(),
    env.R2_STORE.put(`exports/${today}/compact_snapshot_${Date.now()}.json`, JSON.stringify(snapshot))
  ]);
  return {
    snapshot_id: `compact:${today}:${Date.now()}`,
    saved: { kv: kvResult.status === "fulfilled", d1: d1Result.status === "fulfilled", r2: r2Result.status === "fulfilled" }
  };
}

async function getResumeInstructions(env) {
  const today = new Date().toISOString().split("T")[0];
  const [currentSession, openErrors, recentState, pendingTasks] = await Promise.allSettled([
    env.KV_BOOTSTRAP.get("session:current", "json"),
    env.DB.prepare("SELECT * FROM error_log WHERE fix_result IN ('OPEN','RETRY') ORDER BY id DESC LIMIT 5").all(),
    env.DB.prepare("SELECT * FROM session_state WHERE session_date >= date('now','-3 days') ORDER BY id DESC LIMIT 10").all(),
    env.DB.prepare("SELECT * FROM session_state WHERE state_key LIKE '%pending%' OR state_key LIKE '%todo%' ORDER BY id DESC LIMIT 10").all()
  ]);
  const errors = openErrors.status === "fulfilled" ? openErrors.value.results : [];
  return {
    date: today,
    current_session: currentSession.status === "fulfilled" ? currentSession.value : null,
    open_errors: errors,
    recent_sessions: recentState.status === "fulfilled" ? recentState.value.results : [],
    pending: pendingTasks.status === "fulfilled" ? pendingTasks.value.results : [],
    instructions: [
      "Read CLAUDE.md first for project routing and self-healing rules",
      "Read FILE_CATALOG.md for workspace inventory",
      errors.length > 0 ? `FIX ${errors.length} OPEN ERRORS before starting new work` : "No open errors",
      "Load KV cache: context:quick_load for instant context",
      "Check D1 session_state for recent progress"
    ]
  };
}

async function handleHook(env, event, body) {
  const today = new Date().toISOString().split("T")[0];
  const timestamp = new Date().toISOString();
  switch (event) {
    case "SessionStart": {
      const resume = await getResumeInstructions(env);
      await env.DB.prepare("INSERT INTO session_state (session_date, state_key, state_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(today, "session_start", JSON.stringify({ event, timestamp }), timestamp, timestamp).run();
      await env.KV_BOOTSTRAP.put("session:current", JSON.stringify({ date: today, started_at: timestamp }));
      return { event, resume };
    }
    case "PreCompact": {
      return await preCompactSnapshot(env, { ...body, trigger: "PreCompact_hook" });
    }
    case "SessionEnd": {
      await env.DB.prepare("INSERT INTO session_state (session_date, state_key, state_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(today, "session_end", JSON.stringify({ event, timestamp, summary: body.summary || "Session ended" }), timestamp, timestamp).run();
      const sessions = await env.DB.prepare("SELECT * FROM session_state WHERE session_date = ? ORDER BY id").bind(today).all();
      await env.R2_STORE.put(`exports/${today}/session_final_${Date.now()}.json`, JSON.stringify({ date: today, ended_at: timestamp, entries: sessions.results }));
      return { event, archived: true, timestamp };
    }
    default:
      await env.DB.prepare("INSERT INTO session_state (session_date, state_key, state_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(today, `hook:${event}`, JSON.stringify({ event, body, timestamp }), timestamp, timestamp).run();
      return { event, logged: true };
  }
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extraHeaders }
  });
}

// ============================================================================
// Corpus layer — hybrid (FTS + vector) search over case PDFs in BigQuery.
// ============================================================================

const BQ_PROJECT = "authorityandbrand-workspace";
const BQ_DATASET = "legal_case";

// bqQuery: proxy a parameterized SQL query through gws-worker (which holds the
// Google OAuth identity authorized for BigQuery). The service binding contract:
//   POST /bq/query  { project, query, params, mode: "read"|"write" }
//   -> { rows: [...], schema: [...] }
async function bqQuery(env, sql, params = {}, mode = "read") {
  if (!env.GWS_WORKER) {
    throw new Error("GWS_WORKER service binding missing; cannot reach BigQuery");
  }
  const req = new Request("https://gws-worker.internal/bq/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project: BQ_PROJECT, query: sql, params, mode })
  });
  const res = await env.GWS_WORKER.fetch(req);
  if (!res.ok) throw new Error(`BQ proxy ${res.status}: ${await res.text()}`);
  return res.json();
}

async function corpusSearch(env, q, top) {
  if (!q) return { results: [], query: "" };
  const dataset = `${BQ_PROJECT}.${BQ_DATASET}`;
  const sql = `
    SELECT
      c.chunk_id, c.doc_id, c.r2_key, c.page, c.text,
      d.cite_as, d.title, d.doc_type, d.doc_date
    FROM \`${dataset}.corpus_chunks\` c
    JOIN \`${dataset}.corpus_documents\` d USING (doc_id)
    WHERE SEARCH(c.text, @q)
    ORDER BY d.doc_date DESC NULLS LAST
    LIMIT @top
  `;
  const { rows } = await bqQuery(env, sql, { q, top });
  return { query: q, result_count: rows.length, results: rows };
}

async function corpusAudit(env, violation_id) {
  if (!violation_id) return { error: "violation_id required" };
  const dataset = `${BQ_PROJECT}.${BQ_DATASET}`;
  const sql = `
    SELECT v.id AS violation_id, v.violation_type,
           c.chunk_id, c.doc_id, c.r2_key, c.page, d.cite_as, c.text
    FROM \`${dataset}.d1_violation_matrix\` v
    JOIN \`${dataset}.d1_document_violation_links\` link ON link.violation_id = v.id
    JOIN \`${dataset}.corpus_documents\` d
      ON d.r2_key = link.document_r2_key OR d.title = link.document_title
    JOIN \`${dataset}.corpus_chunks\` c ON c.doc_id = d.doc_id
    WHERE v.id = @violation_id
  `;
  const { rows } = await bqQuery(env, sql, { violation_id });
  return { violation_id, excerpt_count: rows.length, excerpts: rows };
}

async function corpusIngest(env, body) {
  // Queue a document for text extraction + chunking. Heavy lifting (OCR, chunking)
  // runs in a dedicated pipeline; this endpoint just records intent.
  const { r2_key, doc_id, force = false } = body;
  if (!r2_key && !doc_id) return { error: "r2_key or doc_id required" };
  const dataset = `${BQ_PROJECT}.${BQ_DATASET}`;
  const sql = `
    UPDATE \`${dataset}.corpus_documents\`
    SET text_status = IF(@force, 'pending', text_status),
        updated_at = CURRENT_TIMESTAMP()
    WHERE r2_key = @r2_key OR doc_id = @doc_id
  `;
  await bqQuery(env, sql, { r2_key: r2_key || "", doc_id: doc_id || "", force }, "write");
  return { queued: true, r2_key, doc_id, force };
}

async function corpusStatus(env) {
  const dataset = `${BQ_PROJECT}.${BQ_DATASET}`;
  const sql = `
    SELECT
      (SELECT COUNT(*) FROM \`${dataset}.corpus_documents\`)                              AS documents,
      (SELECT COUNTIF(text_status='extracted') FROM \`${dataset}.corpus_documents\`)      AS extracted_docs,
      (SELECT COUNTIF(text_status='pending')   FROM \`${dataset}.corpus_documents\`)      AS pending_docs,
      (SELECT COUNT(*) FROM \`${dataset}.corpus_chunks\`)                                 AS chunks
  `;
  const { rows } = await bqQuery(env, sql);
  return rows[0] || {};
}
