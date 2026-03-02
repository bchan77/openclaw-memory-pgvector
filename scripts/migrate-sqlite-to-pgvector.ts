#!/usr/bin/env node
/**
 * Migrate OpenClaw memory index from SQLite to PostgreSQL (or YugabyteDB) with pgvector.
 *
 * Usage:
 *   npx openclaw-memory-pgvector migrate [options]
 *   node scripts/migrate-sqlite-to-pgvector.js [options]
 *
 * Options:
 *   --sqlite <path>     Path to OpenClaw SQLite index (default: ~/.openclaw/memory/<agentId>.sqlite)
 *   --agent-id <id>     Agent id for default sqlite path (default: main)
 *   --pg <url>          Postgres connection string (or set DATABASE_URL)
 *   --schema <name>     Postgres schema to use (default: public)
 *   --dry-run           Only read SQLite and print stats; do not write to Postgres
 *   --help              Show this help
 *
 * Example:
 *   migrate --sqlite ~/.openclaw/memory/main.sqlite --pg "postgresql://user:pass@localhost:5432/openclaw"
 */

import Database from "better-sqlite3";
import pg from "pg";
import { PoolConfig } from "pg";
import pgvector from "pgvector";
import { createSchemaSql, EMBEDDING_CACHE_TABLE, FILES_TABLE, CHUNKS_TABLE, META_TABLE } from "./schema-pg.js";

const META_KEY = "memory_index_meta_v1";
const DEFAULT_AGENT_ID = "main";

function getDefaultSqlitePath(agentId: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) throw new Error("HOME or USERPROFILE not set");
  return `${home}/.openclaw/memory/${agentId}.sqlite`;
}

function parseEmbedding(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as number[]) : [];
  } catch {
    return [];
  }
}

function pgVectorFormat(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

function parseArgs(): {
  sqlitePath: string;
  pgUrl: string;
  schema: string;
  dryRun: boolean;
  help: boolean;
} {
  const args = process.argv.slice(2);
  let sqlitePath = "";
  let pgUrl = process.env.DATABASE_URL ?? "";
  let schema = "public";
  let dryRun = false;
  let help = false;
  let agentId = DEFAULT_AGENT_ID;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--sqlite":
        sqlitePath = args[++i] ?? "";
        break;
      case "--agent-id":
        agentId = args[++i] ?? DEFAULT_AGENT_ID;
        break;
      case "--pg":
        pgUrl = args[++i] ?? "";
        break;
      case "--schema":
        schema = args[++i] ?? "public";
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
    }
  }

  if (!sqlitePath) {
    sqlitePath = getDefaultSqlitePath(agentId);
  }

  return { sqlitePath, pgUrl, schema, dryRun, help };
}

function printHelp(): void {
  const helpText = `
Migrate OpenClaw memory index from SQLite to PostgreSQL (or YugabyteDB) with pgvector.

Usage:
  npx openclaw-memory-pgvector migrate [options]
  node scripts/migrate-sqlite-to-pgvector.js [options]

Options:
  --sqlite <path>     Path to OpenClaw SQLite index
  --agent-id <id>     Agent id for default sqlite path (default: main)
  --pg <url>          Postgres connection string (or set DATABASE_URL)
  --schema <name>     Postgres schema to use (default: public)
  --dry-run           Only read SQLite and print stats; do not write to Postgres
  --help, -h          Show this help

Default SQLite path: ~/.openclaw/memory/<agentId>.sqlite

Example:
  migrate --sqlite ~/.openclaw/memory/main.sqlite --pg "postgresql://user:pass@localhost:5432/openclaw"
  DATABASE_URL="postgresql://localhost/openclaw" migrate --agent-id main
`;
  console.log(helpText.trim());
}

async function main(): Promise<void> {
  const { sqlitePath, pgUrl, schema, dryRun, help } = parseArgs();

  if (help) {
    printHelp();
    process.exit(0);
  }

  const fs = await import("node:fs");
  if (!fs.existsSync(sqlitePath)) {
    console.error(`SQLite file not found: ${sqlitePath}`);
    process.exit(1);
  }

  if (!pgUrl && !dryRun) {
    console.error("Postgres URL required. Set DATABASE_URL or pass --pg <url>");
    process.exit(1);
  }

  const db = new Database(sqlitePath, { readonly: true });

  // Read meta to get vector dimension
  const metaRow = db.prepare(`SELECT value FROM ${META_TABLE} WHERE key = ?`).get(META_KEY) as { value: string } | undefined;
  let vectorDims: number | undefined;
  if (metaRow?.value) {
    try {
      const meta = JSON.parse(metaRow.value) as { vectorDims?: number };
      vectorDims = meta.vectorDims;
    } catch {
      // ignore
    }
  }

  const chunks = db.prepare(`SELECT id, path, source, start_line, end_line, hash, model, text, embedding, updated_at FROM ${CHUNKS_TABLE}`).all() as Array<{
    id: string;
    path: string;
    source: string;
    start_line: number;
    end_line: number;
    hash: string;
    model: string;
    text: string;
    embedding: string;
    updated_at: number;
  }>;

  if (chunks.length > 0 && vectorDims == null) {
    const first = parseEmbedding(chunks[0].embedding);
    if (first.length > 0) {
      vectorDims = first.length;
      console.log(`Inferred vector dimension from chunks: ${vectorDims}`);
    }
  }

  if (vectorDims == null || vectorDims < 1) {
    console.error("Could not determine embedding dimension (no meta.vectorDims and no chunks with embeddings).");
    db.close();
    process.exit(1);
  }

  const files = db.prepare(`SELECT path, source, hash, mtime, size FROM ${FILES_TABLE}`).all() as Array<{ path: string; source: string; hash: string; mtime: number; size: number }>;
  const metaRows = db.prepare(`SELECT key, value FROM ${META_TABLE}`).all() as Array<{ key: string; value: string }>;
  const cacheRows = db.prepare(`SELECT provider, model, provider_key, hash, embedding, dims, updated_at FROM ${EMBEDDING_CACHE_TABLE}`).all() as Array<{
    provider: string;
    model: string;
    provider_key: string;
    hash: string;
    embedding: string;
    dims: number | null;
    updated_at: number;
  }>;

  db.close();

  console.log(`SQLite: ${sqlitePath}`);
  console.log(`  meta: ${metaRows.length} rows`);
  console.log(`  files: ${files.length} rows`);
  console.log(`  chunks: ${chunks.length} rows (vector dim ${vectorDims})`);
  console.log(`  embedding_cache: ${cacheRows.length} rows`);

  if (dryRun) {
    console.log("Dry run: skipping Postgres write.");
    process.exit(0);
  }

  const poolConfig: PoolConfig = typeof pgUrl === "string" ? { connectionString: pgUrl } : pgUrl;
  const pool = new pg.Pool(poolConfig);
  pgvector.extend(pool);

  function quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  const client = await pool.connect();
  try {
    if (schema !== "public") {
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
      await client.query(`SET search_path TO ${quoteIdent(schema)}`);
    }

    const schemaSql = createSchemaSql(vectorDims);
    for (const stmt of schemaSql.split(";").map((s) => s.trim()).filter(Boolean)) {
      await client.query(stmt);
    }

    if (schema !== "public") {
      await client.query(`SET search_path TO ${quoteIdent(schema)}`);
    }

    for (const row of metaRows) {
      await client.query(
        `INSERT INTO ${META_TABLE} (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [row.key, row.value],
      );
    }
    console.log("  Written meta");

    for (const row of files) {
      await client.query(
        `INSERT INTO ${FILES_TABLE} (path, source, hash, mtime, size) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (path) DO UPDATE SET source = EXCLUDED.source, hash = EXCLUDED.hash, mtime = EXCLUDED.mtime, size = EXCLUDED.size`,
        [row.path, row.source, row.hash, row.mtime, row.size],
      );
    }
    console.log("  Written files");

    for (const row of chunks) {
      const vec = parseEmbedding(row.embedding);
      if (vec.length !== vectorDims) {
        console.warn(`  Skipping chunk ${row.id}: embedding length ${vec.length} != ${vectorDims}`);
        continue;
      }
      await client.query(
        `INSERT INTO ${CHUNKS_TABLE} (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector, $10) ON CONFLICT (id) DO UPDATE SET path = EXCLUDED.path, source = EXCLUDED.source, start_line = EXCLUDED.start_line, end_line = EXCLUDED.end_line, hash = EXCLUDED.hash, model = EXCLUDED.model, text = EXCLUDED.text, embedding = EXCLUDED.embedding, updated_at = EXCLUDED.updated_at`,
        [row.id, row.path, row.source, row.start_line, row.end_line, row.hash, row.model, row.text, pgVectorFormat(vec), row.updated_at],
      );
    }
    console.log("  Written chunks");

    for (const row of cacheRows) {
      const vec = parseEmbedding(row.embedding);
      if (vec.length !== vectorDims) continue;
      await client.query(
        `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at) VALUES ($1, $2, $3, $4, $5::vector, $6, $7) ON CONFLICT (provider, model, provider_key, hash) DO UPDATE SET embedding = EXCLUDED.embedding, dims = EXCLUDED.dims, updated_at = EXCLUDED.updated_at`,
        [row.provider, row.model, row.provider_key, row.hash, pgVectorFormat(vec), row.dims, row.updated_at],
      );
    }
    console.log("  Written embedding_cache");

    console.log("Migration complete.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
