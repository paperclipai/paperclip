import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, applyPendingMigrations, closeRegisteredClients, companies, createDb, executionWorkspaceSnapshots,
  executionWorkspaceRuntimeLeases, executionWorkspaces, issues, projects, projectWorkspaces, workspaceOperations, workspaceRuntimeServices } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import type { StorageService } from "../storage/types.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { inventoryRemoteWorkspaceMigration, migrateRemoteWorkspace } from "./remote-workspace-migration.js";
import { getWorkspaceSnapshot, loadWorkspaceSnapshotArchive } from "./remote-workspace-snapshot-storage.js";
import { restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";
import { removeTaskDirectoryTree } from "./isolated-task-directory-snapshot.js";

const execute = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execute("git", ["-C", cwd, ...args], { env: { ...process.env,
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_AUTHOR_NAME: "Migration", GIT_COMMITTER_NAME: "Migration",
  GIT_AUTHOR_EMAIL: "migration@example.test", GIT_COMMITTER_EMAIL: "migration@example.test" } })).stdout.trim();

const url = process.env.PAPERCLIP_TEST_DATABASE_URL;
if (url && !/^remote_workspace_[a-z_]*test$/.test(new URL(url).pathname.slice(1))) throw new Error("Disposable remote_workspace_*test database required");
const support = url ? { supported: true } : await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("remote workspace migration", () => {
  let db: ReturnType<typeof createDb>, root: string, storage: StorageService;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    if (url) { await applyPendingMigrations(url); db = createDb(url); }
    else { temporary = await startEmbeddedPostgresTestDatabase("workspace-migration-"); db = createDb(temporary.connectionString); }
  }, 90_000);
  afterAll(async () => { if (url) await closeRegisteredClients(url, { scope: "database" }); else await temporary?.cleanup(); });
  beforeEach(async () => { vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "61".repeat(32));
    root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-migration-test-")); storage = createStorageService(createLocalDiskStorageProvider(path.join(root, "objects"))); });
  afterEach(async () => {
    vi.unstubAllEnvs(); await db.delete(activityLog); await db.delete(workspaceOperations); await db.delete(executionWorkspaceSnapshots);
    await db.delete(workspaceRuntimeServices); await db.delete(executionWorkspaceRuntimeLeases);
    await db.delete(issues); await db.delete(executionWorkspaces); await db.delete(projectWorkspaces); await db.delete(projects);
    await db.delete(companies); await fs.rm(root, { recursive: true, force: true });
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
  it.each([false, true])("removes plaintext verification files with read-only folders after import (source changed: %s)", async sourceChanged => {
    const f = await seed(), protectedDir = path.join(f.cwd, "protected"), scratchRoot = path.join(root, "scratch");
    await fs.mkdir(protectedDir); await fs.mkdir(scratchRoot);
    await fs.writeFile(path.join(protectedDir, "saved.txt"), "read-only saved work\n", { mode: 0o444 });
    await fs.chmod(protectedDir, 0o555);
    vi.stubEnv("TMPDIR", scratchRoot);
    const get = storage.getObject.bind(storage); let reads = 0;
    if (sourceChanged) storage.getObject = async (...args) => {
      if (++reads === 2) await fs.writeFile(path.join(f.cwd, "saved.txt"), "new local work\n");
      return get(...args);
    };
    try {
      const migration = migrateRemoteWorkspace({ db, storage, ...f, apply: true });
      if (sourceChanged) {
        await expect(migration).rejects.toThrow("remote_workspace_migration_source_changed");
        expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
      } else {
        await expect(migration).resolves.toMatchObject({ applied: true, alreadyMigrated: true });
        expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)?.snapshotId).toBeTruthy();
      }
      expect(await fs.readdir(scratchRoot)).toEqual([]);
      expect((await fs.stat(protectedDir)).mode & 0o777).toBe(0o555);
      expect((await fs.stat(path.join(protectedDir, "saved.txt"))).mode & 0o777).toBe(0o444);
      expect(await fs.readFile(path.join(protectedDir, "saved.txt"), "utf8")).toBe("read-only saved work\n");
    } finally {
      await fs.chmod(protectedDir, 0o755);
      await removeTaskDirectoryTree(scratchRoot);
    }
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
  it("imports dirty unpushed Git work and restores it after the original folder disappears", async () => {
    const f = await seed(); await git(f.cwd, "init", "-q", "-b", "feature");
    await git(f.cwd, "add", "."); await git(f.cwd, "commit", "-qm", "unpushed work");
    await git(f.cwd, "remote", "add", "origin", "https://example.invalid/repository.git");
    const head = await git(f.cwd, "rev-parse", "HEAD");
    await fs.writeFile(path.join(f.cwd, "saved.txt"), "staged edit\n"); await git(f.cwd, "add", "saved.txt");
    await fs.writeFile(path.join(f.cwd, "saved.txt"), "unstaged edit\n");
    await db.update(executionWorkspaces).set({ repoUrl: "https://example.invalid/repository.git", branchName: "feature" }).where(eq(executionWorkspaces.id, f.workspaceId));
    await migrateRemoteWorkspace({ db, storage, ...f, apply: true });
    const authority = readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)!;
    const ref = await getWorkspaceSnapshot(db, { ...f, snapshotId: authority.snapshotId! });
    await fs.rm(f.cwd, { recursive: true });
    const archivePath = path.join(root, "cold.pcws"), targetDir = path.join(root, "cold");
    await loadWorkspaceSnapshotArchive({ storage, reference: ref!, targetPath: archivePath });
    await restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: ref!.manifestDigest });
    expect(await git(targetDir, "rev-parse", "HEAD")).toBe(head);
    expect(await git(targetDir, "show", ":saved.txt")).toBe("staged edit");
    expect(await fs.readFile(path.join(targetDir, "saved.txt"), "utf8")).toBe("unstaged edit\n");
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
  it.each(["running", "starting", "unknown", "failed"])("blocks a %s local service after its control lease expires", async status => {
    const f = await seed(), serviceId = randomUUID();
    await db.insert(executionWorkspaceRuntimeLeases).values({ companyId: f.companyId, executionWorkspaceId: f.workspaceId,
      ownerKey: `issue:${f.issueId}`, ownerIssueId: f.issueId, lastAction: "start", expiresAt: new Date(Date.now() - 60_000) });
    await db.insert(workspaceRuntimeServices).values({ id: serviceId, companyId: f.companyId, executionWorkspaceId: f.workspaceId,
      scopeType: "execution_workspace", scopeId: f.workspaceId, serviceName: "Synthetic preview", status,
      lifecycle: "shared", provider: "local_process", command: "node synthetic-preview.js", cwd: f.cwd });
    expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: false, reasons: ["workspace_runtime_service_unsettled"] });
    expect(await migrateRemoteWorkspace({ db, storage, ...f })).toMatchObject({ applied: false, eligible: false });
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("workspace_runtime_service_unsettled");
    expect((await workspace(f.workspaceId)).providerType).toBe("local_fs");
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
    expect(await db.select().from(workspaceOperations)).toHaveLength(0);
    expect(await db.select().from(executionWorkspaceSnapshots)).toHaveLength(0);
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("original saved work\n");
    await db.$client`update workspace_runtime_services set status = 'stopped' where id = ${serviceId}::uuid`;
    expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: true, reasons: [] });
  });
  it.each([{ repository: { phase: "cleanup" } }, "unrecognized-state"])("blocks an unresolved or malformed nested clone migration marker: %j", async marker => {
    const f = await seed();
    await db.update(executionWorkspaces).set({ metadata: { retainedNote: "keep", nestedCloneMigrationPending: marker } }).where(eq(executionWorkspaces.id, f.workspaceId));
    expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: false, reasons: ["nested_clone_migration_unresolved"] });
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("nested_clone_migration_unresolved");
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("original saved work\n");
  });
  it("blocks a running project service inherited by a shared workspace", async () => {
    const f = await seed(), projectId = randomUUID(), projectWorkspaceId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: f.companyId, name: "Shared synthetic project" });
    await db.insert(projectWorkspaces).values({ id: projectWorkspaceId, companyId: f.companyId, projectId,
      name: "Shared synthetic source", sourceType: "local", cwd: f.cwd });
    await db.update(executionWorkspaces).set({ mode: "shared_workspace", projectId, projectWorkspaceId }).where(eq(executionWorkspaces.id, f.workspaceId));
    await db.insert(workspaceRuntimeServices).values({ id: randomUUID(), companyId: f.companyId, projectWorkspaceId,
      scopeType: "project_workspace", scopeId: projectWorkspaceId, serviceName: "Inherited preview", status: "running",
      lifecycle: "shared", provider: "local_process", cwd: f.cwd });
    expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: false, reasons: ["workspace_runtime_service_unsettled"] });
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("workspace_runtime_service_unsettled");
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("original saved work\n");
  });
  it("rechecks a service that becomes unresolved during snapshot verification", async () => {
    const f = await seed(), get = storage.getObject.bind(storage); let reads = 0;
    storage.getObject = async (...args) => {
      if (++reads === 2) await db.insert(workspaceRuntimeServices).values({ id: randomUUID(), companyId: f.companyId,
        executionWorkspaceId: f.workspaceId, scopeType: "execution_workspace", scopeId: f.workspaceId,
        serviceName: "Late synthetic preview", status: "running", lifecycle: "shared", provider: "local_process", cwd: f.cwd });
      return get(...args);
    };
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("workspace_runtime_service_unsettled");
    expect(readRemoteWorkspaceAuthority((await workspace(f.workspaceId)).metadata)).toBeNull();
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("original saved work\n");
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
