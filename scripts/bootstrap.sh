#!/usr/bin/env bash
# Bootstrap SHODH on Cloudflare from a fresh Cloudflare account.
#
# Idempotent: safe to re-run after a partial failure. Each step checks
# whether the resource already exists before creating it.
#
# Prereqs: node >= 18, npm, wrangler (npm i -g wrangler), and
# `wrangler login` already completed.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="${REPO_ROOT}/worker"
SCHEMA_FILE="${REPO_ROOT}/schema.sql"
WRANGLER_TOML="${WORKER_DIR}/wrangler.toml"
WRANGLER_TOML_EXAMPLE="${WORKER_DIR}/wrangler.toml.example"

D1_NAME="${SHODH_D1_NAME:-shodh-memory}"
VECTORIZE_NAME="${SHODH_VECTORIZE_NAME:-shodh-vectors}"
VECTORIZE_DIMS="${SHODH_VECTORIZE_DIMS:-384}"
VECTORIZE_METRIC="${SHODH_VECTORIZE_METRIC:-cosine}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

require() {
  command -v "$1" >/dev/null 2>&1 || err "Missing required command: $1"
}

step_prereqs() {
  log "Checking prerequisites"
  require node
  require npm
  require npx
  # Prefer globally installed wrangler, fall back to npx.
  if ! command -v wrangler >/dev/null 2>&1; then
    warn "wrangler not on PATH; using 'npx wrangler' instead"
    WRANGLER=(npx --yes wrangler)
  else
    WRANGLER=(wrangler)
  fi
  "${WRANGLER[@]}" whoami >/dev/null \
    || err "wrangler is not logged in. Run 'wrangler login' first."
  [[ -f "${WRANGLER_TOML_EXAMPLE}" ]] \
    || err "Missing ${WRANGLER_TOML_EXAMPLE}"
  [[ -f "${SCHEMA_FILE}" ]] || err "Missing ${SCHEMA_FILE}"
}

step_d1() {
  log "Ensuring D1 database '${D1_NAME}' exists"
  local list_json
  list_json="$("${WRANGLER[@]}" d1 list --json 2>/dev/null || echo '[]')"
  D1_DATABASE_ID="$(node -e "
    const d=JSON.parse(process.argv[1]||'[]');
    const m=d.find(x=>x.name===process.argv[2]);
    if(m) process.stdout.write(m.uuid||m.id||'');" "$list_json" "$D1_NAME")"

  if [[ -z "${D1_DATABASE_ID}" ]]; then
    log "Creating D1 database '${D1_NAME}'"
    "${WRANGLER[@]}" d1 create "${D1_NAME}" >/dev/null
    list_json="$("${WRANGLER[@]}" d1 list --json)"
    D1_DATABASE_ID="$(node -e "
      const d=JSON.parse(process.argv[1]||'[]');
      const m=d.find(x=>x.name===process.argv[2]);
      if(m) process.stdout.write(m.uuid||m.id||'');" "$list_json" "$D1_NAME")"
  fi
  [[ -n "${D1_DATABASE_ID}" ]] \
    || err "Failed to resolve D1 database ID for '${D1_NAME}'"
  log "D1 database ID: ${D1_DATABASE_ID}"
}

step_vectorize() {
  log "Ensuring Vectorize index '${VECTORIZE_NAME}' exists"
  if "${WRANGLER[@]}" vectorize list 2>/dev/null \
       | grep -qE "(^|[[:space:]])${VECTORIZE_NAME}([[:space:]]|$)"; then
    log "Vectorize index '${VECTORIZE_NAME}' already present"
  else
    log "Creating Vectorize index '${VECTORIZE_NAME}' (${VECTORIZE_DIMS}d, ${VECTORIZE_METRIC})"
    "${WRANGLER[@]}" vectorize create "${VECTORIZE_NAME}" \
      --dimensions="${VECTORIZE_DIMS}" \
      --metric="${VECTORIZE_METRIC}"
  fi
}

step_wrangler_toml() {
  log "Materializing worker/wrangler.toml"
  if [[ -f "${WRANGLER_TOML}" ]]; then
    log "worker/wrangler.toml already exists; leaving as-is"
    return
  fi
  # Replace placeholder with the real D1 database ID.
  sed "s|YOUR_D1_DATABASE_ID|${D1_DATABASE_ID}|g" \
    "${WRANGLER_TOML_EXAMPLE}" > "${WRANGLER_TOML}"
  log "Wrote ${WRANGLER_TOML}"
}

step_schema() {
  log "Applying schema.sql to remote '${D1_NAME}'"
  (cd "${WORKER_DIR}" && "${WRANGLER[@]}" d1 execute "${D1_NAME}" \
    --file "${SCHEMA_FILE}" --remote)
}

step_secret() {
  log "Ensuring API_KEY secret is set"
  if (cd "${WORKER_DIR}" && "${WRANGLER[@]}" secret list 2>/dev/null \
        | grep -q '"name": "API_KEY"'); then
    log "API_KEY already set; skipping"
    return
  fi
  if [[ -n "${SHODH_API_KEY:-}" ]]; then
    log "Setting API_KEY from SHODH_API_KEY environment variable"
    printf '%s' "${SHODH_API_KEY}" \
      | (cd "${WORKER_DIR}" && "${WRANGLER[@]}" secret put API_KEY)
  else
    warn "SHODH_API_KEY env var not set; wrangler will prompt interactively"
    (cd "${WORKER_DIR}" && "${WRANGLER[@]}" secret put API_KEY)
  fi
}

step_deploy() {
  log "Installing worker dependencies"
  (cd "${WORKER_DIR}" && npm install)
  log "Deploying worker"
  (cd "${WORKER_DIR}" && npm run deploy)
}

step_summary() {
  log "Done."
  cat <<EOF

Next steps:
  1. Note your Worker URL from the deploy output above.
  2. Run ./scripts/verify-installation.sh to smoke-test.
  3. Add this device to Claude Desktop: ./scripts/setup-client.sh

Claude Desktop MCP config skeleton:
  {
    "mcpServers": {
      "shodh-cloudflare": {
        "command": "node",
        "args": ["\$(pwd)/mcp-bridge/index.js"],
        "env": {
          "SHODH_CLOUDFLARE_URL": "https://<your-worker>.workers.dev",
          "SHODH_CLOUDFLARE_API_KEY": "<your-api-key>"
        }
      }
    }
  }
EOF
}

main() {
  step_prereqs
  step_d1
  step_vectorize
  step_wrangler_toml
  step_schema
  step_secret
  step_deploy
  step_summary
}

main "$@"
