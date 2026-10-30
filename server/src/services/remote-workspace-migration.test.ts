import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, applyPendingMigrations, closeRegisteredClients, companies, createDb, executionWorkspaceSnapshots,
  executionWorkspaces, issues, workspaceOperations } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import type { StorageService } from "../storage/types.js";
import { inventoryRemoteWorkspaceMigration, migrateRemoteWorkspace } from "./remote-workspace-migration.js";

const url = process.env.PAPERCLIP_TEST_DATABASE_URL;
if (url && !/^remote_workspace_[a-z_]*test$/.test(new URL(url).pathname.slice(1))) throw new Error("Disposable remote_workspace_*test database required");
describe.skipIf(!url)("remote workspace migration", () => {
  let db: ReturnType<typeof createDb>, root: string, storage: StorageService;
  beforeAll(async () => { await applyPendingMigrations(url!); db = createDb(url!); });
  afterAll(async () => { if (url) await closeRegisteredClients(url, { scope: "database" }); });
  beforeEach(async () => { vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "61".repeat(32));
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-migration-test-")); storage = createStorageService(createLocalDiskStorageProvider(path.join(root, "objects"))); });
  afterEach(async () => {
    vi.unstubAllEnvs(); await db.delete(activityLog); await db.delete(workspaceOperations); await db.delete(executionWorkspaceSnapshots);
    await db.delete(issues); await db.delete(executionWorkspaces); await db.delete(companies); await fs.rm(root, { recursive: true, force: true });
  });
  async function seed() {
    const companyId = randomUUID(), workspaceId = randomUUID(), cwd = path.join(root, "original"); await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, "saved.txt"), "original saved work\n");
    await db.insert(companies).values({ id: companyId, name: "Migration", issuePrefix: `M${companyId.slice(0, 6)}` });
    const [issue] = await db.insert(issues).values({ companyId, title: "Existing task" }).returning();
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issue!.id, mode: "isolated_workspace",
      strategyType: "project_primary", providerType: "local_fs", name: "Existing workspace", cwd, providerRef: cwd, metadata: { retainedNote: "keep" } });
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issue!.id));
    return { companyId, workspaceId, issueId: issue!.id, cwd };
  }
  async function workspace(id: string) { return (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, id)))[0]!; }
  it("defaults to dry run and preserves both database authority and local files", async () => {
    const f = await seed(); expect(await migrateRemoteWorkspace({ db, storage, ...f })).toMatchObject({ eligible: true, applied: false, alreadyMigrated: false });
    expect((await workspace(f.workspaceId)).providerType).toBe("local_fs");
    expect(await db.select().from(workspaceOperations)).toHaveLength(0);
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("original saved work\n");
  });
  it("verifies saved files, switches authority once, and retains the original folder", async () => {
    const f = await seed();
    expect(await migrateRemoteWorkspace({ db, storage, ...f, apply: true })).toMatchObject({ applied: true, alreadyMigrated: true });
    const row = await workspace(f.workspaceId), authority = readRemoteWorkspaceAuthority(row.metadata);
    expect(authority).toMatchObject({ epoch: 1, location: null, dirty: false, writerRunId: null });
    expect(authority?.snapshotId).toMatch(/^[a-f0-9-]{36}$/);
    expect(row.metadata?.retainedNote).toBe("keep"); expect(row.metadata?.remoteWorkspaceMigration).toBeUndefined();
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("original saved work\n");
    expect(await migrateRemoteWorkspace({ db, storage, ...f, apply: true })).toMatchObject({ replayed: true });
    expect(await db.select().from(executionWorkspaceSnapshots)).toHaveLength(1);
    expect(await db.select().from(activityLog)).toHaveLength(1);
  });
  it("resumes an interrupted upload with the original operation identity", async () => {
    const f = await seed(), put = storage.putFile.bind(storage); let fail = true;
    storage.putFile = async input => { const saved = await put(input); if (fail) { fail = false; throw new Error("upload reply lost"); } return saved; };
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("upload reply lost");
    const before = await inventoryRemoteWorkspaceMigration(db, f); expect(before.operationId).not.toBeNull();
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
    expect(await migrateRemoteWorkspace({ db, storage, ...f, apply: true })).toMatchObject({ applied: true });
    const operations = await db.select().from(workspaceOperations); expect(operations).toHaveLength(1); expect(operations[0]?.id).toBe(before.operationId);
  });
  it("blocks unresolved writers and explicitly parallel shared workspaces", async () => {
    const f = await seed();
    await db.update(executionWorkspaces).set({ mode: "shared_workspace" }).where(eq(executionWorkspaces.id, f.workspaceId));
    await db.update(issues).set({ executionWorkspaceSettings: { sharedWorkspaceConcurrency: "allow" } }).where(eq(issues.id, f.issueId));
    expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: false, reasons: ["parallel_shared_writers_unsupported"] });
    await db.update(issues).set({ executionWorkspaceSettings: { sharedWorkspaceConcurrency: "serialize" } }).where(eq(issues.id, f.issueId));
    await db.insert(workspaceOperations).values({ companyId: f.companyId, executionWorkspaceId: f.workspaceId, phase: "workspace_command", status: "running" });
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("workspace_operation_unresolved");
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
  });
  it("rechecks a writer that appears while the restored copy is being verified", async () => {
    const f = await seed(), get = storage.getObject.bind(storage); let reads = 0;
    storage.getObject = async (...args) => {
      if (++reads === 2) await db.insert(workspaceOperations).values({ companyId: f.companyId, executionWorkspaceId: f.workspaceId,
        phase: "workspace_command", status: "running" });
      return get(...args);
    };
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("workspace_operation_unresolved");
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
  });
  it("preserves a local edit made during verification and refuses activation", async () => {
    const f = await seed(), get = storage.getObject.bind(storage); let reads = 0;
    storage.getObject = async (...args) => { if (++reads === 2) await fs.writeFile(path.join(f.cwd, "saved.txt"), "new local work\n"); return get(...args); };
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("source_changed");
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("new local work\n");
  });
});
