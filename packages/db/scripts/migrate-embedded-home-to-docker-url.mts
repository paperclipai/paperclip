/**
 * Start ~/.paperclip/instances/default/db embedded Postgres, logical backup, restore to Docker Postgres.
 *
 * From repo root:
 *   node cli/node_modules/tsx/dist/cli.mjs packages/db/scripts/migrate-embedded-home-to-docker-url.mts
 *
 * Optional: DATABASE_TARGET_URL (default postgres://paperclip:paperclip@127.0.0.1:5432/paperclip)
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import EmbeddedPostgres from "embedded-postgres";
import { runDatabaseBackup, runDatabaseRestore } from "../src/backup-lib.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const EMBEDDED_PORT = 54329;
const dataDir = path.join(
  process.env.USERPROFILE ?? process.env.HOME ?? "",
  ".paperclip",
  "instances",
  "default",
  "db",
);

const targetUrl =
  process.env.DATABASE_TARGET_URL?.trim() || "postgres://paperclip:paperclip@127.0.0.1:5432/paperclip";

async function main(): Promise<void> {
  if (!existsSync(path.join(dataDir, "PG_VERSION"))) {
    throw new Error(`No embedded cluster at ${dataDir} (missing PG_VERSION).`);
  }

  const postmasterPid = path.join(dataDir, "postmaster.pid");
  if (existsSync(postmasterPid)) {
    rmSync(postmasterPid, { force: true });
  }

  const ep = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "paperclip",
    password: "paperclip",
    port: EMBEDDED_PORT,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
    onLog: () => {},
    onError: () => {},
  });

  await ep.start();

  const sourceUrl = `postgres://paperclip:paperclip@127.0.0.1:${EMBEDDED_PORT}/paperclip`;
  const backupDir = path.join(repoRoot, "data", "embedded-to-docker-migration");
  mkdirSync(backupDir, { recursive: true });

  try {
    const { backupFile, sizeBytes } = await runDatabaseBackup({
      connectionString: sourceUrl,
      backupDir,
      retention: { dailyDays: 1, weeklyWeeks: 1, monthlyMonths: 1 },
      filenamePrefix: "pre-docker-restore",
      backupEngine: "javascript",
    });
    console.log(`Backup OK: ${backupFile} (${sizeBytes} bytes) → restoring to target…`);

    await runDatabaseRestore({ connectionString: targetUrl, backupFile, connectTimeoutSeconds: 30 });
    console.log("Restore finished.");
  } finally {
    await ep.stop().catch(() => {});
  }
}

await main();
