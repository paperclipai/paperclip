import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { applyPendingMigrations, closeRegisteredClients, companies, createDb, executionWorkspaceSnapshots,
  executionWorkspaces, issueRecoveryActions, issues, workspaceOperations } from "@paperclipai/db";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import type { StorageService } from "../storage/types.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { idleWorkSnapshot } from "./task-admission.js";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import { notifyRemoteWorkspaceSnapshots, registerRemoteWorkspaceSnapshotRetentionWork, remoteWorkspaceSnapshotRetentionService } from "./remote-workspace-snapshot-retention.js";

const url = process.env.PAPERCLIP_TEST_DATABASE_URL;
if (url && !/^remote_workspace_[a-z_]*test$/.test(new URL(url).pathname.slice(1))) throw new Error("Disposable remote_workspace_*test database required");
const support = url ? { supported: true } : await getEmbeddedPostgresTestSupport();

async function versionedS3Fixture() {
  vi.stubEnv("AWS_ACCESS_KEY_ID", "synthetic-access-key");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "synthetic-secret-key");
  vi.stubEnv("AWS_SESSION_TOKEN", "");
  const versions: { key: string; versionId: string; marker: boolean; size: number }[] = [];
  const requests: { method: string; key: string; versionId: string | null; keyMarker: string | null; versionMarker: string | null }[] = [];
  const faults = { denied: false, listDenied: false, missingCursor: false, repeatCursor: false, preserveVersions: false, hangList: false, abortedLists: 0 };
  let serial = 0;
  const add = (key: string, marker = false, versionId = `version-${++serial}`) => {
    versions.unshift({ key, versionId, marker, size: 14 });
  };
  const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const parsed = new URL(req.url!, "http://fixture.invalid");
      const key = decodeURIComponent(parsed.pathname.replace(/^\/bucket\/?/, ""));
      const versionId = parsed.searchParams.get("versionId");
      const keyMarker = parsed.searchParams.get("key-marker"), versionMarker = parsed.searchParams.get("version-id-marker");
      requests.push({ method: req.method!, key, versionId, keyMarker, versionMarker });
      if (parsed.searchParams.has("versions")) {
        if (faults.listDenied) {
          res.writeHead(403, { "content-type": "application/xml" });
          res.end("<Error><Code>AccessDenied</Code><Message>Version listing permission is required</Message></Error>");
          return;
        }
        if (faults.hangList) { res.on("close", () => { faults.abortedLists++; }); return; }
        const prefix = parsed.searchParams.get("prefix")!;
        const matches = versions.filter(value => value.key.startsWith(prefix)).sort((a, b) => a.key.localeCompare(b.key));
        const start = keyMarker ? matches.findIndex(value => value.key === keyMarker && value.versionId === versionMarker) + 1 : 0;
        const page = matches.slice(start, start + 2), truncated = matches.length > start + page.length;
        const last = faults.repeatCursor && keyMarker ? { key: keyMarker, versionId: versionMarker! } : page.at(-1);
        res.setHeader("content-type", "application/xml");
        res.end(`<?xml version="1.0"?><ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
          `<IsTruncated>${truncated}</IsTruncated>` +
          (truncated && !faults.missingCursor ? `<NextKeyMarker>${xml(last!.key)}</NextKeyMarker><NextVersionIdMarker>${xml(last!.versionId)}</NextVersionIdMarker>` : "") +
          page.map(value => `<${value.marker ? "DeleteMarker" : "Version"}><Key>${xml(value.key)}</Key><VersionId>${xml(value.versionId)}</VersionId>` +
            `<IsLatest>false</IsLatest><LastModified>2026-10-30T12:00:00Z</LastModified>${value.marker ? "" : `<Size>${value.size}</Size>`}</${value.marker ? "DeleteMarker" : "Version"}>`).join("") +
          "</ListVersionsResult>");
      } else if (req.method === "PUT") {
        add(key); res.setHeader("x-amz-version-id", versions[0]!.versionId); res.end();
      } else if (req.method === "DELETE") {
        if (versionId && faults.denied) {
          res.writeHead(403, { "content-type": "application/xml" });
          res.end("<Error><Code>AccessDenied</Code><Message>Object retention forbids deletion</Message></Error>");
          return;
        }
        if (versionId) {
          if (!faults.preserveVersions) {
            const index = versions.findIndex(value => value.key === key && value.versionId === versionId);
            if (index >= 0) versions.splice(index, 1);
          }
        } else add(key, true);
        res.writeHead(204); res.end();
      } else if (req.method === "HEAD") {
        const latest = versions.find(value => value.key === key);
        if (!latest || latest.marker) { res.writeHead(404); res.end(); }
        else { res.setHeader("content-length", latest.size); res.end(); }
      } else { res.writeHead(400); res.end(); }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const provider = createS3StorageProvider({ bucket: "bucket", region: "us-east-1", prefix: "scoped-prefix", endpoint, forcePathStyle: true });
  return { provider, versions, requests, faults, add,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

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
    vi.unstubAllEnvs();
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
  it("purges exact-key S3 versions and delete markers before settling retention", async () => {
    const s3 = await versionedS3Fixture();
    try {
      storage = createStorageService(s3.provider);
      const f = await seed();
      await storage.putFile({ objectKey: f.keys[0]!, companyId: f.companyId, namespace: "workspace-snapshots", originalFilename: null,
        contentType: "application/octet-stream", body: Buffer.from("older retry bytes") });
      await storage.deleteObject(f.companyId, f.keys[0]!);
      expect((await storage.headObject(f.companyId, f.keys[0]!)).exists).toBe(false);
      expect(s3.requests.filter(value => value.method === "GET")).toHaveLength(0);
      const neighbor = `scoped-prefix/${f.keys[0]}-neighbor`;
      s3.add(neighbor);
      s3.add(`scoped-prefix/${f.keys[1]}`, false, "null");
      const owner = service();
      expect(await owner.tick()).toMatchObject({ deleted: 1, failed: 0 });
      expect(s3.versions).toEqual([expect.objectContaining({ key: neighbor })]);
      const versionDeletes = s3.requests.filter(value => value.method === "DELETE" && value.versionId !== null);
      expect(versionDeletes).toHaveLength(5);
      expect(versionDeletes.every(value => f.keys.some(key => value.key === `scoped-prefix/${key}`))).toBe(true);
      expect(s3.requests.some(value => value.keyMarker && value.versionMarker)).toBe(true);
      expect((await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, f.row.id)))[0]!.status).toBe("deleted");
    } finally { await s3.close(); }
  });
  it.each(["missingCursor", "repeatCursor"] as const)("does not settle S3 cleanup with an invalid %s listing", async fault => {
    const s3 = await versionedS3Fixture();
    try {
      storage = createStorageService(s3.provider);
      const f = await seed();
      for (let index = 0; index < 5; index++) s3.add(`scoped-prefix/${f.keys[0]}`);
      s3.faults[fault] = true;
      expect(await service().tick()).toMatchObject({ deleted: 0, failed: 1 });
      expect(s3.requests.filter(value => value.method === "DELETE")).toHaveLength(0);
      expect((await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, f.row.id)))[0])
        .toMatchObject({ status: "delete_requested", lastError: "snapshot_cleanup_failed" });
    } finally { await s3.close(); }
  });
  it.each(["denied", "listDenied", "preserveVersions"] as const)("keeps retryable S3 cleanup for %s and settles after verified recovery", async fault => {
    const s3 = await versionedS3Fixture();
    try {
      storage = createStorageService(s3.provider);
      const f = await seed();
      s3.faults[fault] = true;
      let at = now;
      const owner = remoteWorkspaceSnapshotRetentionService(db, { storage, now: () => at });
      expect(await owner.tick()).toMatchObject({ deleted: 0, failed: 1 });
      expect(s3.versions.length).toBeGreaterThan(0);
      expect((await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, f.row.id)))[0])
        .toMatchObject({ status: "delete_requested", lastError: "snapshot_cleanup_failed" });
      s3.faults[fault] = false;
      at = new Date(now.getTime() + 16 * 60_000);
      expect(await owner.tick()).toMatchObject({ deleted: 1, failed: 0 });
      expect(s3.versions).toEqual([]);
    } finally { await s3.close(); }
  });
  it("cancels an in-flight S3 version listing and leaves its retention obligation intact", async () => {
    const s3 = await versionedS3Fixture();
    try {
      storage = createStorageService(s3.provider);
      const f = await seed();
      const preAborted = new AbortController(); preAborted.abort();
      const before = s3.requests.length;
      await expect(storage.deleteObject(f.companyId, f.keys[0]!, { allVersions: true, signal: preAborted.signal }))
        .rejects.toMatchObject({ name: "AbortError" });
      expect(s3.requests).toHaveLength(before);
      await expect(storage.deleteObject(randomUUID(), f.keys[0]!, { allVersions: true })).rejects.toMatchObject({ status: 403 });
      expect(s3.requests).toHaveLength(before);

      s3.faults.hangList = true;
      const controller = new AbortController();
      const running = service().tick(controller.signal);
      const observed = running.catch(error => error);
      await vi.waitFor(() => expect(s3.requests.some(value => value.method === "GET")).toBe(true));
      controller.abort();
      expect(await observed).toMatchObject({ name: "AbortError" });
      await vi.waitFor(() => expect(s3.faults.abortedLists).toBe(1));
      expect(s3.requests.filter(value => value.method === "DELETE")).toHaveLength(0);
      expect((await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, f.row.id)))[0]!.status)
        .toBe("delete_requested");
    } finally { await s3.close(); }
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
      await vi.waitFor(async () => {
        for (const key of parent.keys) expect((await storage.headObject(parent.companyId, key)).exists).toBe(false);
        const snapshots = await db.select().from(executionWorkspaceSnapshots)
          .where(eq(executionWorkspaceSnapshots.companyId, parent.companyId));
        expect(snapshots).toHaveLength(2);
        expect(snapshots).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: parent.row.id, status: "deleted", deleteAfter: null }),
          expect.objectContaining({ id: "20000000-0000-4000-8000-000000000001", status: "deleted", deleteAfter: null }),
        ]));
        expect(await owner.nextDeadlineAt()).toBeNull();
        expect(idleWorkSnapshot().active).toBe(0);
        expect(coordinator.nextWakeAt()).toBeNull();
      }, { timeout: 4000, interval: 40 });
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
