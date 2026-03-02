#!/usr/bin/env node
/**
 * Test Postgres connectivity. Exits 0 on success, 1 on failure.
 * Uses DATABASE_URL or --pg <url>.
 */

import pg from "pg";

function getUrl(): string | null {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--pg" && args[i + 1]) {
      return args[i + 1];
    }
  }
  return process.env.DATABASE_URL ?? null;
}

async function main(): Promise<void> {
  const url = getUrl();
  if (!url || url.trim() === "") {
    console.error("No database URL. Set DATABASE_URL or pass --pg <url>.");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await client.query("SELECT 1");
    console.log("Connection OK.");
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Connection failed:", message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
