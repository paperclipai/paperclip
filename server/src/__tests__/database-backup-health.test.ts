import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { inspectDatabaseBackupHealth } from "../services/database-backup-health.js";

const tempDirs: string[] = [];

function createBackupDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-backup-health-"));
  tempDirs.push(dir);
  return dir;
}

function writeBackup(dir: string, name: string, content: Buffer, mtime: Date) {
  const fullPath = path.join(dir, name);
  fs.writeFileSync(fullPath, content);
  fs.utimesSync(fullPath, mtime, mtime);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const NOW = new Date("2026-03-31T12:00:00Z");

// Poorly compressible dump-like content, so gzip sizes stay realistic.
function dumpOfSize(rows: number): Buffer {
  const lines: string[] = [];
  for (let i = 0; i < rows; i += 1) {
    lines.push(`INSERT INTO t VALUES (${i}, '${Math.sin(i * 7919).toString(36)}', ${Math.cos(i * 104729)});`);
  }
  return gzipSync(lines.join("\n"));
}

const HEALTHY_DUMP = dumpOfSize(120); // a few KB compressed

function inspect(dir: string) {
  return inspectDatabaseBackupHealth({
    enabled: true,
    backupDir: dir,
    maxAgeHours: 48,
    now: NOW,
  });
}

describe("inspectDatabaseBackupHealth (#15351)", () => {
  it("reports ok for a healthy recent backup", () => {
    const dir = createBackupDir();
    writeBackup(dir, "paperclip-20260331.sql.gz", HEALTHY_DUMP, new Date("2026-03-31T11:00:00Z"));
    const status = inspect(dir);
    expect(status.status).toBe("ok");
    expect(status.warnings).toEqual([]);
  });

  it("warns database_backup_truncated when the newest backup is a near-empty gzip", () => {
    const dir = createBackupDir();
    writeBackup(dir, "paperclip-20260330.sql.gz", HEALTHY_DUMP, new Date("2026-03-30T11:00:00Z"));
    // A gzip stream created by a backup that crashed before writing data:
    // 20 bytes, newest mtime — previously reported as a healthy latest.
    writeBackup(dir, "paperclip-20260331.sql.gz", gzipSync(""), new Date("2026-03-31T11:00:00Z"));
    const status = inspect(dir);
    expect(status.status).toBe("warning");
    expect(status.latestBackup?.name).toBe("paperclip-20260331.sql.gz");
    expect(status.warnings.map((warning) => warning.code)).toContain("database_backup_truncated");
  });

  it("warns database_backup_truncated when the newest backup collapses versus the trailing median", () => {
    const dir = createBackupDir();
    const largeDump = dumpOfSize(1500);
    for (const day of ["2026-03-27", "2026-03-28", "2026-03-29", "2026-03-30"]) {
      writeBackup(dir, `paperclip-${day.replaceAll("-", "")}.sql.gz`, largeDump, new Date(`${day}T11:00:00Z`));
    }
    // Above the absolute floor but a small fraction of the usual size.
    writeBackup(dir, "paperclip-20260331.sql.gz", dumpOfSize(40), new Date("2026-03-31T11:00:00Z"));
    const status = inspect(dir);
    expect(status.warnings.map((warning) => warning.code)).toContain("database_backup_truncated");
  });

  it("does not raise the truncated warning for a consistent small-database history", () => {
    const dir = createBackupDir();
    for (const day of ["2026-03-28", "2026-03-29", "2026-03-30", "2026-03-31"]) {
      writeBackup(dir, `paperclip-${day.replaceAll("-", "")}.sql.gz`, HEALTHY_DUMP, new Date(`${day}T11:00:00Z`));
    }
    const status = inspect(dir);
    expect(status.warnings.map((warning) => warning.code)).not.toContain("database_backup_truncated");
  });
});
