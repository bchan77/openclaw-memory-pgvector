#!/usr/bin/env bash
# Install/setup script for openclaw-memory-pgvector.
#
# This script:
#   1. Checks prerequisites (Node, OpenClaw, optional Postgres reachability)
#   2. Builds this repo (npm install, npm run build)
#   3. Optionally runs the migration (--migrate)
#   4. If migrating without DATABASE_URL/--pg: prompts for host, port, database, user, password (and schema), tests connectivity, then migrates
#   5. Prints OpenClaw config you can add when a Postgres memory backend is available
#
# OpenClaw does not yet have a built-in "use Postgres for memory" backend. After
# running this script and migration, your index data lives in Postgres; you can
# query it from other tools. When OpenClaw gains memory.backend = "postgres" (or
# equivalent), use the printed config to point at your database.
#
# Usage:
#   ./scripts/install.sh [--migrate] [--agent-id ID] [--schema NAME] [--pg URL]
#   DATABASE_URL=postgresql://... ./scripts/install.sh --migrate

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

RUN_MIGRATE=""
AGENT_ID="main"
SCHEMA="public"
PG_URL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --migrate)    RUN_MIGRATE=true; shift ;;
    --no-migrate) RUN_MIGRATE=false; shift ;;
    --agent-id)   AGENT_ID="$2"; shift 2 ;;
    --schema)     SCHEMA="$2"; shift 2 ;;
    --pg)         PG_URL="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--migrate | --no-migrate] [--agent-id ID] [--schema NAME] [--pg URL]"
      echo ""
      echo "  --migrate     Run migration after build (or prompt if neither --migrate nor --no-migrate)."
      echo "  --no-migrate  Skip migration. If neither flag is given, you will be asked after build."
      echo "  --agent-id   Agent id for default SQLite path (default: main)"
      echo "  --schema     Postgres schema for migration (default: public)"
      echo "  --pg URL     Postgres connection URL (alternative to DATABASE_URL)"
      echo ""
      echo "If migration fails, the script rolls back created tables and exits with an error."
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

echo "=== openclaw-memory-pgvector install ==="
echo ""

# Node (required 20+)
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required (node not found). Install Node 20+ and retry."
  exit 1
fi
NODE_VER=$(node -p 'process.versions.node')
NODE_MAJOR=$(node -p 'parseInt(process.versions.node.split(".")[0], 10)')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Error: Node.js 20+ is required (found $NODE_VER). Upgrade Node and retry."
  exit 1
fi
echo "  Node: $NODE_VER"

# OpenClaw (optional but useful to mention)
if command -v openclaw >/dev/null 2>&1; then
  echo "  OpenClaw: $(openclaw --version 2>/dev/null || echo 'installed')"
else
  echo "  OpenClaw: not in PATH (optional for migration; required to run the agent)"
fi

# Build
echo ""
echo "=== Building repo ==="
npm install --no-audit --no-fund
if ! node -e "require('pg'); require('pgvector');" 2>/dev/null; then
  echo "Error: Postgres drivers (pg, pgvector) could not be loaded after npm install. Check build logs and install system deps if needed (e.g. build-essential, libpq-dev)."
  exit 1
fi
echo "  Postgres drivers: OK"
npm run build
echo "  Build OK."
echo ""

# Ask about migration if not specified
if [ "$RUN_MIGRATE" = "" ]; then
  read -r -p "Run migration after build? (y/n) [n]: " DO_MIGRATE
  case "${DO_MIGRATE:-n}" in
    y|Y|yes|YES) RUN_MIGRATE=true ;;
    *)            RUN_MIGRATE=false ;;
  esac
fi

# Optional migration: resolve DATABASE_URL, prompt if needed, test connection, then migrate (with rollback on failure)
if [ "$RUN_MIGRATE" = true ]; then
  echo ""
  echo "=== Postgres connection ==="
  if [ -n "$PG_URL" ]; then
    export DATABASE_URL="$PG_URL"
  fi
  if [ -z "${DATABASE_URL:-}" ]; then
    echo "No DATABASE_URL or --pg provided. Enter Postgres connection details (optional schema for migration)."
    echo ""
    # Disable history expansion so passwords (or values) containing ! are read literally
    set +H
    read -r -p "Host [localhost]: " PGHOST
    PGHOST=${PGHOST:-localhost}
    read -r -p "Port [5432]: " PGPORT
    PGPORT=${PGPORT:-5432}
    read -r -p "Database: " PGDATABASE
    read -r -p "Username: " PGUSER
    read -r -s -p "Password: " PGPASSWORD
    echo ""
    if [ -z "$PGDATABASE" ] || [ -z "$PGUSER" ]; then
      echo "Error: Database and Username are required."
      exit 1
    fi
    read -r -p "Schema for migration [public]: " PGSCHEMA_PROMPT
    if [ -n "$PGSCHEMA_PROMPT" ]; then
      SCHEMA="$PGSCHEMA_PROMPT"
    fi
    export PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD
    DATABASE_URL=$(node -e "
      const enc = encodeURIComponent;
      const h = process.env.PGHOST || 'localhost';
      const pt = process.env.PGPORT || '5432';
      const d = process.env.PGDATABASE || '';
      const u = process.env.PGUSER || '';
      const p = (process.env.PGPASSWORD || '');
      if (!d || !u) { console.error('Database and Username required'); process.exit(1); }
      console.log('postgresql://' + enc(u) + ':' + enc(p) + '@' + h + ':' + pt + '/' + enc(d));
    ")
    export DATABASE_URL
    unset PGPASSWORD
  fi

  echo "Testing connection..."
  if ! node dist/scripts/test-pg-connection.js; then
    echo "Cannot connect to Postgres. Fix the URL or connection and retry."
    exit 1
  fi
  echo ""

  echo "=== Running migration ==="
  if ! node dist/scripts/migrate-sqlite-to-pgvector.js \
    --agent-id "$AGENT_ID" \
    --schema "$SCHEMA" \
    --pg "$DATABASE_URL"; then
    echo ""
    echo "Migration failed. Rolling back (dropping created tables)..."
    if node dist/scripts/rollback-pg.js --pg "$DATABASE_URL" --schema "$SCHEMA"; then
      echo "Rollback complete."
    else
      echo "Rollback encountered errors; you may need to drop tables manually in schema: $SCHEMA"
    fi
    exit 1
  fi
  echo ""

  # Install plugin and set OpenClaw config (if openclaw is in PATH and we have DATABASE_URL)
  # Set plugin entry config first so validation passes when we run "plugins install --link".
  if [ -n "${DATABASE_URL:-}" ] && command -v openclaw >/dev/null 2>&1; then
    echo "=== Installing memory-pgvector plugin and configuring OpenClaw ==="
    CONFIG_FAILED=""
    if ! openclaw config set 'plugins.entries.memory-pgvector.config.databaseUrl' "$DATABASE_URL" 2>&1; then
      CONFIG_FAILED=1
    fi
    if [ -z "$CONFIG_FAILED" ] && [ "$SCHEMA" != "public" ]; then
      if ! openclaw config set 'plugins.entries.memory-pgvector.config.schema' "$SCHEMA" 2>&1; then
        CONFIG_FAILED=1
      fi
    fi
    if [ -n "${OPENAI_API_KEY:-}" ] && [ -z "$CONFIG_FAILED" ]; then
      if ! openclaw config set 'plugins.entries.memory-pgvector.config.embedding.apiKey' "$OPENAI_API_KEY" 2>&1; then
        : # optional; user can set in UI or later
      fi
    else
      # Schema requires embedding.apiKey; set placeholder so "plugins install --link" validation passes
      openclaw config set 'plugins.entries.memory-pgvector.config.embedding.apiKey' '' 2>/dev/null || true
    fi
    if ! openclaw plugins install "$REPO_ROOT" --link 2>&1; then
      echo "  Could not link plugin; you may need to run: openclaw plugins install $REPO_ROOT --link"
    else
      echo "  Plugin linked (plugins.load.paths)."
    fi
    if [ -z "$CONFIG_FAILED" ]; then
      if ! openclaw config set plugins.slots.memory memory-pgvector 2>&1; then
        CONFIG_FAILED=1
      fi
    fi
    if [ -n "$CONFIG_FAILED" ]; then
      echo "  Could not set plugin config. Run manually:"
      echo "    openclaw config set plugins.slots.memory memory-pgvector"
      echo "    openclaw config set plugins.entries.memory-pgvector.config.databaseUrl \"<url>\""
      echo "    openclaw config set plugins.entries.memory-pgvector.config.schema \"$SCHEMA\""
      echo "    openclaw config set plugins.entries.memory-pgvector.config.embedding.apiKey \"<openai-key>\""
    else
      echo "  Set plugins.slots.memory=memory-pgvector and plugin config (databaseUrl, schema)."
      echo "  Set plugins.entries.memory-pgvector.config.embedding.apiKey if not already set (e.g. OPENAI_API_KEY)."
    fi
    echo ""
  elif [ -n "${DATABASE_URL:-}" ]; then
    echo "OpenClaw not in PATH; install the plugin and set config so memory uses Postgres:"
    echo "  openclaw plugins install $REPO_ROOT --link"
    echo "  openclaw config set plugins.slots.memory memory-pgvector"
    echo "  openclaw config set plugins.entries.memory-pgvector.config.databaseUrl \"<url>\""
    echo "  openclaw config set plugins.entries.memory-pgvector.config.embedding.apiKey \"<openai-key>\""
    echo ""
  fi
fi

# Reminder if we didn't migrate
if [ "$RUN_MIGRATE" != true ]; then
  echo "Skipped migration. Run with --migrate to copy SQLite memory to Postgres and configure OpenClaw."
  echo ""
fi

echo "=== Done ==="
