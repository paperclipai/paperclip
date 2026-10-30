import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { applyPendingMigrations, closeRegisteredClients, companies, createDb, executionWorkspaceSnapshots,
  executionWorkspaces, issueRecoveryActions, issues, workspaceOperations } from "@paperclipai/db";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import type { StorageService } from "../storage/types.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { notifyRemoteWorkspaceSnapshots, registerRemoteWorkspaceSnapshotRetentionWork, remoteWorkspaceSnapshotRetentionService } from "./remote-workspace-snapshot-retention.js";

const url = process.env.PAPERCLIP_TEST_DATABASE_URL;
if (url && !/^remote_workspace_[a-z_]*test$/.test(new URL(url).pathname.slice(1))) throw new Error("Disposable remote_workspace_*test database required");
const support = url ? { supported: true } : await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("remote workspace snapshot retention", () => {
  let db: ReturnType<typeof createDb>, root: string, storage: StorageService;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  const now = new Date("2026-10-30T12:00:00Z");
  beforeAll(async () => {
    if (url) { await applyPendingMigrations(url); db = createDb(url); }
    else { temporary = await startEmbeddedPostgresTestDatabase("workspace-snapshot-retention-"); db = createDb(temporary.connectionString); }
  }, 90_000);
  afterAll(async () => { if (url) await closeRegisteredClients(url, { scope: "database" }); else await temporary?.cleanup(); });
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-retention-test-")); storage = createStorageService(createLocalDiskStorageProvider(root)); });
  afterEach(async () => {
    await db.delete(issueRecoveryActions); await db.delete(workspaceOperations); await db.delete(executionWorkspaceSnapshots);
    await db.delete(issues); await db.delete(executionWorkspaces); await db.delete(companies);
    await fs.rm(root, { recursive: true, force: true });
  });
  async function seed(status: "superseded" | "pending" | "uploaded" | "committed" = "superseded", id = randomUUID()) {
    const companyId = randomUUID(), workspaceId = randomUUID(), operationId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retention", issuePrefix: `R${companyId.slice(0, 6)}` });
    const [issue] = await db.insert(issues).values({ companyId, title: "Retention source" }).returning();
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issue!.id,
      mode: "isolated_workspace", strategyType: "project_primary", name: "Retained" });
    const keys = ["winner", "ambiguous"].map(name => `${companyId}/workspace-snapshots/${workspaceId}/${id}/${name}.pcws`);
    for (const objectKey of keys) await storage.putFile({ objectKey, companyId, namespace: "workspace-snapshots", originalFilename: null,
      contentType: "application/octet-stream", body: Buffer.from("retained bytes") });
    const [row] = await db.insert(executionWorkspaceSnapshots).values({ id, companyId, executionWorkspaceId: workspaceId,
      sourceOperationId: operationId, generation: 1, epoch: 1, status, objectKey: keys[0],
      metadata: { uploads: keys.map(objectKey => ({ objectKey })) },
      deleteAfter: new Date(now.getTime() - 1000), createdAt: new Date(now.getTime() - 10 * 86400_000) }).returning();
    return { row: row!, companyId, workspaceId, issueId: issue!.id, operationId, keys };
  }
  const service = () => remoteWorkspaceSnapshotRetentionService(db, { storage, now: () => now });
  it("deletes every recorded attempt and winning object after grace", async () => {
    const f = await seed(); const owner = service();
    expect(await owner.tick()).toMatchObject({ deleted: 1, failed: 0 });
    for (const key of f.keys) expect((await storage.headObject(f.companyId, key)).exists).toBe(false);
    expect(await owner.nextDeadlineAt()).toBeNull();
  });
  it("pins the current snapshot and leaves no idle deadline", async () => {
    const f = await seed("committed");
    await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: { snapshotId: f.row.id } } }).where(eq(executionWorkspaces.id, f.workspaceId));
    const owner = service(); expect(await owner.tick()).toMatchObject({ pinned: 1, deleted: 0 });
    expect(await owner.nextDeadlineAt()).toBeNull();
    expect((await storage.headObject(f.companyId, f.keys[0]!)).exists).toBe(true);
  });
  it("pins active restore operations and releases an already-due generation on settlement", async () => {
    const f = await seed();
    const [op] = await db.insert(workspaceOperations).values({ companyId: f.companyId, executionWorkspaceId: f.workspaceId,
      phase: "remote_workspace_restore", status: "running", metadata: { snapshotId: f.row.id } }).returning();
    const owner = service(); expect(await owner.tick()).toMatchObject({ pinned: 1 }); expect(await owner.nextDeadlineAt()).toBeNull();
    await db.update(workspaceOperations).set({ status: "succeeded" }).where(eq(workspaceOperations.id, op!.id));
    expect(await owner.tick()).toMatchObject({ deleted: 1 });
  });
  it("leaves healthy current versions outside later unrelated maintenance passes", async () => {
    const current = await seed("committed");
    await db.update(executionWorkspaces).set({ metadata: { remoteWorkspace: { snapshotId: current.row.id } } })
      .where(eq(executionWorkspaces.id, current.workspaceId));
    const owner = service();
    expect(await owner.tick()).toMatchObject({ checked: 1, pinned: 1, deleted: 0 });
    const obsolete = await seed();
    expect(await owner.tick()).toMatchObject({ checked: 1, pinned: 0, deleted: 1 });
    expect((await storage.headObject(current.companyId, current.keys[0]!)).exists).toBe(true);
    expect((await storage.headObject(obsolete.companyId, obsolete.keys[0]!)).exists).toBe(false);
    expect(await owner.nextDeadlineAt()).toBeNull();
  });
  it("revisits a parent when cleanup of an unfinished child releases its last pin", async () => {
    const parent = await seed("superseded", "10000000-0000-4000-8000-000000000001");
    await db.insert(executionWorkspaceSnapshots).values({ id: "20000000-0000-4000-8000-000000000001",
      companyId: parent.companyId, executionWorkspaceId: parent.workspaceId, sourceOperationId: randomUUID(),
      parentSnapshotId: parent.row.id, generation: 2, epoch: 1, status: "pending",
      deleteAfter: new Date(now.getTime() - 1000), createdAt: new Date(now.getTime() - 10 * 86400_000) });
    const owner = service(), coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    const worker = registerRemoteWorkspaceSnapshotRetentionWork(coordinator, owner, () => {});
    try {
      await vi.waitFor(async () => expect((await storage.headObject(parent.companyId, parent.keys[0]!)).exists).toBe(false),
        { timeout: 4000, interval: 40 });
      expect(await owner.nextDeadlineAt()).toBeNull();
    } finally { await worker.stop(); await coordinator.stop(); }
  });
  it("pins an unfinished upload and an active recovery hold", async () => {
    const f = await seed("pending");
    await db.insert(workspaceOperations).values({ id: f.operationId, companyId: f.companyId, executionWorkspaceId: f.workspaceId,
      phase: "remote_workspace_snapshot", status: "running" });
    const owner = service(); expect(await owner.tick()).toMatchObject({ pinned: 1 });
    await db.update(workspaceOperations).set({ status: "failed" }).where(eq(workspaceOperations.id, f.operationId));
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog",
      ownerType: "board", cause: "workspace_recovery", fingerprint: randomUUID(), nextAction: "Recover saved files" });
    expect(await owner.tick()).toMatchObject({ pinned: 1, deleted: 0 }); expect(await owner.nextDeadlineAt()).toBeNull();
  });
  it("rejects a foreign upload key without deleting another company's object", async () => {
    const f = await seed(); const foreignKey = `${randomUUID()}/workspace-snapshots/foreign`;
    await db.update(executionWorkspaceSnapshots).set({ metadata: { uploads: [{ objectKey: foreignKey }] } }).where(eq(executionWorkspaceSnapshots.id, f.row.id));
    expect(await service().tick()).toMatchObject({ failed: 1, deleted: 0 });
    for (const key of f.keys) expect((await storage.headObject(f.companyId, key)).exists).toBe(true);
    expect(await service().nextDeadlineAt()).toBeGreaterThan(now.getTime());
  });
  it("settles without recurring reads and wakes on the first real producer", async () => {
    const owner = service(), coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    const run = vi.spyOn(owner, "tick"); const worker = registerRemoteWorkspaceSnapshotRetentionWork(coordinator, owner, () => {});
    try {
      await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
      await new Promise(resolve => setTimeout(resolve, 30)); expect(run).toHaveBeenCalledOnce();
      const f = await seed();
      await db.transaction(async tx => { await notifyRemoteWorkspaceSnapshots(tx, `workspace:${f.workspaceId}`); });
      await vi.waitFor(async () => expect((await storage.headObject(f.companyId, f.keys[0]!)).exists).toBe(false));
      expect(run).toHaveBeenCalledTimes(2);
    } finally { await worker.stop(); await coordinator.stop(); }
  });
  it("finishes bounded pages and revisits a lower UUID produced during a pass", async () => {
    const later = await seed("superseded", "20000000-0000-4000-8000-000000000001");
    const last = await seed("superseded", "30000000-0000-4000-8000-000000000001");
    let earlier: Awaited<ReturnType<typeof seed>> | undefined;
    const remove = storage.deleteObject.bind(storage); let inserted = false;
    storage.deleteObject = async (...args) => {
      if (!inserted) {
        inserted = true; earlier = await seed("superseded", "10000000-0000-4000-8000-000000000001");
        await db.transaction(async tx => { await notifyRemoteWorkspaceSnapshots(tx, `workspace:${earlier!.workspaceId}`); });
      }
      await remove(...args);
    };
    const owner = remoteWorkspaceSnapshotRetentionService(db, { storage, now: () => now, batchSize: 1 });
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    const run = vi.spyOn(owner, "tick"), worker = registerRemoteWorkspaceSnapshotRetentionWork(coordinator, owner, () => {});
    try {
      await vi.waitFor(async () => {
        expect(earlier).toBeDefined();
        for (const fixture of [earlier!, later, last]) for (const key of fixture.keys) {
          expect((await storage.headObject(fixture.companyId, key)).exists).toBe(false);
        }
      }, { timeout: 8000, interval: 40 });
      expect(await owner.nextDeadlineAt()).toBeNull();
      const completed = run.mock.calls.length; await new Promise(resolve => setTimeout(resolve, 100));
      expect(run).toHaveBeenCalledTimes(completed);
    } finally { await worker.stop(); await coordinator.stop(); }
  });
  it("becomes quiet while recovery pins a snapshot and wakes on the real recovery resolution", async () => {
    const f = await seed();
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog",
      ownerType: "board", cause: "workspace_recovery", fingerprint: randomUUID(), nextAction: "Recover saved files" });
    const owner = service(), coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    const worker = registerRemoteWorkspaceSnapshotRetentionWork(coordinator, owner, () => {});
    try {
      await worker.ready;
      expect(await owner.nextDeadlineAt()).toBeNull();
      expect((await storage.headObject(f.companyId, f.keys[0]!)).exists).toBe(true);
      const resolved = await issueRecoveryActionService(db).resolveActiveForIssue({ companyId: f.companyId, sourceIssueId: f.issueId,
        status: "resolved", outcome: "restored", resolutionNote: "Verified saved files" });
      expect(resolved?.status).toBe("resolved");
      await vi.waitFor(async () => expect((await storage.headObject(f.companyId, f.keys[0]!)).exists).toBe(false));
      expect(await owner.nextDeadlineAt()).toBeNull();
    } finally { await worker.stop(); await coordinator.stop(); }
  });
});
