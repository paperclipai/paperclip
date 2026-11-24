import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDb } from "../../packages/db/src/client.js";
import { startEmbeddedPostgresTestDatabase } from "../../packages/db/src/test-embedded-postgres.js";

// Fast throwaway server bootstrap for Playwright E2E shards.
// Replaces `cli onboard --yes --run` (which runs CLI onboarding + 12 doctor
// checks + fresh durable Postgres initdb/migrations) by:
//   1. Writing the minimal throwaway local_trusted config + secrets key directly.
//   2. Booting a disposable embedded Postgres via `@paperclipai/db`'s migrated
//      template cache and disabling durability flushes (`fsync=off`,
//      `synchronous_commit=off`, `full_page_writes=off`) so both startup and
//      every E2E test write execute at memory speed.
//   3. Starting `server/src/index.ts` directly via `startServer()`.

const port = Number(process.env.PORT ?? process.env.PAPERCLIP_E2E_PORT ?? 3199);
const instanceId = process.env.PAPERCLIP_INSTANCE_ID ?? "playwright-e2e";
const homeDir =
  process.env.PAPERCLIP_HOME ??
  fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-e2e-home-"));
const instanceRoot = path.join(homeDir, "instances", instanceId);
const configPath =
  process.env.PAPERCLIP_CONFIG ?? path.join(instanceRoot, "config.json");
const logsDir = path.join(instanceRoot, "logs");
const storageDir = path.join(instanceRoot, "data", "storage");
const masterKeyPath = path.join(instanceRoot, "secrets", "master.key");

fs.mkdirSync(logsDir, { recursive: true });
fs.mkdirSync(storageDir, { recursive: true });
fs.mkdirSync(path.dirname(masterKeyPath), { recursive: true });
fs.mkdirSync(path.dirname(configPath), { recursive: true });

if (!fs.existsSync(masterKeyPath)) {
  fs.writeFileSync(masterKeyPath, randomBytes(32).toString("base64"), {
    encoding: "utf8",
    mode: 0o600,
  });
}

let db: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let shutdownServer: ((signal?: "SIGINT" | "SIGTERM") => Promise<void>) | undefined;
let shuttingDown = false;

async function shutdown(signal: "SIGINT" | "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await shutdownServer?.(signal);
  } finally {
    await db?.cleanup();
  }
  process.exit(0);
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

try {
  const usesExternalPostgres = Boolean(process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL?.trim());
  db = await startEmbeddedPostgresTestDatabase("paperclip-e2e-pg-");

  // Only tune cluster-wide durability settings on a disposable embedded
  // PostgreSQL instance owned by this script. Never mutate a shared external
  // PostgreSQL server passed via PAPERCLIP_TEST_POSTGRES_ADMIN_URL.
  if (!usesExternalPostgres) {
    const adminUrl = new URL(db.connectionString);
    adminUrl.pathname = "/postgres";
    const admin = createDb(adminUrl.toString(), { maxConnections: 1 });
    try {
      await admin.$client.unsafe("ALTER SYSTEM SET fsync = off");
      await admin.$client.unsafe("ALTER SYSTEM SET synchronous_commit = off");
      await admin.$client.unsafe("ALTER SYSTEM SET full_page_writes = off");
      await admin.$client.unsafe("SELECT pg_reload_conf()");
    } finally {
      await admin.$client.end({ timeout: 1 });
    }
  }

  const config = {
    $meta: {
      version: 1,
      updatedAt: new Date().toISOString(),
      source: "onboard",
    },
    database: {
      mode: "postgres",
      connectionString: db.connectionString,
      backup: { enabled: false, intervalMinutes: 60, retentionDays: 7, dir: path.join(instanceRoot, "data", "backups") },
    },
    logging: { mode: "file", logDir: logsDir },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      bind: "loopback",
      host: "127.0.0.1",
      port,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: { baseUrlMode: "auto", disableSignUp: false },
    storage: { provider: "local_disk", localDisk: { baseDir: storageDir } },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: { keyFilePath: masterKeyPath },
    },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  process.env.PAPERCLIP_HOME = homeDir;
  process.env.PAPERCLIP_INSTANCE_ID = instanceId;
  process.env.PAPERCLIP_CONFIG = configPath;
  process.env.DATABASE_URL = db.connectionString;
  process.env.PAPERCLIP_STORAGE_LOCAL_DIR = storageDir;
  process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = masterKeyPath;
  process.env.PAPERCLIP_DB_BACKUP_ENABLED = "false";

  const { startServer } = await import("../../server/src/index.js");
  const started = await startServer();
  shutdownServer = started.shutdown;
} catch (error) {
  await db?.cleanup();
  throw error;
}
