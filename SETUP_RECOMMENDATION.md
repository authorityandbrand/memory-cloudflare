# Cloudflare Memory — Setup Decision Record

Date: 2026-04-22
Branch: `claude/cloudflare-memory-setup-oDrJu`

## Decision

Use **`memory-cloudflare` (SHODH on Cloudflare)** as our primary AI memory system.

Deployment surface: Cloudflare Workers + D1 + Vectorize + Workers AI.
Client surface: MCP bridge (`mcp-bridge/index.js`) used by Claude Desktop,
Claude Code, and Gemini clients.

## Options considered

Four repositories were evaluated against the goal “a memory system for our
Cloudflare setup”:

| Repo | Stack | Fit |
|------|-------|-----|
| `memory-cloudflare` (this repo) | Workers + D1 + Vectorize + Workers AI + MCP bridge | Chosen — built for exactly this |
| `d1-rest` | Workers + D1 REST API + “Brain API” + NotebookLM + agent webhooks | Larger platform; memory is one of many features. Reconsider if we need the full autonomous-agent surface. |
| `zettelkasten-mcp` | Python + local SQLite + Markdown files | Rejected — cannot run on Cloudflare Workers |
| `andrej-karpathy-skills` | `CLAUDE.md` coding principles plugin | Rejected — not a memory system |

## Why `memory-cloudflare`

1. **All-Cloudflare stack, already wired.** `worker/wrangler.toml.example`
   already declares D1 (`shodh-memory`), Vectorize (`shodh-vectors`, 384
   dims, cosine), and Workers AI bindings.
2. **Semantic search out of the box.** Embeddings via
   `@cf/baai/bge-small-en-v1.5` (384d); classification/summarization via
   `@cf/meta/llama-3.1-8b-instruct`.
3. **Edge latency.** <50ms from any Cloudflare PoP, no single-region
   bottleneck — matches our distributed client footprint.
4. **MCP-native.** 13 tools ready for Claude Desktop / Claude Code /
   Cursor / Gemini: `remember`, `batch_remember`, `recall`,
   `recall_by_tags`, `proactive_context`, `list_memories`, `forget`,
   `forget_by_tags`, `update_memory`, `reinforce_memory`, `memory_stats`,
   `context_summary`, `consolidate`.
5. **Feature set matches how we actually use memory.** Natural-language
   temporal queries (EN/DE, 65+ patterns), AI summarization for voice
   recall, batch ingestion, custom timestamps, quality-score
   reinforcement, tag/emotion/episodic metadata, OpenAPI 3.1 compliant.
6. **Deploy scripts already exist.** `scripts/verify-installation.sh` and
   `scripts/setup-client.sh` cover per-device onboarding; the missing
   piece was a one-shot “deploy the Worker from scratch” script, which
   this PR adds as `scripts/bootstrap.sh`.

## When we would revisit

- If we want the autonomous “Brain API” (learned patterns, decision log,
  gap analysis) from `d1-rest` as a layer *on top of* SHODH memory, we
  can wire the two together — SHODH stores the raw memories, `d1-rest`
  stores derived patterns/decisions. They do not conflict.
- If semantic search on bge-small-en-v1.5 (384d) proves insufficient
  for longer-form content, upgrade to a 768d model and re-create the
  Vectorize index (destructive, requires re-embedding).

## How to deploy

From repo root, on a machine with `wrangler` logged in to our Cloudflare
account:

```bash
./scripts/bootstrap.sh
```

The script:
1. Checks prerequisites (`node`, `npm`, `wrangler`, `wrangler whoami`).
2. Creates `shodh-memory` D1 database (idempotent).
3. Creates `shodh-vectors` Vectorize index (384d, cosine, idempotent).
4. Writes `worker/wrangler.toml` from the example, substituting the D1
   database ID.
5. Applies `schema.sql` to the remote D1 database.
6. Prompts for and stores the `API_KEY` secret (only if not already set).
7. Installs worker dependencies and deploys.
8. Prints the deployed Worker URL and a ready-to-paste Claude Desktop
   MCP config block.

After deploy, run `./scripts/verify-installation.sh` to sanity-check.

## Follow-ups (not in this PR)

- [ ] Provision the Cloudflare D1/Vectorize resources by running
      `scripts/bootstrap.sh` against our account.
- [ ] Record the Worker URL and API key in our secret manager.
- [ ] Roll MCP bridge config out to each developer machine via
      `scripts/setup-client.sh`.
- [ ] Decide whether `d1-rest` Brain API gets wired on top as a
      pattern/decision layer.
