import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startDatabaseBackupScheduler } from "../database-backup-scheduler.js";
import type { RunDatabaseBackupResult } from "@paperclipai/db";

const retention = {
  dailyDays: 30,
  weeklyWeeks: 12,
  monthlyMonths: 12,
};

function createTempBackupDir(): string {
  return mkdtempSync(join(tmpdir(), "paperclip-backup-scheduler-"));
}

function writeBackup(backupDir: string, filename: string, mtimeMs: number): string {
  const backupFile = join(backupDir, filename);
  writeFileSync(backupFile, "-- Paperclip database backup\n");
  const mtime = new Date(mtimeMs);
  utimesSync(backupFile, mtime, mtime);
  return backupFile;
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createSetIntervalMock() {
  const callbacks: Array<() => void> = [];
  const setIntervalMock = vi.fn((callback: () => void, _delayMs: number) => {
    callbacks.push(callback);
    return callbacks.length as unknown as ReturnType<typeof setInterval>;
  });

  return { callbacks, setIntervalMock };
}

function createResolvedBackup(backupDir: string): RunDatabaseBackupResult {
  return {
    backupFile: join(backupDir, "paperclip-test.sql.gz"),
    sizeBytes: 128,
    prunedCount: 0,
  };
}

describe("database backup startup catch-up scheduler", () => {
  const tempDirs: string[] = [];
  const nowMs = Date.UTC(2026, 3, 13, 12, 0, 0);

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("runs startup catch-up when the newest backup is older than the configured interval", async () => {
    const backupDir = createTempBackupDir();
    tempDirs.push(backupDir);
    writeBackup(backupDir, "paperclip-20260413-105800.sql.gz", nowMs - 62 * 60 * 1000);
    const logger = createLogger();
    const { setIntervalMock } = createSetIntervalMock();
    const runBackup = vi.fn(async () => createResolvedBackup(backupDir));

    const scheduler = startDatabaseBackupScheduler({
      connectionString: "postgres://paperclip:paperclip@127.0.0.1:5432/paperclip",
      backupDir,
      intervalMinutes: 60,
      getRetention: vi.fn(async () => retention),
      logger,
      now: () => nowMs,
      runBackup,
      setInterval: setIntervalMock,
    });

    await scheduler.startupCatchUpPromise;

    expect(scheduler.startupDecision).toMatchObject({ shouldRun: true, reason: "stale" });
    expect(runBackup).toHaveBeenCalledTimes(1);
    expect(runBackup).toHaveBeenCalledWith(expect.objectContaining({
      backupDir,
      filenamePrefix: "paperclip",
      retention,
    }));
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "stale",
        newestBackupFile: "paperclip-20260413-105800.sql.gz",
        newestBackupAgeMinutes: 62,
      }),
      "Startup database backup catch-up run started",
    );
    expect(setIntervalMock).toHaveBeenCalledWith(expect.any(Function), 60 * 60 * 1000);
  });

  it("skips startup catch-up when a legacy .sql backup is still fresh", () => {
    const backupDir = createTempBackupDir();
    tempDirs.push(backupDir);
    writeBackup(backupDir, "paperclip-20260413-100000.sql.gz", nowMs - 2 * 60 * 60 * 1000);
    writeBackup(backupDir, "paperclip-20260413-114500.sql", nowMs - 15 * 60 * 1000);
    const logger = createLogger();
    const { setIntervalMock } = createSetIntervalMock();
    const runBackup = vi.fn(async () => createResolvedBackup(backupDir));

    const scheduler = startDatabaseBackupScheduler({
      connectionString: "postgres://paperclip:paperclip@127.0.0.1:5432/paperclip",
      backupDir,
      intervalMinutes: 60,
      getRetention: vi.fn(async () => retention),
      logger,
      now: () => nowMs,
      runBackup,
      setInterval: setIntervalMock,
    });

    expect(scheduler.startupDecision).toMatchObject({ shouldRun: false, reason: "fresh" });
    expect(scheduler.startupCatchUpPromise).toBeNull();
    expect(runBackup).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        newestBackupFile: "paperclip-20260413-114500.sql",
        newestBackupAgeMinutes: 15,
      }),
      "Skipping startup database backup catch-up because newest backup is fresh",
    );
    expect(setIntervalMock).toHaveBeenCalledWith(expect.any(Function), 60 * 60 * 1000);
  });

  it("runs startup catch-up when no successful backup exists", async () => {
    const backupDir = createTempBackupDir();
    tempDirs.push(backupDir);
    const logger = createLogger();
    const { setIntervalMock } = createSetIntervalMock();
    const runBackup = vi.fn(async () => createResolvedBackup(backupDir));

    const scheduler = startDatabaseBackupScheduler({
      connectionString: "postgres://paperclip:paperclip@127.0.0.1:5432/paperclip",
      backupDir,
      intervalMinutes: 60,
      getRetention: vi.fn(async () => retention),
      logger,
      now: () => nowMs,
      runBackup,
      setInterval: setIntervalMock,
    });

    await scheduler.startupCatchUpPromise;

    expect(scheduler.startupDecision).toMatchObject({ shouldRun: true, reason: "missing" });
    expect(runBackup).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "missing",
        newestBackupFile: null,
        newestBackupAgeMinutes: null,
      }),
      "Startup database backup catch-up run started",
    );
  });

  it("does not overlap the regular interval backup while startup catch-up is running", async () => {
    const backupDir = createTempBackupDir();
    tempDirs.push(backupDir);
    const logger = createLogger();
    const { callbacks, setIntervalMock } = createSetIntervalMock();
    let resolveBackup: (result: RunDatabaseBackupResult) => void = () => undefined;
    const runBackup = vi.fn(
      () =>
        new Promise<RunDatabaseBackupResult>((resolve) => {
          resolveBackup = resolve;
        }),
    );

    const scheduler = startDatabaseBackupScheduler({
      connectionString: "postgres://paperclip:paperclip@127.0.0.1:5432/paperclip",
      backupDir,
      intervalMinutes: 60,
      getRetention: vi.fn(async () => retention),
      logger,
      now: () => nowMs,
      runBackup,
      setInterval: setIntervalMock,
    });

    callbacks[0]?.();
    await Promise.resolve();

    expect(runBackup).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Skipping scheduled database backup because a previous backup is still running",
    );

    resolveBackup(createResolvedBackup(backupDir));
    await scheduler.startupCatchUpPromise;

    expect(runBackup).toHaveBeenCalledTimes(1);
  });
});
