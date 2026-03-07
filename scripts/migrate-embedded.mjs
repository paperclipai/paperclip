#!/usr/bin/env node
/**
 * Starts the embedded PostgreSQL, runs pending migrations, then stops Postgres.
 * Usage: node scripts/migrate-embedded.mjs
 *
 * Respects the same env vars as the server:
 *   PAPERCLIP_HOME, PAPERCLIP_INSTANCE_ID  – control the data dir location
 *   PAPERCLIP_EMBEDDED_POSTGRES_PORT        – override the default port (54329)
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Path helpers (mirrors server/src/home-paths.ts)
// ---------------------------------------------------------------------------

function expandHomePrefix(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return resolve(os.homedir(), value.slice(2));
  return value;
}

function resolvePaperclipHomeDir() {
  const envHome = process.env.PAPERCLIP_HOME?.trim();
  if (envHome) return resolve(expandHomePrefix(envHome));
  return resolve(os.homedir(), ".paperclip");
}

function resolvePaperclipInstanceId() {
  return (process.env.PAPERCLIP_INSTANCE_ID?.trim()) || "default";
}

function resolveDefaultEmbeddedPostgresDir() {
  return resolve(resolvePaperclipHomeDir(), "instances", resolvePaperclipInstanceId(), "db");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const dataDir = resolveDefaultEmbeddedPostgresDir();
const port = Number(process.env.PAPERCLIP_EMBEDDED_POSTGRES_PORT) || 54329;
const connectionString = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;

console.log(`Embedded Postgres data dir: ${dataDir}`);
console.log(`Embedded Postgres port:     ${port}`);

// Check if already running by inspecting postmaster.pid
const postmasterPidFile = resolve(dataDir, "postmaster.pid");
let alreadyRunning = false;
if (existsSync(postmasterPidFile)) {
  try {
    const pid = Number(readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        alreadyRunning = true;
        console.log(`Embedded Postgres already running (pid=${pid}); skipping start`);
      } catch {
        // stale pid file
      }
    }
  } catch {
    // ignore read errors
  }
}

let embeddedPostgres = null;

if (!alreadyRunning) {
  let EmbeddedPostgres;
  try {
    const mod = await import("embedded-postgres");
    EmbeddedPostgres = mod.default;
  } catch {
    console.error(
      "Could not import embedded-postgres. Make sure server dependencies are installed:\n" +
        "  pnpm install\n" +
        "Or set DATABASE_URL and run: pnpm db:migrate",
    );
    process.exit(1);
  }

  const clusterVersionFile = resolve(dataDir, "PG_VERSION");
  const clusterAlreadyInitialized = existsSync(clusterVersionFile);

  embeddedPostgres = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port,
    persistent: true,
  });

  if (!clusterAlreadyInitialized) {
    console.log("Initialising embedded Postgres cluster...");
    await embeddedPostgres.initialise();
  } else {
    console.log("Cluster already initialised; skipping init");
  }

  if (existsSync(postmasterPidFile)) {
    console.log("Removing stale lock file");
    rmSync(postmasterPidFile, { force: true });
  }

  console.log("Starting embedded Postgres...");
  await embeddedPostgres.start();
  console.log("Embedded Postgres started");

  // Ensure the paperclip database exists (embedded-postgres only creates the
  // default "postgres" database; the server creates "paperclip" on first run)
  try {
    const adminUrl = `postgres://paperclip:paperclip@127.0.0.1:${port}/postgres`;
    // Use the db package's ensurePostgresDatabase via a quick inline approach:
    // We'll just attempt createdb via psql-style; use the db client helper instead.
    const { ensurePostgresDatabase } = await import("../packages/db/src/client.js");
    const status = await ensurePostgresDatabase(adminUrl, "paperclip");
    if (status === "created") {
      console.log("Created 'paperclip' database");
    }
  } catch (err) {
    console.warn("Could not ensure 'paperclip' database exists:", err.message);
    console.warn("If the database does not exist the migration step will fail.");
  }
}

// ---------------------------------------------------------------------------
// Run migrations via the existing migrate script
// ---------------------------------------------------------------------------

console.log("\nRunning migrations...");
const result = spawnSync(
  "pnpm",
  ["--filter", "@paperclipai/db", "migrate"],
  {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: connectionString },
    cwd: resolve(__dirname, ".."),
  },
);

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

if (embeddedPostgres) {
  console.log("\nStopping embedded Postgres...");
  await embeddedPostgres.stop();
  console.log("Embedded Postgres stopped");
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log("Done");
