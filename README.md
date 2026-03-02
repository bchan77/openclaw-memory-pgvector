# openclaw-memory-pgvector

**BETA** — This plugin is still in beta and may not work in all environments. Use at your own risk.

OpenClaw **memory plugin** backed by PostgreSQL or YugabyteDB (pgvector) for semantic memory search. Use the plugin and OpenClaw uses Postgres for memory at runtime; no migration required unless you want to copy existing SQLite memory into Postgres.

## Installation (use the plugin)

Build the repo and run the install script. It links the plugin and configures OpenClaw to use it. You need a Postgres (or YugabyteDB) database with the pgvector extension and a connection URL.

```bash
git clone https://github.com/YOUR_ORG/openclaw-memory-pgvector.git
cd openclaw-memory-pgvector
chmod +x scripts/install.sh
./scripts/install.sh
```

The script does not run migration by default. After it runs, set the plugin embedding config if needed (e.g. `plugins.entries.memory-pgvector.config.embedding.apiKey`), then restart the gateway.

**Optional: migrate existing SQLite memory** — If you already have an OpenClaw SQLite index and want that data in Postgres, run with `--migrate` or answer **y** when prompted. Use `--no-migrate` to skip. Examples:

```bash
DATABASE_URL="postgresql://user:pass@localhost:5432/openclaw" ./scripts/install.sh --migrate
# or: ./scripts/install.sh --migrate --pg "postgresql://..."
```

If migration fails, the script rolls back (drops the tables it created). Manual rollback: `npm run rollback:pg -- --pg "postgresql://..." --schema openclaw_memory`.


## Migration: SQLite → Postgres (pgvector)

Use this when you want to move from the default SQLite memory index to a Postgres or YugabyteDB store (e.g. for shared access, scaling, or existing Postgres infra).

### Prerequisites

- Node 20+
- PostgreSQL (or YugabyteDB) with the [pgvector](https://github.com/pgvector/pgvector) extension
- An existing OpenClaw SQLite memory index (e.g. `~/.openclaw/memory/main.sqlite`)

### Install

```bash
cd openclaw-memory-pgvector
npm install
npm run build
```

### Usage

The `--` before options is required so npm passes them to the migrate script (e.g. `--sqlite`, `--pg`) instead of interpreting them itself.

```bash
# Using default paths (~/.openclaw/memory/main.sqlite) and DATABASE_URL
export DATABASE_URL="postgresql://user:pass@localhost:5432/openclaw"
npm run migrate

# Or with explicit paths
npm run migrate -- --sqlite ~/.openclaw/memory/main.sqlite --pg "postgresql://user:pass@localhost:5432/openclaw"

# Different agent
npm run migrate -- --agent-id my-agent --pg "$DATABASE_URL"

# Use a dedicated schema (default: public)
npm run migrate -- --schema openclaw_memory --pg "$DATABASE_URL"

# Dry run (only read SQLite and print stats)
npm run migrate -- --dry-run --sqlite ~/.openclaw/memory/main.sqlite
```

### Options

| Option | Description |
|--------|-------------|
| `--sqlite <path>` | Path to OpenClaw SQLite index file |
| `--agent-id <id>` | Agent id used for default SQLite path (default: `main`) |
| `--pg <url>` | Postgres connection string (or set `DATABASE_URL`) |
| `--schema <name>` | Postgres schema to create/use (default: `public`) |
| `--dry-run` | Only read SQLite and print row counts; do not write to Postgres |
| `--help`, `-h` | Show help |

### What gets migrated

- **meta** — index metadata (e.g. embedding model, chunking params)
- **files** — file list and hashes (paths, mtime, size)
- **chunks** — text chunks and their **embeddings** (vector dimension is taken from index meta or inferred from first chunk)
- **embedding_cache** — cached embeddings to avoid re-embedding

Full-text search (FTS) is not migrated; the SQLite FTS5 index is separate. A pgvector-backed OpenClaw plugin would typically use Postgres full-text search (`tsvector`) or vector-only search.

### Rollback

If migration fails during **install** (`./scripts/install.sh --migrate`), the script automatically runs rollback (drops the created tables) and exits. To roll back manually (e.g. after a standalone `npm run migrate` that failed partway):

```bash
npm run rollback:pg -- --pg "postgresql://user:pass@localhost:5432/openclaw" --schema public
```

This drops `chunks`, `embedding_cache`, `files`, and `meta` in the given schema.

### Enabling pgvector

**PostgreSQL:**

```bash
# From source or package manager; then in psql:
CREATE EXTENSION IF NOT EXISTS vector;
```

**YugabyteDB:** pgvector is supported; ensure the extension is enabled in your cluster.

---

## Plugin: use Postgres for memory at runtime

This repo includes an **OpenClaw memory plugin** that backs `memory_search` and `memory_get` with Postgres/pgvector. When you run the install script with migration, it links the plugin, sets `plugins.slots.memory = "memory-pgvector"`, and sets plugin config (databaseUrl, schema, and embedding.apiKey from OPENAI_API_KEY if set). OpenClaw then uses the plugin for memory; set **embedding** (API key and optionally model) in plugin config so the plugin can embed search queries. Restart the gateway after changing the memory slot or plugin config.

**Manual setup:** `openclaw plugins install /path/to/openclaw-memory-pgvector --link`, then `openclaw config set plugins.slots.memory memory-pgvector` and set `plugins.entries.memory-pgvector.config.databaseUrl` and `plugins.entries.memory-pgvector.config.embedding.apiKey`.

**CLI note:** `openclaw memory status` and `openclaw memory search` use the built-in (SQLite) backend only; they do not query the plugin. When the slot is `memory-pgvector`, only the **agent** (gateway) uses Postgres for memory_search/memory_get. To confirm the plugin is active: run `openclaw config get plugins.slots.memory` (should print `memory-pgvector`) and ensure the gateway has been restarted. To verify Postgres is used, trigger memory via the agent (e.g. ask the bot something that requires recall) or check Postgres query activity while the agent runs.

## License

MIT
