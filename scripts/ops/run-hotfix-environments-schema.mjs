#!/usr/bin/env node
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const serverPackageJson = path.join(repoRoot, "server/package.json");
const requireFromServer = createRequire(serverPackageJson);
const postgres = requireFromServer("postgres");

function resolveDatabaseUrl(): string {
  const fromEnv = process.env.DATABASE_URL?.trim();
  if (fromEnv) return fromEnv;

  const configPath =
    process.env.PAPERCLIP_CONFIG?.trim() || "/paperclip/instances/default/config.json";
  if (!existsSync(configPath)) {
    throw new Error(
      `DATABASE_URL is unset and config not found at ${configPath}. ` +
        "Set DATABASE_URL or PAPERCLIP_CONFIG before running this script.",
    );
  }

  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    database?: {
      mode?: string;
      connectionString?: string;
      embeddedPostgresPort?: number;
    };
  };

  const connectionString = config.database?.connectionString?.trim();
  if (config.database?.mode === "postgres" && connectionString) {
    return connectionString;
  }

  if (config.database?.mode === "embedded-postgres") {
    const port = config.database.embeddedPostgresPort ?? 54329;
    return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
  }

  if (connectionString) return connectionString;

  throw new Error(
    "Could not resolve database URL. Set DATABASE_URL or configure database.connectionString in Paperclip config.",
  );
}

async function main(): Promise<void> {
  const sqlPath = path.join(scriptDir, "hotfix-environments-schema.sql");
  if (!existsSync(sqlPath)) {
    throw new Error(`Hotfix SQL file not found: ${sqlPath}`);
  }

  const sqlBody = readFileSync(sqlPath, "utf8");
  const databaseUrl = resolveDatabaseUrl();
  console.log("Running environments schema hotfix...");

  const db = postgres(databaseUrl, { max: 1 });
  try {
    await db.unsafe(sqlBody);
    console.log("Environments schema hotfix completed successfully.");
  } finally {
    await db.end({ timeout: 5 });
  }
}

await main();
