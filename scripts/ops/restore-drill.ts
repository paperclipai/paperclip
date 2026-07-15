#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  ensurePostgresDatabase,
  runDatabaseRestore,
  startEmbeddedPostgresTestDatabase,
} from "../../packages/db/src/index.js";

const argv = process.argv.slice(2);
const backupArg = argv[argv.indexOf("--backup") + 1];
if (!backupArg || backupArg.startsWith("--")) {
  process.stderr.write("Usage: restore-drill.ts --backup <paperclip.sql.gz>\n");
  process.exit(1);
}

const backupFile = path.resolve(backupArg);
if (!backupFile.endsWith(".sql.gz")) throw new Error("Restore drill only accepts .sql.gz Paperclip backups");
await stat(backupFile);
const backupSha256 = createHash("sha256").update(await readFile(backupFile)).digest("hex");
const startedAt = Date.now();
const embedded = await startEmbeddedPostgresTestDatabase("paperclip-restore-drill-");

try {
  const adminUrl = new URL(embedded.connectionString);
  adminUrl.pathname = "/postgres";
  const databaseName = `paperclip_restore_drill_${randomUUID().replaceAll("-", "")}`;
  await ensurePostgresDatabase(adminUrl.toString(), databaseName);
  const restoreUrl = new URL(embedded.connectionString);
  restoreUrl.pathname = `/${databaseName}`;
  await runDatabaseRestore({ connectionString: restoreUrl.toString(), backupFile });
  process.stdout.write(`${JSON.stringify({
    status: "pass",
    backupFile: path.basename(backupFile),
    backupSha256,
    validation: "restore_completed_without_error",
    disposableTarget: true,
    elapsedMs: Date.now() - startedAt,
  })}\n`);
} finally {
  await embedded.cleanup();
}
