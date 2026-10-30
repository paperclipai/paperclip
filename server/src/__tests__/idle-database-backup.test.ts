import { mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createDb, ensurePostgresDatabase, getEmbeddedPostgresTestSupport, runDatabaseBackup, runDatabaseRestore, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { clearIdleBackupWakeRequired, idleBackupWakeMarker, markIdleBackupWakeRequired, verifyIdleDatabaseBackup } from "../services/idle-database-backup.js";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "idle-backup-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("idle database backup persistence", () => {
  it("keeps a restart marker until a fresh valid backup is complete", async () => {
    const archive = path.join(directory, "backup.sql.gz");
    await markIdleBackupWakeRequired(directory);
    await writeFile(archive, gzipSync("CREATE TABLE fixture (id integer);\n"));
    await verifyIdleDatabaseBackup(archive);
    // Verification on the sleep path must not remove the wake obligation.
    expect(await readFile(idleBackupWakeMarker(directory), "utf8")).toContain("restarts");
    await clearIdleBackupWakeRequired(directory);
    await expect(readFile(idleBackupWakeMarker(directory))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(archive)).toEqual(gzipSync("CREATE TABLE fixture (id integer);\n"));
  });

  it.each([
    ["empty file", Buffer.alloc(0)], ["empty SQL", gzipSync("")],
    ["truncated gzip", gzipSync("SELECT 1;").subarray(0, -4)],
    ["plain text", Buffer.from("SELECT 1;")],
  ])("rejects %s and retains the restart obligation", async (_label, contents) => {
    await markIdleBackupWakeRequired(directory);
    const archive = path.join(directory, "invalid.sql.gz");
    await writeFile(archive, contents);
    await expect(verifyIdleDatabaseBackup(archive)).rejects.toThrow();
    expect(await readFile(idleBackupWakeMarker(directory), "utf8")).toContain("restarts");
  });

  it("rejects a missing archive and symlinked archive or marker", async () => {
    const archive = path.join(directory, "backup.sql.gz");
    await expect(verifyIdleDatabaseBackup(archive)).rejects.toThrow();
    const target = path.join(directory, "target");
    await writeFile(target, gzipSync("SELECT 1;"));
    await symlink(target, archive);
    await expect(verifyIdleDatabaseBackup(archive)).rejects.toThrow();
    await symlink(target, idleBackupWakeMarker(directory));
    await expect(markIdleBackupWakeRequired(directory)).rejects.toThrow();
    expect(await readFile(target)).toEqual(gzipSync("SELECT 1;"));
  });
});

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("idle backup restore", () => {
  it("restores the last pre-sleep state into a separate database", async () => {
    const source = await startEmbeddedPostgresTestDatabase("idle-backup-restore-");
    const sourceDb = createDb(source.connectionString);
    const targetUrl = new URL(source.connectionString);
    targetUrl.pathname = "/idle_restore";
    try {
      await sourceDb.execute(sql`CREATE TABLE backup_fixture (id integer PRIMARY KEY, value text NOT NULL)`);
      await sourceDb.execute(sql`INSERT INTO backup_fixture VALUES (1, 'last committed state')`);
      await markIdleBackupWakeRequired(directory);
      const result = await runDatabaseBackup({
        connectionString: source.connectionString, backupDir: directory,
        retention: { dailyDays: 14, weeklyWeeks: 4, monthlyMonths: 6 },
        verifyBeforePrune: verifyIdleDatabaseBackup,
      });
      await verifyIdleDatabaseBackup(result.backupFile);
      await ensurePostgresDatabase(source.connectionString, "idle_restore");
      await runDatabaseRestore({ connectionString: targetUrl.toString(), backupFile: result.backupFile });
      const target = createDb(targetUrl.toString());
      expect(await target.execute(sql`SELECT id, value FROM backup_fixture`)).toEqual([{ id: 1, value: "last committed state" }]);
      const checkpointBytes = await readFile(result.backupFile);
      expect(await readFile(idleBackupWakeMarker(directory), "utf8")).toContain("restarts");
      // A failed verification must not delete existing recovery points, even
      // when their age would make them eligible for the configured pruning.
      const history = path.join(directory, "paperclip-history.sql.gz");
      const historyBytes = gzipSync("SELECT 'historical recovery point';");
      await writeFile(history, historyBytes);
      await utimes(history, new Date(0), new Date(0));
      await expect(runDatabaseBackup({
        connectionString: source.connectionString, backupDir: directory,
        backupEngine: "javascript", retention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
        verifyBeforePrune: async () => { throw new Error("verification failed"); },
      })).rejects.toThrow("verification failed");
      expect(await readFile(history)).toEqual(historyBytes);
      expect(await readFile(result.backupFile)).toEqual(checkpointBytes);
    } finally {
      await source.cleanup();
    }
  }, 60_000);
});
