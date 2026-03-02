/**
 * OpenClaw memory plugin: Postgres/pgvector-backed memory_search and memory_get.
 * Set plugins.slots.memory = "memory-pgvector" and configure databaseUrl + embedding.
 */

import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { PgMemoryManager } from "./pg-manager.js";

const configSchema = Type.Object({
  databaseUrl: Type.String(),
  schema: Type.Optional(Type.String()),
  embedding: Type.Object({
    apiKey: Type.String(),
    model: Type.Optional(Type.String()),
    baseUrl: Type.Optional(Type.String()),
  }),
});

function resolveWorkspaceDir(config: Record<string, unknown>, agentId: string): string {
  const agents = config.agents as Record<string, unknown> | undefined;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  const entries = agents?.entries as Record<string, Record<string, unknown>> | undefined;
  const raw =
    (entries?.[agentId]?.workspace as string) ??
    (defaults?.workspace as string) ??
    "";
  if (raw && typeof raw === "string") {
    const trimmed = raw.trim().replace(/^~/, os.homedir());
    return path.resolve(trimmed);
  }
  const home = process.env.OPENCLAW_HOME ?? os.homedir();
  return path.join(home, ".openclaw", "workspace");
}

function resolveAgentId(config: Record<string, unknown>, _sessionKey?: string): string {
  const agents = config.agents as Record<string, unknown> | undefined;
  const defaults = agents?.defaults as Record<string, unknown> | undefined;
  const id = defaults?.defaultAgentId ?? (defaults as { defaultAgent?: string })?.defaultAgent;
  if (typeof id === "string") return id;
  return "main";
}

function jsonResult(payload: unknown): { content: Array<{ type: "text"; text: string }>; details: unknown } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

const plugin = {
  id: "memory-pgvector",
  name: "Memory (pgvector)",
  description: "PostgreSQL/YugabyteDB pgvector-backed memory search (memory_search, memory_get)",
  kind: "memory" as const,
  configSchema: configSchema as unknown as Record<string, unknown>,

  register(api: OpenClawPluginApi) {
    const cfg = configSchema.parse(api.pluginConfig) as {
      databaseUrl: string;
      schema?: string;
      embedding: { apiKey: string; model?: string; baseUrl?: string };
    };
    const schema = cfg.schema ?? "public";

    const managerCache = new Map<string, PgMemoryManager>();

    function getManager(config: Record<string, unknown>, sessionKey?: string): PgMemoryManager {
      const agentId = resolveAgentId(config, sessionKey);
      const key = agentId;
      let manager = managerCache.get(key);
      if (!manager) {
        const workspaceDir = resolveWorkspaceDir(config, agentId);
        manager = new PgMemoryManager({
          databaseUrl: cfg.databaseUrl,
          schema,
          embedding: cfg.embedding,
          workspaceDir,
          agentId,
        });
        managerCache.set(key, manager);
      }
      return manager;
    }

    api.registerTool(
      (ctx) => {
        const getConfig = (): Record<string, unknown> => {
          try {
            const loaded = api.config.loadConfig();
            return (loaded as Record<string, unknown>) ?? {};
          } catch {
            return (ctx as { config?: Record<string, unknown> }).config ?? {};
          }
        };
        return [
          {
            name: "memory_search",
            label: "Memory Search",
            description:
              "Semantically search MEMORY.md + memory/*.md (and optional session transcripts). Returns top snippets with path + lines. Use before answering questions about prior work, decisions, or preferences.",
            parameters: Type.Object({
              query: Type.String(),
              maxResults: Type.Optional(Type.Number()),
              minScore: Type.Optional(Type.Number()),
            }),
            execute: async (_toolCallId: string, params: Record<string, unknown>) => {
              const query = String(params.query ?? "").trim();
              if (!query) {
                return jsonResult({ results: [], error: "query is required" });
              }
              try {
                const config = getConfig();
                const manager = getManager(config, ctx.sessionKey as string | undefined);
                const maxResults =
                  typeof params.maxResults === "number" ? params.maxResults : undefined;
                const minScore =
                  typeof params.minScore === "number" ? params.minScore : undefined;
                const rawResults = await manager.search(query, { maxResults, minScore });
                const status = manager.status();
                return jsonResult({
                  results: rawResults,
                  provider: status.provider,
                  model: status.model,
                  fallback: undefined,
                  citations: "auto",
                  mode: undefined,
                });
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return jsonResult({
                  results: [],
                  disabled: true,
                  unavailable: true,
                  error: message,
                  warning: "Memory search failed.",
                  action: "Check database and embedding configuration.",
                });
              }
            },
          },
          {
            name: "memory_get",
            label: "Memory Get",
            description:
              "Read a snippet from MEMORY.md or memory/*.md (optional from/lines). Use after memory_search to pull only the needed lines.",
            parameters: Type.Object({
              path: Type.String(),
              from: Type.Optional(Type.Number()),
              lines: Type.Optional(Type.Number()),
            }),
            execute: async (_toolCallId: string, params: Record<string, unknown>) => {
              const relPath = String(params.path ?? "").trim();
              if (!relPath) {
                return jsonResult({ text: "", path: "", disabled: true, error: "path is required" });
              }
              try {
                const config = getConfig();
                const manager = getManager(config, ctx.sessionKey as string | undefined);
                const from =
                  typeof params.from === "number" ? params.from : undefined;
                const lines =
                  typeof params.lines === "number" ? params.lines : undefined;
                const result = await manager.readFile({
                  relPath,
                  from,
                  lines,
                });
                return jsonResult(result);
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return jsonResult({
                  text: "",
                  path: relPath,
                  disabled: true,
                  error: message,
                });
              }
            },
          },
        ];
      },
      { names: ["memory_search", "memory_get"] },
    );

    api.logger.info(`memory-pgvector: registered (schema: ${schema})`);
  },
};

export default plugin;
