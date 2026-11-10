import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDatabaseBackup } from "@paperclipai/db";
import { createDatabaseBackupOwner } from "../services/database-backup-owner.js";
import { idleBackupWakeMarker, markIdleBackupWakeRequired } from "../services/idle-database-backup.js";
import { beginIdleTrackedWork, idleWorkSnapshot } from "../services/task-admission.js";
import { readIdleSleepSafety, type IdleSleepDrainStatus } from "../services/idle-sleep-safety.js";
import type { Db } from "@paperclipai/db";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerDatabaseBackupWork } from "../services/database-backup-work.js";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";

vi.mock("@paperclipai/db", async importOriginal => ({ ...await importOriginal<typeof import("@paperclipai/db")>(), runDatabaseBackup: vi.fn() }));
let directory: string;
const policy = { dailyDays: 14, weeklyWeeks: 4, monthlyMonths: 6 };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
function owner(getRetention = async () => policy) {
  return createDatabaseBackupOwner({ connectionString: "unused", backupDir: directory, getRetention, logger });
}
async function validArchive(options: Parameters<typeof runDatabaseBackup>[0]) {
  const backupFile = path.join(directory, "fixture.sql.gz");
  const bytes = gzipSync("CREATE TABLE fixture (id integer);\n");
  await writeFile(backupFile, bytes);
  await options.verifyBeforePrune?.(backupFile);
  return { backupFile, sizeBytes: bytes.length, prunedCount: 0 };
}
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "backup-owner-"));
  vi.mocked(runDatabaseBackup).mockReset().mockImplementation(validArchive);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("database backup owner", () => {
  it("marks before retention access and retains the marker until a verified wake backup", async () => {
    const run = owner(async () => {
      expect(await readFile(idleBackupWakeMarker(directory), "utf8")).toContain("restarts");
      expect(idleWorkSnapshot().active).toBe(1);
      return policy;
    });
    const before = idleWorkSnapshot();
    const checkpoint = await run("idle");
    expect(checkpoint).toMatchObject({ trigger: "idle", retention: policy, backupDir: directory });
    expect(idleWorkSnapshot()).toEqual({ active: before.active, generation: before.generation + 2 });
    expect(existsSync(idleBackupWakeMarker(directory))).toBe(true);
    await owner()("scheduled");
    expect(existsSync(idleBackupWakeMarker(directory))).toBe(false);
    expect(runDatabaseBackup).toHaveBeenCalledWith(expect.objectContaining({ retention: policy, verifyBeforePrune: expect.any(Function) }));
  });

  it("keeps one receipt and single-flight exclusion until the actual operation settles", async () => {
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    vi.mocked(runDatabaseBackup).mockImplementationOnce(async options => { await gate; return validArchive(options); });
    const run = owner(); const backup = run("idle");
    await vi.waitFor(() => expect(runDatabaseBackup).toHaveBeenCalledOnce());
    expect(idleWorkSnapshot().active).toBe(1);
    expect(await run("scheduled")).toBeNull();
    await expect(run("manual")).rejects.toMatchObject({ status: 409 });
    await expect(run("idle")).rejects.toMatchObject({ status: 409 });
    finish(); await backup;
    expect(idleWorkSnapshot().active).toBe(0);
  });

  it.each(["dump", "integrity", "retention"])("retains the marker and releases the receipt after %s failure", async failure => {
    await markIdleBackupWakeRequired(directory);
    if (failure === "dump") vi.mocked(runDatabaseBackup).mockRejectedValueOnce(new Error("dump failed"));
    if (failure === "integrity") vi.mocked(runDatabaseBackup).mockImplementationOnce(async options => {
      const backupFile = path.join(directory, "invalid.sql.gz"); await writeFile(backupFile, "corrupt");
      await options.verifyBeforePrune!(backupFile); throw new Error("unreachable");
    });
    const run = owner(async () => { if (failure === "retention") throw new Error("retention unavailable"); return policy; });
    await expect(run("scheduled")).rejects.toThrow();
    expect(existsSync(idleBackupWakeMarker(directory))).toBe(true);
    expect(idleWorkSnapshot().active).toBe(0);
    await owner()("scheduled");
    expect(existsSync(idleBackupWakeMarker(directory))).toBe(false);
  });

  it.each(["expiry", "owner", "generation"])("rejects sleep after %s changes during the production owner's backup", async change => {
    let now = Date.now();
    let hold: IdleSleepDrainStatus = { ownerId: "owner", draining: true, startedAt: new Date(now - 1), expiresAt: new Date(now + 60_000), activeRuns: 0, pendingWakes: 0 };
    let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
    vi.mocked(runDatabaseBackup).mockImplementationOnce(async options => { await gate; return validArchive(options); });
    const db = { transaction: async (fn: (tx: unknown) => unknown) => fn({ execute: async () => [{ blocked: false }] }) } as unknown as Db;
    const run = owner();
    const safety = readIdleSleepSafety(db, () => hold, () => now, "owner", async () => "none", undefined, async () => Boolean(await run("idle")));
    await vi.waitFor(() => expect(runDatabaseBackup).toHaveBeenCalledOnce());
    expect(idleWorkSnapshot().active).toBe(1);
    if (change === "expiry") now += 60_000;
    if (change === "owner") hold = { ...hold, ownerId: "replacement" };
    if (change === "generation") beginIdleTrackedWork()();
    finish();
    expect(await safety).toEqual({ version: 1, backgroundWork: "unknown" });
    expect(existsSync(idleBackupWakeMarker(directory))).toBe(true);
    expect(idleWorkSnapshot().active).toBe(0);
  });

  it("resumes the normal interval after a verified wake backup and retains a due slot through drain", async () => {
    await markIdleBackupWakeRequired(directory);
    const run = owner(); await run("scheduled");
    expect(existsSync(idleBackupWakeMarker(directory))).toBe(false);
    vi.useFakeTimers();
    const execute = vi.fn(async () => []);
    let canRun = true;
    const coordinator = createDeliveryWorkCoordinator({ owner: installDatabaseWorkSignals({ execute, transaction: vi.fn() }), canRun: () => canRun, onError: error => { throw error; } });
    try {
      await registerDatabaseBackupWork(coordinator, { intervalMs: 1000, run: () => run("scheduled") }).ready;
      await vi.advanceTimersByTimeAsync(999);
      expect(runDatabaseBackup).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      canRun = false;
      await vi.advanceTimersByTimeAsync(3001);
      expect(runDatabaseBackup).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      canRun = true;
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
      expect(runDatabaseBackup).toHaveBeenCalledTimes(2);
      expect(coordinator.nextWakeAt()).toBeGreaterThan(Date.now());
    } finally { await coordinator.stop(); vi.useRealTimers(); }
  });

  it("fails closed if the storage path is no longer a directory", async () => {
    await rm(directory, { recursive: true }); await writeFile(directory, "mount unavailable");
    await expect(owner()("idle")).rejects.toThrow();
    expect(runDatabaseBackup).not.toHaveBeenCalled();
    expect(idleWorkSnapshot().active).toBe(0);
  });
});
