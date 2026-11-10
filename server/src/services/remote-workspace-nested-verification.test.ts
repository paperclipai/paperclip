import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, companies, createDb, executionWorkspaceSnapshots, executionWorkspaces, issues, projects, workspaceOperations } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import type { StorageService } from "../storage/types.js";
import { migrateRemoteWorkspace } from "./remote-workspace-migration.js";
import * as workspaceArchive from "./remote-workspace-snapshot-archive.js";
import { createNestedWorkspaceImportVerifier } from "./remote-workspace-migration-tree.js";
import { withWorkspaceSourceLocks } from "./workspace-source-lock.js";

const support = await getEmbeddedPostgresTestSupport(), execute = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execute("git", ["-c", `core.hooksPath=${os.devNull}`, "-C", cwd, ...args], {
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Nested import", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Nested import", GIT_COMMITTER_EMAIL: "fixture@example.test" },
})).stdout.trim();

describe.skipIf(!support.supported)("nested workspace migration references", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, home: string, storage: StorageService;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("nested-verification-"); db = createDb(database.connectionString, { maxConnections: 8 }); }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pc-nested-verification-")));
    vi.stubEnv("PAPERCLIP_HOME", home); vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "61".repeat(32));
    storage = createStorageService(createLocalDiskStorageProvider(path.join(home, "objects")));
  });
  afterEach(async () => {
    vi.restoreAllMocks(); await db.delete(activityLog); await db.delete(workspaceOperations); await db.delete(executionWorkspaceSnapshots);
    await db.delete(issues); await db.delete(executionWorkspaces); await db.delete(projects); await db.delete(companies);
    vi.unstubAllEnvs(); await fs.rm(home, { recursive: true, force: true });
  });
  async function fixture() {
    const companyId = randomUUID(), projectId = randomUUID(), root = resolveManagedProjectWorkspaceDir({ companyId, projectId });
    await db.insert(companies).values({ id: companyId, name: "Cohort", issuePrefix: `C${companyId.slice(0, 6)}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "Shared Git" });
    await fs.mkdir(root, { recursive: true }); await fs.writeFile(path.join(root, "saved.txt"), "committed base\n");
    await git(root, "init", "-qb", "main"); await git(root, "add", "."); await git(root, "commit", "-qm", "Original history");
    const repoUrl = "https://example.invalid/cohort.git"; await git(root, "remote", "add", "origin", repoUrl);
    const members = [];
    for (const name of ["base", "one", "two"]) {
      const cwd = name === "base" ? root : path.join(root, ".paperclip", "worktrees", name);
      if (name !== "base") await git(root, "worktree", "add", "-qb", name, cwd);
      const [issue] = await db.insert(issues).values({ companyId, projectId, title: name }).returning();
      const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId, sourceIssueId: issue.id, name,
        mode: name === "base" ? "shared_workspace" : "isolated_workspace", strategyType: name === "base" ? "project_primary" : "git_worktree",
        providerType: name === "base" ? "local_fs" : "git_worktree", cwd, providerRef: cwd, repoUrl, branchName: name === "base" ? "main" : name }).returning();
      await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, issue.id));
      if (name !== "base") { await fs.writeFile(path.join(cwd, "saved.txt"), `${name} dirty tracked work\n`); await fs.writeFile(path.join(cwd, "untracked.txt"), `${name} untracked work\n`); }
      members.push(workspace);
    }
    return { companyId, projectId, root, parent: members[0], leaves: members.slice(1) };
  }
  async function imported(grandchildren = false) {
    const f = await fixture();
    const descendants = [];
    if (grandchildren) for (const child of f.leaves) {
      const cwd = path.join(child.cwd!, ".paperclip", "worktrees", "nested"), name = `nested-${child.name}`;
      await git(f.root, "worktree", "add", "-qb", name, cwd);
      const [issue] = await db.insert(issues).values({ companyId: f.companyId, projectId: f.projectId, title: name }).returning();
      const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, projectId: f.projectId,
        sourceIssueId: issue.id, name, mode: "isolated_workspace", strategyType: "git_worktree", providerType: "git_worktree",
        cwd, providerRef: cwd, repoUrl: child.repoUrl, branchName: name }).returning();
      await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, issue.id));
      await fs.writeFile(path.join(cwd, "untracked.txt"), name); descendants.push(workspace);
    }
    for (const workspace of descendants) {
      await migrateRemoteWorkspace({ db, storage, companyId: f.companyId, workspaceId: workspace.id, apply: true,
        signal: AbortSignal.timeout(50_000) });
    }
    for (const workspace of f.leaves) await migrateRemoteWorkspace({ db, storage, companyId: f.companyId, workspaceId: workspace.id,
      apply: true, signal: AbortSignal.timeout(50_000) });
    const snapshots = await db.select().from(executionWorkspaceSnapshots);
    return { ...f, snapshots, descendants, keys: new Set(snapshots.map(snapshot => snapshot.objectKey!)) };
  }
  const parent = (f: Awaited<ReturnType<typeof imported>>) =>
    migrateRemoteWorkspace({ db, storage, companyId: f.companyId, workspaceId: f.parent.id, apply: true, signal: AbortSignal.timeout(20_000) });
  it("retains transitive committed children without downloading, restoring, or recapturing them", async () => {
    const f = await imported(true), get = vi.spyOn(storage, "getObject"), head = vi.spyOn(storage, "headObject");
    const capture = vi.spyOn(workspaceArchive, "captureRemoteWorkspaceDirectory"), restore = vi.spyOn(workspaceArchive, "restoreRemoteWorkspaceArchive");
    expect(await parent(f)).toMatchObject({ applied: true });
    expect(get).not.toHaveBeenCalled(); expect(head).not.toHaveBeenCalled(); expect(restore).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledTimes(1);
    const [snapshot] = await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.executionWorkspaceId, f.parent.id));
    expect(snapshot.metadata?.importedWorkspaceChildren).toHaveLength(2);
    expect((snapshot.metadata!.importedWorkspaceChildren as Array<{ workspaceId: string }>).map(child => child.workspaceId).sort())
      .toEqual(f.leaves.map(child => child.id).sort());
    expect((await db.select().from(executionWorkspaceSnapshots)).every(row => !row.metadata?.nestedImportVerification)).toBe(true);
    for (const descendant of f.descendants) expect(await fs.readFile(path.join(descendant.cwd!, "untracked.txt"), "utf8")).toBe(descendant.name);
  });
  it.each(["local edit", "missing object"])("trusts a committed child's recorded upload after a %s", async mode => {
    const f = await imported();
    if (mode === "local edit") await fs.writeFile(path.join(f.leaves[0].cwd!, "untracked.txt"), "later local bytes\n");
    else await storage.deleteObject(f.companyId, f.snapshots[0].objectKey!);
    const get = vi.spyOn(storage, "getObject"), head = vi.spyOn(storage, "headObject");
    expect(await parent(f)).toMatchObject({ applied: true });
    expect(get).not.toHaveBeenCalled(); expect(head).not.toHaveBeenCalled();
    const [snapshot] = await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.executionWorkspaceId, f.parent.id));
    expect(snapshot.metadata?.importedWorkspaceChildren).toHaveLength(2);
    if (mode === "local edit") expect(await fs.readFile(path.join(f.leaves[0].cwd!, "untracked.txt"), "utf8")).toBe("later local bytes\n");
  });
  it("still refuses a child snapshot binding changed during the parent upload", async () => {
    const f = await imported(), put = storage.putFile.bind(storage);
    vi.spyOn(storage, "putFile").mockImplementation(async input => {
      const result = await put(input);
      await db.update(executionWorkspaceSnapshots).set({ manifestDigest: "f".repeat(64) }).where(eq(executionWorkspaceSnapshots.id, f.snapshots[0].id));
      return result;
    });
    await expect(parent(f)).rejects.toThrow("online_workspace_source_scope_changed");
    const [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.parent.id));
    expect(readRemoteWorkspaceAuthority(row.metadata)).toBeNull();
    expect(await fs.readFile(path.join(f.root, "saved.txt"), "utf8")).toBe("committed base\n");
  });
  it("refuses a selector inherited from another source-owner transaction", async () => {
    const f = await imported(); let verifier!: ReturnType<typeof createNestedWorkspaceImportVerifier>;
    await withWorkspaceSourceLocks(db, { companyId: f.companyId, projectIds: [f.projectId] }, async sourceLock => {
      verifier = createNestedWorkspaceImportVerifier({ db, storage, companyId: f.companyId, projectIds: [f.projectId], issueIds: [], sourceLock });
    });
    try {
      await withWorkspaceSourceLocks(db, { companyId: f.companyId, projectIds: [f.projectId] }, async () => {
        await expect(verifier.prepare({ workspace: f.parent, scratch: home, recordedChildren: [] })).rejects.toThrow("nested_workspace_source_fence_changed");
      });
    } finally { await verifier.close(); }
    await expect(verifier.prepare({ workspace: f.parent, scratch: home, recordedChildren: [] })).rejects.toThrow("nested_workspace_verifier_unavailable");
  });
});
