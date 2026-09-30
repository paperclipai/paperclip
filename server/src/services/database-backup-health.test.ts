import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectDatabaseBackupHealth } from "./database-backup-health.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir), stat: vi.fn(actual.stat) };
});

const NOW = new Date("2026-09-30T12:00:00Z");
let directory: string;
const inspect = () => inspectDatabaseBackupHealth({ enabled: true, backupDir: directory, maxAgeHours: 24, now: NOW });

async function backup(name: string, ageHours: number) {
  const file = path.join(directory, name);
  await fs.writeFile(file, "backup");
  const date = new Date(NOW.getTime() - ageHours * 3_600_000);
  await fs.utimes(file, date, date);
  return file;
}

beforeEach(async () => { vi.resetAllMocks(); directory = await fs.mkdtemp(path.join(os.tmpdir(), "backup-health-")); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });

describe("database backup health", () => {
  it("selects the newest backup by modification time", async () => {
    await backup("a.sql.gz", 1);
    await backup("z.sql.gz", 2);
    expect(await inspect()).toMatchObject({ status: "ok", latestBackup: { name: "a.sql.gz", ageHours: 1, sizeBytes: 6 }, warnings: [] });
  });

  it("reports an old backup as stale", async () => {
    await backup("old.sql.gz", 25);
    expect((await inspect()).warnings[0].code).toBe("database_backup_stale");
  });

  it("reports a missing directory as missing, without a check failure", async () => {
    await fs.rm(directory, { recursive: true });
    expect((await inspect()).warnings.map((warning) => warning.code)).toEqual(["database_backup_missing"]);
  });

  it("reports the first line of a failure marker", async () => {
    await backup("recent.sql.gz", 1);
    await fs.writeFile(path.join(directory, "db-backup-to-s3.failure"), "Backup upload failed\nprivate diagnostic\n");
    expect((await inspect()).lastFailure?.message).toBe("Backup upload failed");
  });

  it("reports an unreadable directory as a failed check", async () => {
    vi.mocked(fs.readdir).mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EACCES" }));
    expect((await inspect()).warnings.map((warning) => warning.code)).toEqual(["database_backup_check_failed"]);
  });

  it("ignores a backup removed by retention after the directory listing", async () => {
    await backup("removed.sql.gz", 1);
    vi.mocked(fs.stat).mockRejectedValueOnce(Object.assign(new Error("removed"), { code: "ENOENT" }));
    expect((await inspect()).warnings.map((warning) => warning.code)).toEqual(["database_backup_missing"]);
  });

  it("lets a timer run while the filesystem observation is pending", async () => {
    let release!: () => void;
    const held = new Promise<string[]>((resolve) => { release = () => resolve([]); });
    vi.mocked(fs.readdir).mockImplementationOnce(() => held as unknown as ReturnType<typeof fs.readdir>);
    let finished = false;
    const pending = inspect().then((result) => { finished = true; return result; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(finished).toBe(false);
    } finally {
      release();
    }
    expect((await pending).warnings[0].code).toBe("database_backup_missing");
  });
});
