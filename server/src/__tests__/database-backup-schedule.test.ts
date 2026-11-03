import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeFirstScheduledBackupDelayMs,
  DEFAULT_FIRST_BACKUP_MIN_DELAY_MS,
  findInterruptedServerBackups,
  findLatestServerBackup,
} from "../services/database-backup-schedule.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "backup-schedule-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

async function writeBackup(name: string, mtimeMs: number) {
  const file = path.join(directory, name);
  await writeFile(file, "x");
  await utimes(file, mtimeMs / 1000, mtimeMs / 1000);
}

describe("findLatestServerBackup", () => {
  it("returns null for a missing or empty directory", async () => {
    expect(await findLatestServerBackup(path.join(directory, "missing"))).toBeNull();
    expect(await findLatestServerBackup(directory)).toBeNull();
  });

  it("rejects when the backup directory cannot be read", async () => {
    const notADirectory = path.join(directory, "file");
    await writeFile(notADirectory, "x");
    await expect(findLatestServerBackup(notADirectory)).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("picks the newest server-named dump and ignores hand-named, partial and foreign files", async () => {
    const base = Date.UTC(2026, 9, 25, 12);
    await writeBackup("paperclip-20261024-104252.sql.gz", base - DAY);
    await writeBackup("paperclip-20261025-104252.sql.gz", base);
    await writeBackup("paperclip-20261025-110000-3f2a9c1e-1b2c-4d5e-8f90-123456789abc.sql.gz", base - HOUR);
    await writeBackup("paperclip-pre-deploy-20261025-204210.sql.gz", base + 8 * HOUR);
    await writeBackup("paperclip-20261026-010000.sql", base + 13 * HOUR);
    await writeBackup("other-20261026-010000.sql.gz", base + 13 * HOUR);
    await mkdir(path.join(directory, "paperclip-20261027-010000.sql.gz"));

    expect(await findLatestServerBackup(directory)).toEqual({
      name: "paperclip-20261025-104252.sql.gz",
      mtimeMs: base,
    });
  });

  it("counts idle checkpoint dumps", async () => {
    const base = Date.UTC(2026, 9, 25, 12);
    await writeBackup("paperclip-20261025-104252.sql.gz", base);
    await writeBackup("paperclip-20261025-130000-3f2a9c1e-1b2c-4d5e-8f90-123456789abc.sql.gz", base + HOUR);
    expect((await findLatestServerBackup(directory))?.mtimeMs).toBe(base + HOUR);
  });

  it("honours a custom prefix", async () => {
    const base = Date.UTC(2026, 9, 25, 12);
    await writeBackup("paperclip-20261025-104252.sql.gz", base + HOUR);
    await writeBackup("acme.co-20261025-104252.sql.gz", base);
    expect((await findLatestServerBackup(directory, "acme.co"))?.name).toBe("acme.co-20261025-104252.sql.gz");
  });
});

describe("computeFirstScheduledBackupDelayMs", () => {
  const nowMs = Date.UTC(2026, 9, 27, 5);

  it("schedules from the previous dump, not from startup", () => {
    // Restarted 6h after the last dump: next run 18h from now, not 24h.
    expect(computeFirstScheduledBackupDelayMs({
      latestBackupMtimeMs: nowMs - 6 * HOUR,
      nowMs,
      intervalMs: DAY,
    })).toBe(18 * HOUR);
  });

  it("runs soon after boot when the last dump is overdue", () => {
    expect(computeFirstScheduledBackupDelayMs({
      latestBackupMtimeMs: nowMs - 52 * HOUR,
      nowMs,
      intervalMs: DAY,
    })).toBe(DEFAULT_FIRST_BACKUP_MIN_DELAY_MS);
  });

  it("runs soon after boot when there is no dump", () => {
    expect(computeFirstScheduledBackupDelayMs({
      latestBackupMtimeMs: null,
      nowMs,
      intervalMs: DAY,
      minDelayMs: 1000,
    })).toBe(1000);
  });

  it("keeps the startup grace period when the dump is due within it", () => {
    expect(computeFirstScheduledBackupDelayMs({
      latestBackupMtimeMs: nowMs - DAY + 60_000,
      nowMs,
      intervalMs: DAY,
    })).toBe(DEFAULT_FIRST_BACKUP_MIN_DELAY_MS);
  });

  it("never waits longer than one interval, even with a future mtime", () => {
    expect(computeFirstScheduledBackupDelayMs({
      latestBackupMtimeMs: nowMs + 10 * DAY,
      nowMs,
      intervalMs: DAY,
    })).toBe(DAY);
  });

  it("caps the grace period at a short interval", () => {
    expect(computeFirstScheduledBackupDelayMs({
      latestBackupMtimeMs: null,
      nowMs,
      intervalMs: 60_000,
    })).toBe(60_000);
  });
});

describe("findInterruptedServerBackups", () => {
  it("returns zero for a missing or empty directory", async () => {
    expect(await findInterruptedServerBackups(path.join(directory, "missing"), null)).toEqual({ count: 0, newestMtimeMs: null });
    expect(await findInterruptedServerBackups(directory, null)).toEqual({ count: 0, newestMtimeMs: null });
  });

  it("counts only server-named partials newer than the latest completed dump", async () => {
    const base = Date.UTC(2026, 10, 1, 19, 30);
    await writeBackup("paperclip-20261031-153042.sql.gz", base - DAY);
    await writeBackup("paperclip-20261031-120000.sql.gz.partial", base - DAY - HOUR);
    await writeBackup("paperclip-20261101-143043.sql.gz.partial", base + 3 * 60_000);
    await writeBackup("paperclip-20261101-143844.sql.gz.partial", base + 11 * 60_000);
    await writeBackup("paperclip-pre-deploy.sql.gz.partial", base + HOUR);
    const latest = await findLatestServerBackup(directory);
    expect(latest?.name).toBe("paperclip-20261031-153042.sql.gz");
    expect(await findInterruptedServerBackups(directory, latest!.mtimeMs)).toEqual({
      count: 2,
      newestMtimeMs: base + 11 * 60_000,
    });
    expect((await findInterruptedServerBackups(directory, null)).count).toBe(3);
  });
});

describe("computeFirstScheduledBackupDelayMs after interrupted attempts", () => {
  const nowMs = Date.UTC(2026, 10, 1, 19, 34);
  const diedAtMs = nowMs - 30_000;
  const overdue = { latestBackupMtimeMs: nowMs - DAY - HOUR, nowMs, intervalMs: DAY };

  it("backs off exponentially from the last attempt that died mid-dump", () => {
    expect(computeFirstScheduledBackupDelayMs({ ...overdue, interruptedCount: 1, lastInterruptedAtMs: diedAtMs }))
      .toBe(HOUR - 30_000);
    expect(computeFirstScheduledBackupDelayMs({ ...overdue, interruptedCount: 2, lastInterruptedAtMs: diedAtMs }))
      .toBe(2 * HOUR - 30_000);
    expect(computeFirstScheduledBackupDelayMs({ ...overdue, interruptedCount: 4, lastInterruptedAtMs: diedAtMs }))
      .toBe(8 * HOUR - 30_000);
  });

  it("caps the backoff at one interval after the last interrupted attempt", () => {
    for (const interruptedCount of [6, 9, 500]) {
      expect(computeFirstScheduledBackupDelayMs({ ...overdue, interruptedCount, lastInterruptedAtMs: diedAtMs }))
        .toBe(DAY - 30_000);
    }
  });

  it("runs after the grace period once the backoff has elapsed", () => {
    expect(computeFirstScheduledBackupDelayMs({ ...overdue, interruptedCount: 1, lastInterruptedAtMs: nowMs - 3 * HOUR }))
      .toBe(DEFAULT_FIRST_BACKUP_MIN_DELAY_MS);
  });

  it("keeps a later dump-anchored deadline over a shorter backoff", () => {
    expect(computeFirstScheduledBackupDelayMs({
      latestBackupMtimeMs: nowMs - HOUR,
      nowMs,
      intervalMs: DAY,
      interruptedCount: 1,
      lastInterruptedAtMs: diedAtMs,
    })).toBe(DAY - HOUR);
  });
});
