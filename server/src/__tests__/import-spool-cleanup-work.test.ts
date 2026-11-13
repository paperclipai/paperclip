import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companyTransferRuns, createDb, type Db } from "@paperclipai/db";
import { companyTransferRunService } from "../services/company-transfer-runs.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerImportSpoolCleanupWork } from "../services/import-spool-cleanup-work.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { IMPORT_TRANSFER_SPOOL_MAX_AGE_MS, settleImportTransferSpool, sweepAbandonedImportTransferSpools, writeImportTransferPart } from "../services/company-import-transfers.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";

describe("import spool cleanup", () => {
  let db: Db, root: string;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let worker: ReturnType<typeof registerImportSpoolCleanupWork> | undefined;
  let admitted = true;
  const errors: unknown[] = [];
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_IMPORT_SPOOL_TEST_DATABASE_URL");
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("import-spool-");
    db = createDb(external ?? temporary!.connectionString, { idleTimeoutSeconds: 0, connectTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 30_000);
  beforeEach(async () => {
    admitted = true; errors.length = 0;
    root = await fs.mkdtemp(path.join(tmpdir(), "import-spool-"));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    worker?.unsubscribe(); await coordinator?.stop(); worker = undefined; coordinator = undefined;
    vi.useRealTimers(); vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true });
    expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  async function transfer() {
    return (await companyTransferRunService.resumeOrCreate(db, { direction: "import", actorKey: "test", idempotencyKey: randomUUID(), containerRef: {} })).run;
  }
  async function start() {
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => admitted,
      canReconcile: () => true, onError: error => errors.push(error) });
    worker = registerImportSpoolCleanupWork(db, coordinator, root, () => admitted);
    await worker.ready;
  }
  async function settle() {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000); await delay(5);
      expect(idleWorkSnapshot().active).toBe(0);
    }, { timeout: 5000 });
  }
  async function quiet(ms = 6 * 3600_000) {
    await settle();
    const before = db.$client.options.debug;
    const queries: string[] = [];
    const readDirs = vi.spyOn(fs, "readdir").mockClear(), stats = vi.spyOn(fs, "lstat").mockClear();
    db.$client.options.debug = (_id, query) => { queries.push(query); };
    try {
      await vi.advanceTimersByTimeAsync(ms); await delay(10);
      expect(queries).toEqual([]); expect(readDirs).not.toHaveBeenCalled(); expect(stats).not.toHaveBeenCalled();
    } finally { db.$client.options.debug = before; readDirs.mockRestore(); stats.mockRestore(); }
  }
  async function spool(runId: string) { await writeImportTransferPart(root, runId, 0, Buffer.from("saved parts")); }
  async function exists(runId: string) { return fs.lstat(path.join(root, runId)).then(() => true, () => false); }

  it("stays quiet with no directory and reactivates on the first uploaded part", async () => {
    await fs.rm(root, { recursive: true });
    await start(); await quiet();
    const run = await transfer(); await companyTransferRunService.start(db, run.id); await spool(run.id); await settle();
    const current = await companyTransferRunService.getRun(db, run.id);
    expect(coordinator!.nextWakeAt()).toBe(current!.updatedAt.getTime() + IMPORT_TRANSFER_SPOOL_MAX_AGE_MS + 1);
    await quiet(3600_000); expect(await exists(run.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(24 * 3600_000); await settle();
    expect(await exists(run.id)).toBe(false);
    expect((await companyTransferRunService.getRun(db, run.id))!.status).toBe("cancelled");
    expect(coordinator!.nextWakeAt()).toBeNull(); await quiet();
  });

  it("keeps failed and applying uploads without recurring SQL or filesystem discovery", async () => {
    const failed = await transfer(), applying = await transfer();
    await spool(failed.id); await spool(applying.id);
    await companyTransferRunService.fail(db, failed.id, "retryable");
    expect(await companyTransferRunService.claimApply(db, applying.id)).toBe(true);
    await start(); expect(coordinator!.nextWakeAt()).toBeNull(); await quiet();
    expect(await exists(failed.id)).toBe(true); expect(await exists(applying.id)).toBe(true);

    await companyTransferRunService.complete(db, applying.id); await settle();
    expect(await exists(applying.id)).toBe(false); expect(await exists(failed.id)).toBe(true); await quiet();
  });

  it("reconstructs an orphan's exact mtime deadline after restart", async () => {
    const id = randomUUID(); await spool(id);
    const stamp = new Date(Date.now() - IMPORT_TRANSFER_SPOOL_MAX_AGE_MS + 20_000);
    await fs.utimes(path.join(root, id), stamp, stamp);
    await start(); expect(coordinator!.nextWakeAt()).toBe(stamp.getTime() + IMPORT_TRANSFER_SPOOL_MAX_AGE_MS + 1);
    await vi.advanceTimersByTimeAsync(21_000); await settle();
    expect(await exists(id)).toBe(false); await quiet();
  });

  it("updates the deadline after committed activity and preserves the strict idle boundary", async () => {
    const run = await transfer(); await spool(run.id); await start();
    const before = coordinator!.nextWakeAt()!;
    await vi.advanceTimersByTimeAsync(3600_000);
    await companyTransferRunService.completePart(db, run.id, "part-0"); await settle();
    expect(coordinator!.nextWakeAt()).toBeGreaterThan(before);
    const current = await companyTransferRunService.getRun(db, run.id);
    const boundary = current!.updatedAt.getTime() + IMPORT_TRANSFER_SPOOL_MAX_AGE_MS;
    expect(await settleImportTransferSpool(db, root, run.id, { now: new Date(boundary) })).toBe(false);
    expect(await settleImportTransferSpool(db, root, run.id, { now: new Date(boundary + 1) })).toBe(true);
  });

  it("a resume or apply winning the cleanup claim keeps the spool", async () => {
    const run = await transfer(); await spool(run.id);
    const old = new Date(Date.now() - 25 * 3600_000);
    await db.update(companyTransferRuns).set({ updatedAt: old }).where(eq(companyTransferRuns.id, run.id));
    const claim = companyTransferRunService.cancelIfIdle.bind(companyTransferRunService);
    vi.spyOn(companyTransferRunService, "cancelIfIdle").mockImplementationOnce(async (...args) => {
      expect(await companyTransferRunService.claimApply(db, run.id)).toBe(true);
      return claim(...args);
    });
    expect(await settleImportTransferSpool(db, root, run.id)).toBe(false);
    expect(await exists(run.id)).toBe(true);
    expect((await companyTransferRunService.getRun(db, run.id))!.status).toBe("applying");
  });

  it.each(["commit", "rollback"] as const)("defers a nested terminal change until outer %s", async outcome => {
    const run = await transfer(); await spool(run.id); await companyTransferRunService.fail(db, run.id, "retained");
    await start(); await quiet();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const changed = new Promise<void>(resolve => { entered = resolve; });
    const transaction = db.transaction(async tx => {
      await companyTransferRunService.cancel(tx as unknown as Db, run.id); entered(); await gate;
      if (outcome === "rollback") throw new Error("rollback fixture");
    }).catch(error => { if (outcome !== "rollback" || error.message !== "rollback fixture") throw error; });
    await changed;
    try { await vi.advanceTimersByTimeAsync(60_000); expect(await exists(run.id)).toBe(true); }
    finally { release(); }
    await transaction; await settle();
    expect(await exists(run.id)).toBe(outcome === "rollback"); await quiet();
  });

  it("retains the first filesystem and ledger changes during drain without SQL", async () => {
    await start(); await quiet(); admitted = false;
    const run = await transfer(); await spool(run.id); await companyTransferRunService.cancel(db, run.id);

    await quiet(); expect(await exists(run.id)).toBe(true);
    admitted = true; worker!.wake(); await settle();
    expect(await exists(run.id)).toBe(false); await quiet();
  });

  it("retries failed cleanup, keeps its delay through a wake, and then becomes quiet", async () => {
    const run = await transfer(); await spool(run.id); await companyTransferRunService.cancel(db, run.id);
    const original = fs.rm.bind(fs); let denied = true;
    const removal = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (String(target) === path.join(root, run.id) && denied) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return original(target, options);
    });
    await start(); await settle(); expect(errors.splice(0)).toHaveLength(1);
    expect(await exists(run.id)).toBe(true);
    const attempts = removal.mock.calls.length;
    await companyTransferRunService.complete(db, run.id); await settle();
    expect(removal).toHaveBeenCalledTimes(attempts);
    denied = false; await vi.advanceTimersByTimeAsync(31_000); await settle();
    expect(await exists(run.id)).toBe(false); await quiet();
  });

  it("does not call permission errors an empty directory", async () => {
    vi.spyOn(fs, "readdir").mockRejectedValueOnce(Object.assign(new Error("directory denied"), { code: "EACCES" }));
    await start(); expect(errors.splice(0)).toHaveLength(1);
    expect(coordinator!.nextWakeAt()).not.toBeNull();
    await vi.advanceTimersByTimeAsync(31_000); await quiet();
  });

  it("schedules cleanup after a failed part write leaves an orphan directory", async () => {
    await start(); await quiet(); const id = randomUUID();
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failed"));
    await expect(spool(id)).rejects.toThrow("rename failed"); await settle();
    const stat = await fs.stat(path.join(root, id));
    expect(coordinator!.nextWakeAt()).toBe(Math.floor(stat.mtimeMs + IMPORT_TRANSFER_SPOOL_MAX_AGE_MS) + 1);
    await vi.advanceTimersByTimeAsync(25 * 3600_000); await settle();
    expect(await exists(id)).toBe(false); await quiet();
  });

  it("does not follow symlinks or schedule unrelated spool roots", async () => {
    const other = await fs.mkdtemp(path.join(tmpdir(), "other-spool-"));
    try {
      const id = randomUUID(); await fs.symlink(other, path.join(root, id)); await start(); await quiet();
      await writeImportTransferPart(other, randomUUID(), 0, Buffer.from("other")); await quiet();
      expect(coordinator!.nextWakeAt()).toBeNull(); expect((await fs.lstat(path.join(root, id))).isSymbolicLink()).toBe(true);
    } finally { await fs.rm(other, { recursive: true, force: true }); }
  });

  it("joins cleanup on shutdown and removes filesystem subscriptions", async () => {
    const run = await transfer(); await spool(run.id); await companyTransferRunService.cancel(db, run.id);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const began = new Promise<void>(resolve => { entered = resolve; });
    const original = fs.rm.bind(fs);
    vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (String(target) === path.join(root, run.id)) { entered(); await gate; }
      return original(target, options);
    });
    const starting = start(); await began;
    worker!.unsubscribe(); let stopped = false;
    const stopping = coordinator!.stop().then(() => { stopped = true; });
    await delay(10); expect(stopped).toBe(false); release(); await starting; await stopping;
    expect(await exists(run.id)).toBe(false);
    await spool(randomUUID()); expect(coordinator!.nextWakeAt()).toBeNull();
  });

  it("keeps startup apply recovery separate from future live applies", async () => {
    const stranded = await transfer(); await spool(stranded.id);
    await companyTransferRunService.claimApply(db, stranded.id);
    await companyTransferRunService.recoverStrandedApplyingRuns(db);
    await start(); await quiet();
    expect((await companyTransferRunService.getRun(db, stranded.id))!.status).toBe("failed");
    expect(await companyTransferRunService.claimApply(db, stranded.id)).toBe(true);
    await quiet(48 * 3600_000);
    expect((await companyTransferRunService.getRun(db, stranded.id))!.status).toBe("applying");
    expect(await exists(stranded.id)).toBe(true);
  });

  it("retains another upload's wake while an earlier cleanup is running", async () => {
    const first = await transfer(), second = await transfer();
    await spool(first.id); await companyTransferRunService.cancel(db, first.id);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const began = new Promise<void>(resolve => { entered = resolve; });
    const original = fs.rm.bind(fs);
    vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (String(target) === path.join(root, first.id)) { entered(); await gate; }
      return original(target, options);
    });
    const starting = start(); await began;
    try { await spool(second.id); await companyTransferRunService.cancel(db, second.id); }
    finally { release(); }
    await starting; await settle();
    expect(await exists(first.id)).toBe(false); expect(await exists(second.id)).toBe(false); await quiet();
  });

  it("retains a failed database read through drain and recovers without losing the files", async () => {
    const run = await transfer(); await spool(run.id); await companyTransferRunService.cancel(db, run.id);
    const reader = vi.spyOn(companyTransferRunService, "getCleanupState").mockRejectedValue(new Error("database unavailable"));
    await start(); expect(errors.splice(0)).toHaveLength(1); expect(await exists(run.id)).toBe(true);
    admitted = false; await quiet(); expect(await exists(run.id)).toBe(true);
    reader.mockRestore(); admitted = true; worker!.wake(); await settle();
    expect(await exists(run.id)).toBe(false); await quiet();
  });

  it("cleans readable uploads while a different directory remains inaccessible", async () => {
    const denied = await transfer(), healthy = await transfer();
    await spool(denied.id); await spool(healthy.id);
    await companyTransferRunService.cancel(db, denied.id); await companyTransferRunService.cancel(db, healthy.id);
    const original = fs.lstat.bind(fs); let inaccessible = true;
    const stat = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      if (String(args[0]) === path.join(root, denied.id) && inaccessible)
        throw Object.assign(new Error("one directory denied"), { code: "EACCES" });
      return original(...args);
    });
    await start(); await settle();
    expect(errors.splice(0)).toHaveLength(1);
    expect(await exists(healthy.id)).toBe(false);
    expect(await fs.readFile(path.join(root, denied.id, "part-0"), "utf8")).toBe("saved parts");
    expect(coordinator!.nextWakeAt()).not.toBeNull();
    inaccessible = false;
    await vi.advanceTimersByTimeAsync(31_000); await settle(); stat.mockRestore();
    expect(await exists(denied.id)).toBe(false); await quiet();
  });

  it("does not treat a database outage as evidence that old files are orphaned", async () => {
    const run = await transfer();
    await writeImportTransferPart(root, run.id, 0, Buffer.from("keep this upload"));
    const old = new Date(Date.now() - 25 * 3600_000);
    await fs.utimes(path.join(root, run.id), old, old);
    vi.spyOn(db, "select").mockImplementation(() => { throw new Error("database unavailable"); });
    await expect(sweepAbandonedImportTransferSpools(db, root)).rejects.toThrow("database unavailable");
    expect(await fs.readFile(path.join(root, run.id, "part-0"), "utf8")).toBe("keep this upload");
  });
});
