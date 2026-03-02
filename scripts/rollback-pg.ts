#!/usr/bin/env node
/**
 * Rollback OpenClaw memory migration: drop tables created by migrate-sqlite-to-pgvector.
 * Use after a failed migration to leave the database clean.
 *
 * Usage:
 *   node scripts/rollback-pg.js [--pg URL] [--schema NAME]
 *   DATABASE_URL=postgresql://... node scripts/rollback-pg.js
 */

import pg from "pg";
import {
  CHUNKS_TABLE,
  EMBEDDING_CACHE_TABLE,
  FILES_TABLE,
  META_TABLE,
} from "./schema-pg.js";

function getUrl(): string | null {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--pg" && args[i + 1]) {
      return args[i + 1];
    }
  }
  return process.env.DATABASE_URL ?? null;
}

function getSchema(): string {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--schema" && args[i + 1]) {
      return args[i + 1];
    }
  }
  return process.env.PGSCHEMA ?? "public";
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function main(): Promise<void> {
  const url = getUrl();
  if (!url || url.trim() === "") {
    console.error("No database URL. Set DATABASE_URL or pass --pg <url>.");
    process.exit(1);
  }

  const schema = getSchema();
  const client = new pg.Client({ connectionString: url });

  try {
    await client.connect();
    if (schema !== "public") {
      await client.query(`SET search_path TO ${quoteIdent(schema)}`);
    }
    const tables = [CHUNKS_TABLE, EMBEDDING_CACHE_TABLE, FILES_TABLE, META_TABLE];
    for (const table of tables) {
      await client.query(`DROP TABLE IF EXISTS ${quoteIdent(table)}`);
      console.log(`Dropped table: ${table}`);
    }
    console.log("Rollback complete.");
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Rollback failed:", message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
