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
import { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { notifyRemoteWorkspaceSnapshots, registerRemoteWorkspaceSnapshotRetentionWork, remoteWorkspaceSnapshotRetentionService } from "./remote-workspace-snapshot-retention.js";

const url = process.env.PAPERCLIP_TEST_DATABASE_URL;
if (url && !/^remote_workspace_[a-z_]*test$/.test(new URL(url).pathname.slice(1))) throw new Error("Disposable remote_workspace_*test database required");
describe.skipIf(!url)("remote workspace snapshot retention", () => {
  let db: ReturnType<typeof createDb>, root: string, storage: StorageService;
  const now = new Date("2026-10-30T12:00:00Z");
  beforeAll(async () => { await applyPendingMigrations(url!); db = createDb(url!); });
  afterAll(async () => { if (url) await closeRegisteredClients(url, { scope: "database" }); });
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-retention-test-")); storage = createStorageService(createLocalDiskStorageProvider(root)); });
  afterEach(async () => {
    await db.delete(issueRecoveryActions); await db.delete(workspaceOperations); await db.delete(executionWorkspaceSnapshots);
    await db.delete(issues); await db.delete(executionWorkspaces); await db.delete(companies);
    await fs.rm(root, { recursive: true, force: true });
  });
  async function seed(status: "superseded" | "pending" | "uploaded" | "committed" = "superseded") {
    const companyId = randomUUID(), workspaceId = randomUUID(), id = randomUUID(), operationId = randomUUID();
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
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    await new Promise(resolve => setTimeout(resolve, 30)); expect(run).toHaveBeenCalledOnce();
    const f = await seed();
    await db.transaction(async tx => { await notifyRemoteWorkspaceSnapshots(tx, `workspace:${f.workspaceId}`); });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect((await storage.headObject(f.companyId, f.keys[0]!)).exists).toBe(false);
    await worker.stop(); await coordinator.stop();
  });
});
