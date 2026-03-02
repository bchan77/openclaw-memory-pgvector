/**
 * Postgres-backed MemorySearchManager for the memory-pgvector plugin.
 * Uses the same schema as the migration (meta, files, chunks, embedding_cache).
 */

import fs from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import pgvector from "pgvector/pg";
import { CHUNKS_TABLE, META_TABLE } from "../scripts/schema-pg.js";

const META_KEY = "memory_index_meta_v1";
const SNIPPET_MAX_CHARS = 700;

type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: "memory" | "sessions";
};

type MemoryProviderStatus = {
  backend: "builtin" | "qmd";
  provider: string;
  model?: string;
  files?: number;
  chunks?: number;
  workspaceDir?: string;
  custom?: Record<string, unknown>;
};

export interface PgManagerConfig {
  databaseUrl: string;
  schema: string;
  embedding: { apiKey: string; model?: string; baseUrl?: string };
  workspaceDir: string;
  agentId: string;
}

export class PgMemoryManager {
  private pool: pg.Pool;
  private readonly schema: string;
  private readonly workspaceDir: string;
  private readonly agentId: string;
  private embedFn: (text: string) => Promise<number[]>;
  private vectorDims: number | null = null;
  private modelLabel: string;

  constructor(config: PgManagerConfig) {
    this.pool = new pg.Pool({ connectionString: config.databaseUrl });
    this.pool.on("connect", async (client: pg.PoolClient) => {
      await pgvector.registerTypes(client);
    });
    this.schema = config.schema;
    this.workspaceDir = config.workspaceDir;
    this.agentId = config.agentId;
    this.modelLabel = config.embedding.model ?? "text-embedding-3-small";
    this.embedFn = this.createEmbedFn(config.embedding);
  }

  private createEmbedFn(embedding: { apiKey: string; model?: string; baseUrl?: string }) {
    const model = embedding.model ?? "text-embedding-3-small";
    return async (text: string): Promise<number[]> => {
      const { default: OpenAI } = await import("openai");
      const client = new OpenAI({
        apiKey: embedding.apiKey,
        baseURL: embedding.baseUrl,
      });
      const r = await client.embeddings.create({ model, input: text });
      const vec = r.data[0]?.embedding;
      if (!vec || !Array.isArray(vec)) {
        throw new Error("Empty or invalid embedding response");
      }
      return vec;
    };
  }

  private quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  private async withSchema<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      if (this.schema !== "public") {
        await client.query(`SET search_path TO ${this.quoteIdent(this.schema)}`);
      }
      return await fn(client);
    } finally {
      client.release();
    }
  }

  private async getVectorDims(client: pg.PoolClient): Promise<number> {
    if (this.vectorDims != null) {
      return this.vectorDims;
    }
    const metaRow = await client.query(
      `SELECT value FROM ${this.quoteIdent(META_TABLE)} WHERE key = $1`,
      [META_KEY],
    );
    if (metaRow.rows[0]?.value) {
      try {
        const meta = JSON.parse(metaRow.rows[0].value) as { vectorDims?: number };
        if (typeof meta.vectorDims === "number") {
          this.vectorDims = meta.vectorDims;
          return this.vectorDims;
        }
      } catch {
        // ignore
      }
    }
    const chunkRow = await client.query(
      `SELECT embedding FROM ${this.quoteIdent(CHUNKS_TABLE)} LIMIT 1`,
    );
    const row = chunkRow.rows[0] as { embedding?: number[] } | undefined;
    if (row?.embedding && Array.isArray(row.embedding)) {
      this.vectorDims = row.embedding.length;
      return this.vectorDims;
    }
    throw new Error("Could not determine embedding dimension (no meta or chunks)");
  }

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number },
  ): Promise<MemorySearchResult[]> {
    const maxResults = Math.min(opts?.maxResults ?? 6, 50);
    const minScore = opts?.minScore ?? 0.35;

    const queryVec = await this.embedFn(query);

    const results = await this.withSchema(async (client) => {
      await this.getVectorDims(client);
      const vecStr = `[${queryVec.join(",")}]`;
      const sql = `
        SELECT c.id, c.path, c.start_line, c.end_line, c.text, c.source,
               (1 - (c.embedding <=> $1::vector)) AS score
          FROM ${this.quoteIdent(CHUNKS_TABLE)} c
         ORDER BY c.embedding <=> $1::vector
         LIMIT $2
      `;
      const r = await client.query(sql, [vecStr, maxResults * 2]);
      return r.rows as Array<{
        path: string;
        start_line: number;
        end_line: number;
        text: string;
        source: string;
        score: number;
      }>;
    });

    return results
      .filter((row) => row.score >= minScore)
      .slice(0, maxResults)
      .map((row) => ({
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        score: row.score,
        snippet: row.text.slice(0, SNIPPET_MAX_CHARS),
        source: (row.source === "sessions" ? "sessions" : "memory") as "memory" | "sessions",
      }));
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const normalized = params.relPath.trim().replace(/^[./]+/, "").replace(/\\/g, "/");
    if (!normalized || normalized.includes("..")) {
      return { text: "", path: params.relPath };
    }
    const allowed =
      normalized === "MEMORY.md" ||
      normalized === "memory.md" ||
      normalized.startsWith("memory/");
    if (!allowed) {
      return { text: "", path: params.relPath };
    }
    const absPath = path.join(this.workspaceDir, normalized);
    try {
      let text = await fs.readFile(absPath, "utf-8");
      const from = params.from ?? 1;
      const lines = params.lines;
      if (from > 1 || lines != null) {
        const lineList = text.split("\n");
        const start = Math.max(0, from - 1);
        const end =
          lines != null && lines > 0 ? Math.min(lineList.length, start + lines) : lineList.length;
        text = lineList.slice(start, end).join("\n");
      }
      return { text, path: params.relPath };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { text: "", path: params.relPath };
      }
      throw err;
    }
  }

  status(): MemoryProviderStatus {
    return {
      backend: "builtin",
      provider: "openai",
      model: this.modelLabel,
      workspaceDir: this.workspaceDir,
      custom: { backend: "pgvector", schema: this.schema },
    };
  }

  async probeEmbeddingAvailability(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.embedFn("test");
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  async probeVectorAvailability(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
