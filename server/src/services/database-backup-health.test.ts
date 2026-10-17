import { gzipSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectDatabaseBackupHealth } from "./database-backup-health.js";

describe("inspectDatabaseBackupHealth", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  // Regression for REVIP-8079: an aborted backup run left a valid but
  // empty .sql.gz (gzip of zero bytes) that passed every existing check.
  it("warns and reports non-ok status for an empty .sql.gz", async () => {
    dir = mkdtempSync(join(tmpdir(), "db-backup-health-"));
    writeFileSync(join(dir, "paperclip-20260911-135047.sql.gz"), gzipSync(Buffer.from("")));

    const result = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir: dir,
      maxAgeHours: 26,
    });

    expect(result.status).toBe("warning");
    expect(result.warnings.map((w) => w.code)).toContain("database_backup_empty");
    expect(result.latestBackup?.empty).toBe(true);
  });

  it("reports ok for a complete, non-empty archive", async () => {
    dir = mkdtempSync(join(tmpdir(), "db-backup-health-"));
    writeFileSync(
      join(dir, "paperclip-20260911-125024.sql.gz"),
      gzipSync(Buffer.from("CREATE TABLE example (id integer);")),
    );

    const result = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir: dir,
      maxAgeHours: 26,
    });

    expect(result.status).toBe("ok");
    expect(result.warnings).toEqual([]);
    expect(result.latestBackup?.empty).toBe(false);
  });

  it("does not trust a zero ISIZE trailer when the archive contains data", async () => {
    dir = mkdtempSync(join(tmpdir(), "db-backup-health-"));
    writeFileSync(
      join(dir, "paperclip-20260911-125024.sql.gz"),
      Buffer.concat([
        gzipSync(Buffer.from("CREATE TABLE example (id integer);")),
        gzipSync(Buffer.from("")),
      ]),
    );

    const result = await inspectDatabaseBackupHealth({
      enabled: true,
      backupDir: dir,
      maxAgeHours: 26,
    });

    expect(result.status).toBe("ok");
    expect(result.warnings).toEqual([]);
    expect(result.latestBackup?.empty).toBe(false);
  });
});
