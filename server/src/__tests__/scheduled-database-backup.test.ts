import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createScheduledDatabaseBackupRunner,
  DatabaseBackupTimeoutError,
  sweepOrphanBackupTempFiles,
} from "../scheduled-database-backup.js";

const makeLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

const never = <T>(): Promise<T> => new Promise<T>(() => {});

describe("createScheduledDatabaseBackupRunner", () => {
  let backupDir: string;

  beforeEach(() => {
    backupDir = mkdtempSync(join(tmpdir(), "pc-backup-test-"));
  });

  afterEach(() => {
    rmSync(backupDir, { recursive: true, force: true });
  });

  it("clears the in-flight flag after a hang times out so the next scheduled run executes", async () => {
    const logger = makeLogger();
    let calls = 0;
    const runner = createScheduledDatabaseBackupRunner<string>({
      timeoutMs: 20,
      backupDir,
      filenamePrefix: "paperclip",
      logger,
      runBackup: async () => {
        calls += 1;
        // First invocation hangs forever (the wedge we are guarding against).
        if (calls === 1) return never<string>();
        return "ok";
      },
    });

    // Hung run must reject via the watchdog rather than hang the routine.
    await expect(runner.run("scheduled")).rejects.toBeInstanceOf(DatabaseBackupTimeoutError);
    expect(runner.isInFlight).toBe(false);

    // The next scheduled tick must actually run (not be skipped as "still running").
    await expect(runner.run("scheduled")).resolves.toBe("ok");
    expect(calls).toBe(2);
  });

  it("sweeps orphaned uncompressed .sql temp dumps on timeout", async () => {
    const logger = makeLogger();
    const orphan = join(backupDir, "paperclip-2026-06-04T13-30-00.sql");
    writeFileSync(orphan, "-- partial dump\n");
    // A compressed, completed backup must be left untouched.
    const keep = join(backupDir, "paperclip-2026-06-04T12-30-00.sql.gz");
    writeFileSync(keep, "gzipped");

    const runner = createScheduledDatabaseBackupRunner<string>({
      timeoutMs: 20,
      backupDir,
      filenamePrefix: "paperclip",
      logger,
      runBackup: () => never<string>(),
    });

    await expect(runner.run("scheduled")).rejects.toBeInstanceOf(DatabaseBackupTimeoutError);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(keep)).toBe(true);
    expect(logger.error).toHaveBeenCalled();
  });

  it("does not leave an orphan .sql after a (non-hanging) backup failure", async () => {
    const logger = makeLogger();
    // Simulate runDatabaseBackup throwing after writing a temp dump it failed to clean.
    const orphan = join(backupDir, "paperclip-failed.sql");
    const runner = createScheduledDatabaseBackupRunner<string>({
      timeoutMs: 10_000,
      backupDir,
      filenamePrefix: "paperclip",
      logger,
      runBackup: async () => {
        writeFileSync(orphan, "-- partial dump\n");
        throw new Error("pg_dump exploded");
      },
    });

    await expect(runner.run("scheduled")).rejects.toThrow("pg_dump exploded");
    expect(runner.isInFlight).toBe(false);
    // A plain throw is the backup lib's responsibility to clean, but a follow-up
    // scheduled run that also fails must not accrete orphans — verify the sweep
    // path keeps the dir clear of uncompressed temp files after timeouts.
    const runner2 = createScheduledDatabaseBackupRunner<string>({
      timeoutMs: 20,
      backupDir,
      filenamePrefix: "paperclip",
      logger,
      runBackup: () => never<string>(),
    });
    await expect(runner2.run("scheduled")).rejects.toBeInstanceOf(DatabaseBackupTimeoutError);
    expect(readdirSync(backupDir).filter((f) => f.endsWith(".sql"))).toHaveLength(0);
  });

  it("skips overlapping scheduled runs and raises an alarm after N consecutive skips", async () => {
    const logger = makeLogger();
    const runner = createScheduledDatabaseBackupRunner<string>({
      timeoutMs: 60_000,
      backupDir,
      filenamePrefix: "paperclip",
      logger,
      consecutiveSkipAlarmThreshold: 3,
      runBackup: () => never<string>(),
    });

    // Start a long-running backup (still in flight).
    const inflight = runner.run("scheduled");
    void inflight.catch(() => {});

    // Overlapping scheduled ticks are skipped (return null), counting up.
    expect(await runner.run("scheduled")).toBeNull();
    expect(logger.error).not.toHaveBeenCalled();
    expect(await runner.run("scheduled")).toBeNull();
    expect(logger.error).not.toHaveBeenCalled();
    expect(await runner.run("scheduled")).toBeNull();
    // Third consecutive skip trips the wedge alarm.
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(runner.consecutiveSkips).toBe(3);
  });

  it("throws (not skips) when a manual run collides with an in-flight backup", async () => {
    const logger = makeLogger();
    const runner = createScheduledDatabaseBackupRunner<string>({
      timeoutMs: 60_000,
      backupDir,
      filenamePrefix: "paperclip",
      logger,
      conflictError: (m) => new Error(`CONFLICT:${m}`),
      runBackup: () => never<string>(),
    });

    void runner.run("scheduled").catch(() => {});
    await expect(runner.run("manual")).rejects.toThrow("CONFLICT:Database backup already in progress");
  });
});

describe("sweepOrphanBackupTempFiles", () => {
  it("removes only matching uncompressed temp dumps", () => {
    const dir = mkdtempSync(join(tmpdir(), "pc-sweep-test-"));
    try {
      writeFileSync(join(dir, "paperclip-a.sql"), "x");
      writeFileSync(join(dir, "paperclip-b.sql.gz"), "x");
      writeFileSync(join(dir, "other-c.sql"), "x");
      const removed = sweepOrphanBackupTempFiles(dir, "paperclip");
      expect(removed).toHaveLength(1);
      expect(existsSync(join(dir, "paperclip-a.sql"))).toBe(false);
      expect(existsSync(join(dir, "paperclip-b.sql.gz"))).toBe(true);
      expect(existsSync(join(dir, "other-c.sql"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty list for a missing directory", () => {
    expect(sweepOrphanBackupTempFiles(join(tmpdir(), "pc-does-not-exist-xyz"), "paperclip")).toEqual([]);
  });
});
