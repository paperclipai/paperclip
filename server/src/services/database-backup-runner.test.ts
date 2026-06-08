import { describe, expect, it, vi } from "vitest";
import type { BackupRetentionPolicy, RunDatabaseBackupResult } from "@paperclipai/db";
import type { DiskPressureResult } from "@paperclipai/shared/disk-monitor";
import { createDatabaseBackupRunner } from "./database-backup-runner.js";

const HEALTHY_RETENTION: BackupRetentionPolicy = {
  dailyDays: 7,
  weeklyWeeks: 4,
  monthlyMonths: 3,
};

const AGGRESSIVE_RETENTION: BackupRetentionPolicy = {
  dailyDays: 1,
  weeklyWeeks: 1,
  monthlyMonths: 0,
};

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function withPressure(p: Partial<DiskPressureResult>): DiskPressureResult {
  return {
    skip: false,
    aggressivePrune: false,
    freeGiB: 100,
    minFreeGiB: 2,
    aggressivePruneGiB: 5,
    ...p,
  };
}

function backupResult(overrides: Partial<RunDatabaseBackupResult> = {}): RunDatabaseBackupResult {
  return { backupFile: "/tmp/x.sql.gz", sizeBytes: 1024, prunedCount: 0, ...overrides };
}

describe("database backup runner", () => {
  it("skips backup with WARN log when disk is below the minimum threshold", async () => {
    const logger = makeLogger();
    const runBackup = vi.fn();
    const prune = vi.fn();
    const runner = createDatabaseBackupRunner({
      connectionString: "postgres://x",
      backupDir: "/tmp/backups",
      backupSettings: { getGeneral: async () => ({ backupRetention: HEALTHY_RETENTION }) },
      logger,
      runBackup,
      prune,
      evaluateDiskPressure: async () => withPressure({ skip: true, aggressivePrune: true, freeGiB: 1, minFreeGiB: 2 }),
    });

    const result = await runner.run("scheduled");

    expect(runBackup).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
    expect(result?.skipped).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
    const warnArgs = logger.warn.mock.calls[0];
    expect(String(warnArgs[1])).toContain("backup_skipped_low_disk");
  });

  it("escalates to ERROR backup_paused_low_disk after three consecutive skips", async () => {
    const logger = makeLogger();
    const runner = createDatabaseBackupRunner({
      connectionString: "postgres://x",
      backupDir: "/tmp/backups",
      backupSettings: { getGeneral: async () => ({ backupRetention: HEALTHY_RETENTION }) },
      logger,
      runBackup: vi.fn(),
      prune: vi.fn(),
      evaluateDiskPressure: async () => withPressure({ skip: true, aggressivePrune: true, freeGiB: 1, minFreeGiB: 2 }),
    });

    await runner.run("scheduled");
    await runner.run("scheduled");
    await runner.run("scheduled");

    const errorCalls = logger.error.mock.calls.filter((args) => String(args[1]).includes("backup_paused_low_disk"));
    expect(errorCalls.length).toBe(1);
  });

  it("prunes BEFORE the backup write when disk is healthy", async () => {
    const order: string[] = [];
    const prune = vi.fn(() => {
      order.push("prune");
      return 2;
    });
    const runBackup = vi.fn(async () => {
      order.push("backup");
      return backupResult({ prunedCount: 0 });
    });
    const runner = createDatabaseBackupRunner({
      connectionString: "postgres://x",
      backupDir: "/tmp/backups",
      backupSettings: { getGeneral: async () => ({ backupRetention: HEALTHY_RETENTION }) },
      logger: makeLogger(),
      runBackup,
      prune,
      evaluateDiskPressure: async () => withPressure({}),
    });

    const result = await runner.run("scheduled");

    expect(order).toEqual(["prune", "backup"]);
    expect(result?.skipped).toBeUndefined();
    expect(prune).toHaveBeenCalledWith("/tmp/backups", HEALTHY_RETENTION, "paperclip");
    expect(result?.prunedCount).toBe(2);
  });

  it("applies aggressive retention and emits aggressive_prune_triggered between thresholds", async () => {
    const logger = makeLogger();
    const prune = vi.fn(() => 0);
    const runBackup = vi.fn(async () => backupResult());
    const runner = createDatabaseBackupRunner({
      connectionString: "postgres://x",
      backupDir: "/tmp/backups",
      backupSettings: { getGeneral: async () => ({ backupRetention: HEALTHY_RETENTION }) },
      logger,
      runBackup,
      prune,
      evaluateDiskPressure: async () => withPressure({ aggressivePrune: true, freeGiB: 3, aggressivePruneGiB: 5 }),
    });

    await runner.run("scheduled");

    expect(prune).toHaveBeenCalledWith("/tmp/backups", AGGRESSIVE_RETENTION, "paperclip");
    expect(runBackup).toHaveBeenCalledWith(expect.objectContaining({ retention: AGGRESSIVE_RETENTION }));
    expect(logger.warn).toHaveBeenCalled();
    const warnMessages = logger.warn.mock.calls.map((c) => String(c[1] ?? ""));
    expect(warnMessages.some((m) => m.includes("aggressive_prune_triggered"))).toBe(true);
  });

  it("returns null on scheduled re-entry and throws on manual re-entry", async () => {
    let release!: () => void;
    const runner = createDatabaseBackupRunner({
      connectionString: "postgres://x",
      backupDir: "/tmp/backups",
      backupSettings: { getGeneral: async () => ({ backupRetention: HEALTHY_RETENTION }) },
      logger: makeLogger(),
      runBackup: () =>
        new Promise((resolve) => {
          release = () => resolve(backupResult());
        }),
      prune: vi.fn(() => 0),
      evaluateDiskPressure: async () => withPressure({}),
    });

    const first = runner.run("scheduled");
    const reentry = await runner.run("scheduled");
    expect(reentry).toBeNull();
    await expect(runner.run("manual")).rejects.toThrow(/already in progress/);

    release();
    await first;
  });
});
