/**
 * Postgres + pgvector schema for OpenClaw memory index.
 * Matches OpenClaw SQLite semantics so migrated data works with a pgvector-backed plugin.
 */

export const META_TABLE = "meta";
export const FILES_TABLE = "files";
export const CHUNKS_TABLE = "chunks";
export const EMBEDDING_CACHE_TABLE = "embedding_cache";

/** SQL to enable pgvector and create tables. vector_dim must match your embedding model (e.g. 1536 for text-embedding-3-small). */
export function createSchemaSql(vectorDim: number): string {
  return `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS ${META_TABLE} (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ${FILES_TABLE} (
  path TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'memory',
  hash TEXT NOT NULL,
  mtime BIGINT NOT NULL,
  size INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ${CHUNKS_TABLE} (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'memory',
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  hash TEXT NOT NULL,
  model TEXT NOT NULL,
  text TEXT NOT NULL,
  embedding vector(${vectorDim}) NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_path ON ${CHUNKS_TABLE}(path);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON ${CHUNKS_TABLE}(source);

CREATE TABLE IF NOT EXISTS ${EMBEDDING_CACHE_TABLE} (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  hash TEXT NOT NULL,
  embedding vector(${vectorDim}) NOT NULL,
  dims INTEGER,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (provider, model, provider_key, hash)
);

CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated_at ON ${EMBEDDING_CACHE_TABLE}(updated_at);
`.trim();
}
