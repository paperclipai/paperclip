import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { companies, companySkills, companySkillVersions as versions, companySkillRepositorySnapshots as snapshots, skillPackageDeletions, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { skillPackageWork } from "./skill-package-work.js";
import { skillPackageStore } from "./skill-package-store.js";
import { skillSnapshotHash } from "./skill-snapshot.js";
import { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { idleWorkSnapshot } from "./task-admission.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { logger } from "../middleware/logger.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("automatic skill package work", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let storage: ReturnType<typeof createStorageService>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const files = [{ path: "SKILL.md", kind: "skill" as const, content: "---\nname: legacy\n---\noriginal" }];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("skill-package-work-");
    db = createDb(database.connectionString, { maxConnections: 2 });
    home = await fs.mkdtemp(path.join(os.tmpdir(), "skill-package-work-"));
    process.env.PAPERCLIP_HOME = home;
    storage = createStorageService(createLocalDiskStorageProvider(path.join(home, "objects")));
  });
  beforeEach(async () => {
    await db.execute(sql`truncate companies cascade`);
    await db.execute(sql`truncate skill_package_deletions`);
  });
  afterEach(async () => { await coordinator?.stop(); coordinator = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 1 }); await database?.cleanup();
    if (home) await fs.rm(home, { recursive: true, force: true });
  });
  async function company() {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: "Migration", issuePrefix: "MIG" });
    return id;
  }
  it("stops querying after empty startup and retains a first committed wake through drain", async () => {
    const companyId = await company();
    let draining = false;
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining, canReconcile: () => true, onError: error => { throw error; } });
    const work = skillPackageWork(db, storage).start(coordinator);
    await work.ready;
    expect(coordinator.nextWakeAt()).toBeNull();
    let queries = 0;
    const debug = db.$client.options.debug;
    db.$client.options.debug = () => { queries++; };
    try {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(queries).toBe(0);
      draining = true;
      let id: string;
      await db.transaction(async tx => {
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.skillPackages);
        [id] = (await tx.insert(snapshots).values({ companyId, contentHash: skillSnapshotHash(files), fileInventory: files }).returning({ id: snapshots.id })).map(row => row.id);
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
      const baseline = queries;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(queries).toBe(baseline);
      draining = false;
      work.wake();
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(async () => {
        const [row] = await db.select().from(snapshots).where(eq(snapshots.id, id!));
        expect(row!.fileInventory).toEqual([]);
        expect(row!.storage).not.toBeNull();
      });
    } finally { db.$client.options.debug = debug; }
  });
  it("keeps legacy contents on failure, persists a retry and resumes after restart", async () => {
    const companyId = await company();
    const [row] = await db.insert(snapshots).values({ companyId, contentHash: skillSnapshotHash(files), fileInventory: files }).returning();
    const upload = vi.spyOn(storage, "putFile").mockRejectedValue(new Error("offline"));
    const service = skillPackageWork(db, storage);
    await service.tick(new AbortController().signal);
    const [failed] = await db.select().from(snapshots).where(eq(snapshots.id, row!.id));
    expect(failed!.fileInventory).toEqual(files);
    expect(failed!.migrationAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await service.deadline()).toBe(failed!.migrationAt!.getTime());
    upload.mockRestore();
    await db.update(snapshots).set({ migrationAt: new Date(0), upload: { ...failed!.upload!, expiresAt: new Date(0).toISOString() } }).where(eq(snapshots.id, row!.id));
    await skillPackageWork(db, storage).tick(new AbortController().signal);
    const [saved] = await db.select().from(snapshots).where(eq(snapshots.id, row!.id));
    expect(saved!.fileInventory).toEqual([]);
    expect(saved!.migrationAt).toBeNull();
    expect(await skillPackageStore(db, storage).files(companyId, row!.id)).toEqual(files);
  });
  it("reports a safe conversion failure reason without logging the legacy payload", async () => {
    const companyId = await company();
    const legacy = [{ ...files[0]!, content: "private payload" }];
    const [row] = await db.insert(snapshots).values({ companyId, contentHash: skillSnapshotHash(files), fileInventory: legacy, migrationAt: new Date(0) }).returning();
    const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
    await skillPackageWork(db, storage).tick(new AbortController().signal);
    expect(warning).toHaveBeenCalledWith({ packageId: row!.id, failure: { reason: "legacy_hash_mismatch", errorCode: "unknown" } }, expect.any(String));
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private payload");
  });
  it.each(["manifest.json", "files.tar.gz"])("stops conversion during a stalled %s read and retains legacy bytes", async object => {
    const companyId = await company();
    const packageId = await skillPackageStore(db, storage).prepare(companyId, files);
    const [skill] = await db.insert(companySkills).values({ companyId, key: "legacy", slug: "legacy", name: "Legacy", markdown: files[0]!.content }).returning();
    const [version] = await db.insert(versions).values({ companyId, companySkillId: skill!.id, revisionNumber: 1, fileInventory: files, migrationAt: new Date(0),
      ...(object === "manifest.json" ? { repositorySnapshotId: packageId, repositorySkillPath: "SKILL.md" } : { packageSnapshotId: packageId }) }).returning();
    const get = storage.getObject.bind(storage);
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    let pendingSignal: AbortSignal | undefined;
    let releasePending: () => void = () => {};
    vi.spyOn(storage, "getObject").mockImplementation(async (companyId, key, options) => {
      if (!key.endsWith(object)) return get(companyId, key, options);
      pendingSignal = options?.signal;
      signalStarted();
      return new Promise<never>((_resolve, reject) => {
        releasePending = () => reject(new Error("Test released stalled read"));
        pendingSignal?.addEventListener("abort", () => reject(pendingSignal!.reason), { once: true });
      });
    });
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: () => {} });
    skillPackageWork(db, storage).start(coordinator);
    await started;
    const stopping = coordinator.stop();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([stopping, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Conversion did not stop promptly")), 1_000);
      })]);
      expect(pendingSignal?.aborted).toBe(true);
      const [saved] = await db.select().from(versions).where(eq(versions.id, version!.id));
      expect(saved!.fileInventory).toEqual(files);
      expect(saved!.migrationAt).not.toBeNull();
    } finally { clearTimeout(timeout); releasePending(); await stopping; }
  });
  it.each([
    ["deleteObject", "stop"], ["headObject", "stop"], ["deleteObject", "deadline"], ["headObject", "deadline"],
  ] as const)("releases a stalled %s on %s and retains its deletion receipt", async (method, cancellation) => {
    const companyId = await company();
    const [receipt] = await db.insert(skillPackageDeletions).values({ companyId, provider: "local_disk",
      archiveKey: `${companyId}/expired/archive`, manifestKey: `${companyId}/expired/manifest`, deleteAfter: new Date(0) }).returning();
    const provider = createLocalDiskStorageProvider(path.join(home, "objects"));
    let signalStarted: () => void = () => {};
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    let pendingSignal: AbortSignal | undefined;
    vi.spyOn(provider, method).mockImplementation(async input => {
      pendingSignal = input.signal;
      signalStarted();
      return new Promise<never>(() => {});
    });
    const timeout = new AbortController();
    const deadline = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: () => {} });
    const work = skillPackageWork(db, createStorageService(provider)).start(coordinator);
    await started;
    expect(deadline).toHaveBeenCalledWith(30_000);
    if (cancellation === "stop") await coordinator.stop();
    else { timeout.abort(new Error("Storage deadline exceeded")); await work.ready; }
    expect(pendingSignal?.aborted).toBe(true);
    const [saved] = await db.select().from(skillPackageDeletions).where(eq(skillPackageDeletions.id, receipt!.id));
    expect(saved).toBeDefined();
    if (cancellation === "deadline") expect(saved!.deleteAfter.getTime()).toBeGreaterThan(Date.now());
  });
});
