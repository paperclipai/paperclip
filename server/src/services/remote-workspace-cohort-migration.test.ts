import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, environmentLeases, environments, heartbeatRuns, nativeRunFinalizations, executionWorkspaceSnapshots, executionWorkspaceRestorePoints, executionWorkspaces, issues, projects, projectWorkspaces, workspaceOperations, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import type { StorageService } from "../storage/types.js";
import { migrateRemoteWorkspace, migrateRemoteWorkspaceCohort, supersedeExpiredRemoteWorkspaceMigrationCohort } from "./remote-workspace-migration.js";
import { inspectOnlineWorkspaceSource } from "./online-workspace-source.js";
import { IsolatedRepositorySourceBusy, withWorkspaceSourceLocks } from "./workspace-source-lock.js";
import { getWorkspaceSnapshot, loadWorkspaceSnapshotArchive } from "./remote-workspace-snapshot-storage.js";
import { tryLockNativeWorkspaceFinalization } from "./native-runtime/native-workspace-finalization-ownership.js";
import { subscribeCompanyLiveEvents } from "./live-events.js";
import { restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";
import * as workspaceArchive from "./remote-workspace-snapshot-archive.js";
import * as onlineWorkspaceSource from "./online-workspace-source.js";
import { expireReconstructableGitWorkspace } from "./git-workspace-expiration.js";
import { remoteWorkspaceSnapshotRetentionService } from "./remote-workspace-snapshot-retention.js";

const support = await getEmbeddedPostgresTestSupport(), execute = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execute("git", ["-c", `core.hooksPath=${os.devNull}`, "-C", cwd, ...args], {
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Cohort", GIT_AUTHOR_EMAIL: "cohort@example.test", GIT_COMMITTER_NAME: "Cohort", GIT_COMMITTER_EMAIL: "cohort@example.test" },
})).stdout.trim();

describe.skipIf(!support.supported)("bounded workspace cohort migration", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, home: string, storage: StorageService;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("workspace-cohort-"); db = createDb(database.connectionString, { maxConnections: 8 }); }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pc-workspace-cohort-")));
    vi.stubEnv("PAPERCLIP_HOME", home); vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "61".repeat(32));
    storage = createStorageService(createLocalDiskStorageProvider(path.join(home, "objects")));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(activityLog); await db.delete(workspaceOperations); await db.delete(executionWorkspaceSnapshots); await db.delete(executionWorkspaceRestorePoints);
    await db.execute(sql`drop trigger if exists cohort_publish_probe on execution_workspaces`);
    await db.execute(sql`drop function if exists cohort_publish_probe()`); await db.execute(sql`drop sequence if exists cohort_publish_attempts`);
    await db.execute(sql`drop trigger if exists cohort_commit_fault on workspace_operations`); await db.execute(sql`drop function if exists cohort_commit_fault()`);
    await db.execute(sql`drop trigger if exists cohort_reserve_fault on workspace_operations`); await db.execute(sql`drop function if exists cohort_reserve_fault()`);
    await db.delete(nativeRunFinalizations); await db.delete(environmentLeases); await db.delete(environments); await db.delete(heartbeatRuns);
    await db.delete(issues); await db.delete(agents); await db.delete(executionWorkspaces); await db.delete(projectWorkspaces); await db.delete(projects); await db.delete(companies);
    vi.unstubAllEnvs(); await fs.rm(home, { recursive: true, force: true });
  });
  async function fixture(repoName?: string, leafCount = 2) {
    const companyId = randomUUID(), projectId = randomUUID(), root = resolveManagedProjectWorkspaceDir({ companyId, projectId, repoName });
    await db.insert(companies).values({ id: companyId, name: "Cohort", issuePrefix: `C${companyId.slice(0, 6)}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "Shared Git" });
    await fs.mkdir(root, { recursive: true }); await fs.writeFile(path.join(root, "saved.txt"), "committed base\n");
    await git(root, "init", "-qb", "main"); await git(root, "add", "."); await git(root, "commit", "-qm", "Original history");
    const repoUrl = "https://example.invalid/cohort.git"; await git(root, "remote", "add", "origin", repoUrl);
    const members = [];
    for (const name of ["base", "one", "two", ...Array.from({ length: leafCount - 2 }, (_, index) => `leaf-${index}`)]) {
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
  async function aliasMembers(f: Awaited<ReturnType<typeof fixture>>, base: typeof f.parent, count: number) {
    const tasks = await db.insert(issues).values(Array.from({ length: count - 1 }, (_, index) => ({
      companyId: f.companyId, projectId: f.projectId, title: `Alias ${index}` }))).returning();
    const aliases = await db.insert(executionWorkspaces).values(tasks.map(task => ({ companyId: f.companyId,
      projectId: f.projectId, sourceIssueId: task.id, name: "Alias", mode: base.mode, strategyType: base.strategyType,
      providerType: base.providerType, cwd: base.cwd, providerRef: base.providerRef, repoUrl: base.repoUrl, branchName: base.branchName }))).returning();
    for (const alias of aliases) await db.update(issues).set({ executionWorkspaceId: alias.id }).where(eq(issues.id, alias.sourceIssueId!));
    return [base, ...aliases];
  }
  const run = (f: Awaited<ReturnType<typeof fixture>>, extra: Partial<Parameters<typeof migrateRemoteWorkspaceCohort>[0]> = {}) =>
    migrateRemoteWorkspaceCohort({ db, storage, companyId: f.companyId, workspaceIds: f.leaves.map(row => row.id),
      apply: true, concurrency: 2, signal: AbortSignal.timeout(50_000), ...extra });
  const rows = (f: Awaited<ReturnType<typeof fixture>>) => db.select().from(executionWorkspaces).where(inArray(executionWorkspaces.id, f.leaves.map(row => row.id)));
  async function assertLocal(f: Awaited<ReturnType<typeof fixture>>) {
    expect((await rows(f)).every(row => !readRemoteWorkspaceAuthority(row.metadata))).toBe(true);
    for (const member of f.leaves) expect(await fs.readFile(path.join(member.cwd!, "saved.txt"), "utf8")).toBe(`${member.name} dirty tracked work\n`);
  }
  async function recoverable(f: Awaited<ReturnType<typeof fixture>>) {
    const workspace = f.leaves[0], runId = randomUUID(), leaseId = randomUUID(), providerLeaseId = randomUUID();
    const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Held recovery", adapterType: "paperclip_runner" }).returning();
    const [environment] = await db.insert(environments).values({ name: runId, driver: "daytona" }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: agent.id, nativeIssueId: workspace.sourceIssueId,
      runtimeMode: "native", status: "failed", runnerProfileJson: { nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v3",
        state: "prepared", workspaceId: workspace.id, leaseId, providerLeaseId, remoteCwd: "/workspaces/held",
        descriptorSha256: "12".repeat(32), baselineSha256: "34".repeat(32), resourceDisposition: "keep_running" } } });
    await db.insert(environmentLeases).values({ id: leaseId, companyId: f.companyId, issueId: workspace.sourceIssueId,
      heartbeatRunId: runId, executionWorkspaceId: workspace.id, environmentId: environment.id, provider: "daytona", providerLeaseId,
      status: "retained", leasePolicy: "retain_on_failure", metadata: { remoteCwd: "/workspaces/held" } });
    const [owner] = await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: workspace.sourceIssueId!,
      runId, phase: "terminal_failure", failureCode: "native_session_interrupted" }).returning();
    return { runId, owner };
  }
  it("captures two shared-Git leaves concurrently and restores both after outer commit", async () => {
    const f = await fixture(), held = await recoverable(f), workspaceIds = f.leaves.map(row => row.id), put = storage.putFile.bind(storage);
    let entered = 0, active = 0, maximum = 0, release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; }), timer = setTimeout(() => release(), 2000);
    vi.spyOn(storage, "putFile").mockImplementation(async input => {
      active++; maximum = Math.max(maximum, active); if (++entered === 2) release();
      if (entered === 1) {
        const other = createDb(database.connectionString, { maxConnections: 1 });
        try {
          await expect(withWorkspaceSourceLocks(other, { companyId: f.companyId, projectIds: [f.projectId] }, async () => true, true))
            .rejects.toBeInstanceOf(IsolatedRepositorySourceBusy);
          await other.transaction(async tx => expect(await tryLockNativeWorkspaceFinalization(tx as unknown as Db, { companyId: f.companyId, runId: held.runId })).toBe(false));
        } finally { await other.$client.end({ timeout: 1 }); }
      }
      try {
        await barrier;
        const rows = await db.select().from(executionWorkspaces).where(inArray(executionWorkspaces.id, workspaceIds));
        expect(rows.every(row => !readRemoteWorkspaceAuthority(row.metadata))).toBe(true);
        return await put(input);
      } finally { active--; }
    });
    try {
      await expect(migrateRemoteWorkspaceCohort({ db, storage, companyId: f.companyId, workspaceIds,
        apply: true, signal: AbortSignal.timeout(50_000) })).resolves.toMatchObject({ applied: true });
    } finally { clearTimeout(timer); }
    expect(maximum).toBe(2);
    await expect(run(f)).resolves.toMatchObject({ applied: true, replayed: true });
    await expect(run(f, { workspaceIds: [f.leaves[0].id] })).rejects.toThrow("workspace_cohort_membership_changed");
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, held.runId)))[0]).toEqual(held.owner);
    const archives = [];
    for (const workspace of f.leaves) {
      const [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspace.id));
      const authority = readRemoteWorkspaceAuthority(row.metadata)!;
      const ref = (await getWorkspaceSnapshot(db, { companyId: f.companyId, workspaceId: workspace.id, snapshotId: authority.snapshotId! }))!;
      const archivePath = path.join(home, `${workspace.name}.pcws`); await loadWorkspaceSnapshotArchive({ storage, reference: ref, targetPath: archivePath });
      archives.push({ workspace, ref, archivePath });
    }
    await fs.rm(f.root, { recursive: true });
    for (const { workspace, ref, archivePath } of archives) {
      const targetDir = path.join(home, `${workspace.name}-restored`);
      await restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: ref.manifestDigest });
      expect(await fs.readFile(path.join(targetDir, "saved.txt"), "utf8")).toBe(`${workspace.name} dirty tracked work\n`);
      expect(await fs.readFile(path.join(targetDir, "untracked.txt"), "utf8")).toBe(`${workspace.name} untracked work\n`);
      expect(await git(targetDir, "log", "-1", "--format=%s")).toBe("Original history");
    }
  }, 60_000);
  it("releases completed parent payload before a held peer while preserving the final child mutation check", async () => {
    const f = await fixture(), parent = f.leaves[0], cwd = path.join(parent.cwd!, ".paperclip", "worktrees", "nested");
    await git(f.root, "worktree", "add", "-qb", "nested", cwd);
    const [childIssue, aliasIssue] = await db.insert(issues).values([
      { companyId: f.companyId, projectId: f.projectId, title: "Nested child" },
      { companyId: f.companyId, projectId: f.projectId, title: "Leaf alias" },
    ]).returning();
    const [child, alias] = await db.insert(executionWorkspaces).values([
      { companyId: f.companyId, projectId: f.projectId, sourceIssueId: childIssue.id, name: "nested", mode: "isolated_workspace",
        strategyType: "git_worktree", providerType: "git_worktree", cwd, providerRef: cwd, repoUrl: parent.repoUrl, branchName: "nested" },
      { companyId: f.companyId, projectId: f.projectId, sourceIssueId: aliasIssue.id, name: "alias", mode: parent.mode,
        strategyType: parent.strategyType, providerType: parent.providerType, cwd: parent.cwd, providerRef: parent.providerRef,
        repoUrl: parent.repoUrl, branchName: parent.branchName },
    ]).returning();
    await db.update(issues).set({ executionWorkspaceId: child.id }).where(eq(issues.id, childIssue.id));
    await db.update(issues).set({ executionWorkspaceId: alias.id }).where(eq(issues.id, aliasIssue.id));
    await fs.writeFile(path.join(cwd, "untracked.txt"), "nested dirty bytes\n");
    await migrateRemoteWorkspace({ db, storage, companyId: f.companyId, workspaceId: child.id, apply: true,
      signal: AbortSignal.timeout(50_000) });
    const readOnly = path.join(parent.cwd!, "read-only");
    await fs.mkdir(readOnly); await fs.writeFile(path.join(readOnly, "saved.txt"), "read-only parent payload\n"); await fs.chmod(readOnly, 0o555);
    const capture = workspaceArchive.captureRemoteWorkspaceDirectory;
    let firstScratch = "", waiting = false, release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(workspaceArchive, "captureRemoteWorkspaceDirectory").mockImplementation(async input => {
      if (input.cwd === parent.cwd && path.basename(input.archivePath) === "workspace.pcws") {
        if (!firstScratch) firstScratch = path.dirname(input.archivePath);
        else { waiting = true; await held; }
      }
      return capture(input);
    });
    const beforeActivity = await db.select().from(activityLog);
    const pending = run(f, { workspaceIds: [parent.id, alias.id], concurrency: 1 }).then(value => ({ value }), error => ({ error }));
    let result: Awaited<typeof pending> | undefined;
    try {
      await expect.poll(() => waiting, { timeout: 20_000 }).toBe(true);
      expect((await fs.lstat(firstScratch)).isDirectory()).toBe(true);
      for (const name of ["workspace.pcws", "verified.pcws", "current.pcws", "restored"])
        expect.soft(await fs.lstat(path.join(firstScratch, name)).catch(error => { if (error.code === "ENOENT") return null; throw error; })).toBeNull();
      const covered = (await fs.readdir(firstScratch)).filter(name => name.startsWith("covered-"));
      expect(covered.length).toBeGreaterThan(0);
      for (const area of covered) for (const name of ["saved.pcws", "current.pcws", "restored"])
        expect(await fs.lstat(path.join(firstScratch, area, name))).toBeDefined();
      expect((await db.select().from(executionWorkspaces).where(inArray(executionWorkspaces.id, [parent.id, alias.id])))
        .every(row => !readRemoteWorkspaceAuthority(row.metadata))).toBe(true);
      await fs.writeFile(path.join(cwd, "untracked.txt"), "changed after first payload cleanup\n");
    } finally { release(); result = await pending; await fs.chmod(readOnly, 0o755); }
    expect(result).toMatchObject({ error: expect.objectContaining({ message: "nested_workspace_source_changed" }) });
    expect((await db.select().from(executionWorkspaces).where(inArray(executionWorkspaces.id, [parent.id, alias.id])))
      .every(row => !readRemoteWorkspaceAuthority(row.metadata))).toBe(true);
    expect(await db.select().from(activityLog)).toEqual(beforeActivity);
    expect(await fs.readFile(path.join(cwd, "untracked.txt"), "utf8")).toBe("changed after first payload cleanup\n");
    await expect(fs.lstat(firstScratch)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);
  it.each(["unchanged", "changed"] as const)("shares the merged child verifier across parallel aliases under the complete cohort fence (%s child bytes)", async mode => {
    const f = await fixture(), parent = f.leaves[0], cwd = path.join(parent.cwd!, ".paperclip", "worktrees", "nested");
    await git(f.root, "worktree", "add", "-qb", "nested", cwd);
    const [childIssue, aliasIssue] = await db.insert(issues).values([
      { companyId: f.companyId, projectId: f.projectId, title: "Nested child" },
      { companyId: f.companyId, projectId: f.projectId, title: "Leaf alias" },
    ]).returning();
    const [child, alias] = await db.insert(executionWorkspaces).values([
      { companyId: f.companyId, projectId: f.projectId, sourceIssueId: childIssue.id, name: "nested", mode: "isolated_workspace",
        strategyType: "git_worktree", providerType: "git_worktree", cwd, providerRef: cwd, repoUrl: parent.repoUrl, branchName: "nested" },
      { companyId: f.companyId, projectId: f.projectId, sourceIssueId: aliasIssue.id, name: "alias", mode: parent.mode,
        strategyType: parent.strategyType, providerType: parent.providerType, cwd: parent.cwd, providerRef: parent.providerRef,
        repoUrl: parent.repoUrl, branchName: parent.branchName },
    ]).returning();
    await db.update(issues).set({ executionWorkspaceId: child.id }).where(eq(issues.id, childIssue.id));
    await db.update(issues).set({ executionWorkspaceId: alias.id }).where(eq(issues.id, aliasIssue.id));
    await fs.writeFile(path.join(cwd, "untracked.txt"), "nested dirty bytes\n");
    await migrateRemoteWorkspace({ db, storage, companyId: f.companyId, workspaceId: child.id, apply: true,
      signal: AbortSignal.timeout(50_000) });
    const [snapshot] = await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.executionWorkspaceId, child.id));
    const get = storage.getObject.bind(storage), head = storage.headObject.bind(storage);
    let reads = 0;
    vi.spyOn(storage, "headObject").mockImplementation(async (...args) => {
      const result = await head(...args);
      if (!result.exists) return result;
      const bytes = await fs.readFile(path.join(home, "objects", args[1]));
      return { ...result, etag: `"${createHash("sha256").update(bytes).digest("hex")}"` };
    });
    vi.spyOn(storage, "getObject").mockImplementation(async (...args) => {
      if (args[1] === snapshot.objectKey) reads++;
      return get(...args);
    });
    const capture = vi.spyOn(workspaceArchive, "captureRemoteWorkspaceDirectory");
    const beforeActivity = await db.select().from(activityLog), put = storage.putFile.bind(storage);
    let uploads = 0;
    if (mode === "changed") vi.spyOn(storage, "putFile").mockImplementation(async input => {
      const result = await put(input);
      if (++uploads === 2) await fs.writeFile(path.join(cwd, "untracked.txt"), "changed during parent upload\n");
      return result;
    });
    const pending = run(f, { workspaceIds: [parent.id, alias.id] });
    if (mode === "unchanged") await expect(pending).resolves.toMatchObject({ applied: true });
    else {
      await expect(pending).rejects.toThrow("nested_workspace_source_changed");
      const selected = await db.select().from(executionWorkspaces).where(inArray(executionWorkspaces.id, [parent.id, alias.id]));
      expect(selected.every(row => !readRemoteWorkspaceAuthority(row.metadata))).toBe(true);
      expect(await db.select().from(activityLog)).toEqual(beforeActivity);
    }
    expect(reads).toBe(1);
    expect(capture.mock.calls.filter(([input]) => input.cwd === cwd && path.basename(input.archivePath) === "current.pcws")).toHaveLength(2);
    expect(await fs.readFile(path.join(cwd, "untracked.txt"), "utf8")).toBe(mode === "unchanged" ? "nested dirty bytes\n" : "changed during parent upload\n");
  }, 60_000);
  it.each(["foreign", "journal", "finished"])("refuses a changed %s operation before any authority write", async mode => {
    const f = await fixture(), put = storage.putFile.bind(storage); let uploaded = 0;
    await db.execute(sql`create sequence cohort_publish_attempts minvalue 0 start 0`);
    await db.execute(sql`create function cohort_publish_probe() returns trigger language plpgsql as $$ begin perform nextval('cohort_publish_attempts'); return new; end $$`);
    await db.execute(sql`create trigger cohort_publish_probe before update on execution_workspaces for each row when (new.metadata->'remoteWorkspace' is not null) execute function cohort_publish_probe()`);
    vi.spyOn(storage, "putFile").mockImplementation(async input => {
      const result = await put(input);
      if (++uploaded === 2) {
        if (mode === "foreign") await db.insert(workspaceOperations).values({ companyId: f.companyId, executionWorkspaceId: f.parent.id,
          issueId: f.parent.sourceIssueId, cwd: f.root, phase: "worktree_prepare", status: "running" });
        else if (mode === "finished") await db.update(workspaceOperations).set({ finishedAt: new Date() })
          .where(eq(workspaceOperations.executionWorkspaceId, f.leaves[1].id));
        else await db.update(workspaceOperations).set({ metadata: sql`${workspaceOperations.metadata} || '{"unexpected":"changed journal"}'::jsonb` })
          .where(eq(workspaceOperations.executionWorkspaceId, f.leaves[1].id));
      }
      return result;
    });
    await expect(run(f)).rejects.toThrow();
    expect((await db.execute(sql`select is_called from cohort_publish_attempts`))[0].is_called).toBe(false);
    expect(await db.select().from(activityLog)).toHaveLength(0);
    await assertLocal(f);
    expect(await db.select().from(workspaceOperations)).toHaveLength(mode === "foreign" ? 3 : 2);
  });
  it("compensates an exact unpublished cohort after Git expiration without losing its data or history", async () => {
    const f = await fixture("cohort", 8), bare = path.join(home, "upstream", "cohort.git"), old = new Date(Date.now() - 4 * 86_400_000);
    await fs.mkdir(path.dirname(bare), { recursive: true }); await git(f.root, "clone", "--bare", f.root, bare);
    const repoUrl = pathToFileURL(bare).href; await git(f.root, "remote", "set-url", "origin", repoUrl);
    await db.update(executionWorkspaces).set({ repoUrl, metadata: { createdByRuntime: true, gitBranchOwnershipVersion: 1 } });
    await db.update(issues).set({ status: "done", completedAt: old, updatedAt: old });
    const held = await recoverable({ ...f, leaves: [f.leaves[3]] }), put = storage.putFile.bind(storage); let uploads = 0;
    const interrupted = vi.spyOn(storage, "putFile").mockImplementation(async input => {
      if (++uploads === 5) throw new Error("cohort_after_four_uploads"); return put(input);
    });
    await expect(run(f, { concurrency: 1 })).rejects.toThrow("cohort_after_four_uploads"); interrupted.mockRestore();
    const initialOperations = (await db.select().from(workspaceOperations)).filter(row => row.phase === "remote_workspace_migration");
    expect(initialOperations).toHaveLength(8);
    const cohort = initialOperations[0].metadata!.cohortMigration as { id: string; members: Array<{ workspaceId: string; operationId: string }> };
    const expirable = cohort.members.filter(member => member.workspaceId !== f.leaves[3].id);
    const expiredWorkspaceIds = [expirable[0].workspaceId, expirable.at(-1)!.workspaceId], now = new Date(Date.now() + 3 * 86_400_000);
    const expireOptions = { now, expireBase: false, dryRun: false, signal: AbortSignal.timeout(60_000),
      restorePoint: { storage, notBefore: old, keyDurable: true } };
    const [protectedRow] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, expiredWorkspaceIds[0]));
    const restarted = createDb(database.connectionString, { maxConnections: 1 });
    try { expect(await expireReconstructableGitWorkspace(restarted, protectedRow, expireOptions))
      .toMatchObject({ expired: false, skipReason: "live_or_unresolved_consumer" }); }
    finally { await restarted.$client.end({ timeout: 1 }); }
    for (const workspaceId of expiredWorkspaceIds) {
      const [before] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
      const marker = before.metadata!.remoteWorkspaceMigration, metadata = { ...before.metadata }; delete metadata.remoteWorkspaceMigration;
      const operation = initialOperations.find(row => row.executionWorkspaceId === workspaceId)!;
      await db.update(workspaceOperations).set({ status: "failed" }).where(eq(workspaceOperations.id, operation.id));
      const [unprotected] = await db.update(executionWorkspaces).set({ metadata }).where(eq(executionWorkspaces.id, workspaceId)).returning();
      const expired = await expireReconstructableGitWorkspace(db, unprotected, expireOptions);
      expect(expired.skipReason).toBe(null); expect(expired).toMatchObject({ expired: true, restorePoint: true });
      const [archived] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
      await db.update(executionWorkspaces).set({ metadata: { ...archived.metadata, remoteWorkspaceMigration: marker } }).where(eq(executionWorkspaces.id, workspaceId));
      await db.update(workspaceOperations).set({ status: "running" }).where(eq(workspaceOperations.id, operation.id));
      await expect(fs.access(before.cwd!)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(run(f)).rejects.toThrow("workspace_cohort_online_source_required");
    const oldOperations = await db.select().from(workspaceOperations), oldSnapshots = await db.select().from(executionWorkspaceSnapshots);
    expect(oldSnapshots.filter(row => row.status === "uploaded")).toHaveLength(4);
    const tasks = await db.select().from(issues), runs = await db.select().from(heartbeatRuns), leases = await db.select().from(environmentLeases);
    const finalizers = await db.select().from(nativeRunFinalizations);
    const compensate = (options: Partial<Parameters<typeof supersedeExpiredRemoteWorkspaceMigrationCohort>[0]> = {}) =>
      supersedeExpiredRemoteWorkspaceMigrationCohort({ db, companyId: f.companyId, cohort,
        expiredWorkspaceIds, signal: AbortSignal.timeout(60_000), ...options });
    const [missingProof] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, expiredWorkspaceIds[0]));
    const withoutRestorePoint = { ...(missingProof.metadata!.gitCacheRestoration as Record<string, unknown>), schema: "paperclip.git-cache-restoration.v1" };
    delete (withoutRestorePoint as Record<string, unknown>).restorePoint;
    await db.update(executionWorkspaces).set({ metadata: { ...missingProof.metadata, gitCacheRestoration: withoutRestorePoint } })
      .where(eq(executionWorkspaces.id, missingProof.id));
    const unverifiedRows = await rows(f);
    await expect(compensate()).rejects.toThrow("migration_supersession_expiration_unverified");
    expect(await rows(f)).toEqual(unverifiedRows); expect(await db.select().from(workspaceOperations)).toEqual(oldOperations);
    expect(await db.select().from(executionWorkspaceSnapshots)).toEqual(oldSnapshots);
    await db.update(executionWorkspaces).set({ metadata: missingProof.metadata }).where(eq(executionWorkspaces.id, missingProof.id));
    const [authorityRow] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, cohort.members[2].workspaceId));
    await db.update(executionWorkspaces).set({ metadata: { ...authorityRow.metadata, remoteWorkspace: {
      schema: "paperclip.remote-workspace.v1", epoch: 1, source: initialOperations[0].metadata!.source,
      snapshotId: oldSnapshots.find(row => row.status === "uploaded")!.id, writerRunId: null, location: null, dirty: false } } })
      .where(eq(executionWorkspaces.id, authorityRow.id));
    await expect(compensate()).rejects.toThrow("online_workspace_source_scope_unproven");
    await db.update(executionWorkspaces).set({ metadata: authorityRow.metadata }).where(eq(executionWorkspaces.id, authorityRow.id));
    const beforeRows = await rows(f), last = cohort.members.at(-1)!;
    await db.execute(sql.raw(`create function cohort_commit_fault() returns trigger language plpgsql as $$ begin if new.id='${last.operationId}'::uuid and new.status='failed' then raise exception 'cohort_compensation_fault'; end if; return new; end $$`));
    await db.execute(sql`create trigger cohort_commit_fault before update on workspace_operations for each row execute function cohort_commit_fault()`);
    await expect(compensate()).rejects.toThrow();
    expect(await db.select().from(workspaceOperations)).toEqual(oldOperations); expect(await rows(f)).toEqual(beforeRows);
    await db.execute(sql`drop trigger cohort_commit_fault on workspace_operations`); await db.execute(sql`drop function cohort_commit_fault()`);
    const other = createDb(database.connectionString, { maxConnections: 1 });
    let receipt!: Awaited<ReturnType<typeof compensate>>;
    const queued = () => db.execute(sql`select exists(select 1 from pg_locks where locktype='advisory' and not granted
      and database=(select oid from pg_database where datname=current_database())) as waiting`);
    try {
      await other.transaction(async tx => {
        expect(await tryLockNativeWorkspaceFinalization(tx as unknown as Db, { companyId: f.companyId, runId: held.runId })).toBe(true);
        await expect(compensate()).rejects.toThrow("remote_copyback_owned");
      });
      await withWorkspaceSourceLocks(other, { companyId: f.companyId, projectIds: [f.projectId] }, async holder => {
        const abort = new AbortController(), pending = compensate({ sourceLockWaitMs: 10_000, signal: abort.signal });
        const outcome = pending.then(value => ({ value, error: null }), error => ({ value: null, error }));
        try {
          await expect.poll(async () => (await queued())[0].waiting, { timeout: 8_000 }).toBe(true);
          abort.abort(new Error("compensation_queue_cancelled"));
          expect((await outcome).error?.message).toBe("compensation_queue_cancelled");
          expect((await holder.execute(sql`select exists(select 1 from pg_locks where pid=pg_backend_pid()
            and locktype='advisory' and granted) as held`))[0].held).toBe(true);
          expect(await db.select().from(workspaceOperations)).toEqual(oldOperations);
        } finally { abort.abort(); await outcome; }
      });
      let pending: ReturnType<typeof compensate> | undefined;
      try {
        await withWorkspaceSourceLocks(other, { companyId: f.companyId, projectIds: [f.projectId] }, async () => {
          pending = compensate({ sourceLockWaitMs: 10_000 });
          void pending.catch(() => undefined);
          await expect.poll(async () => (await queued())[0].waiting, { timeout: 8_000 }).toBe(true);
        });
      } finally { if (pending) receipt = await pending; }
    } finally { await other.$client.end({ timeout: 1 }); }
    expect(receipt).toMatchObject({ superseded: true, migrationCompleted: false, replayed: false });
    await expect(compensate()).resolves.toMatchObject({ ...receipt, replayed: true });
    const failed = await db.select().from(workspaceOperations);
    for (const operation of failed) expect(operation).toMatchObject({ status: "failed", metadata: {
      ...oldOperations.find(row => row.id === operation.id)!.metadata, lastFailure: { schema: "paperclip.remote-workspace-migration-supersession.v1",
        code: "source_expired_during_import", cohortId: cohort.id, supersessionId: receipt.supersessionId } } });
    expect(await db.select().from(executionWorkspaceSnapshots)).toEqual(oldSnapshots);
    expect(await db.select().from(issues)).toEqual(tasks); expect(await db.select().from(heartbeatRuns)).toEqual(runs);
    expect(await db.select().from(environmentLeases)).toEqual(leases); expect(await db.select().from(nativeRunFinalizations)).toEqual(finalizers);
    for (const workspaceId of expiredWorkspaceIds) await migrateRemoteWorkspace({ db, storage, companyId: f.companyId, workspaceId,
      apply: true, signal: AbortSignal.timeout(60_000) });
    await expect(run(f, { workspaceIds: cohort.members.map(member => member.workspaceId).filter(id => !expiredWorkspaceIds.includes(id)) }))
      .resolves.toMatchObject({ applied: true });
    const currentOperations = await db.select().from(workspaceOperations);
    for (const member of cohort.members) {
      const successor = currentOperations.find(row => row.executionWorkspaceId === member.workspaceId && row.status === "succeeded")!;
      expect(successor.id).not.toBe(member.operationId);
      expect(successor.metadata?.migrationSupersession).toMatchObject({ operationId: member.operationId, cohortId: cohort.id,
        supersessionId: receipt.supersessionId, generation: oldSnapshots.some(row => row.executionWorkspaceId === member.workspaceId) ? 2 : 1 });
    }
    const deleted = vi.spyOn(storage, "deleteObject");
    const retention = await remoteWorkspaceSnapshotRetentionService(db, { storage, now: () => new Date(Date.now() + 30 * 86_400_000) }).tick();
    expect(retention.pinned).toBeGreaterThanOrEqual(oldSnapshots.length); expect(deleted).not.toHaveBeenCalled();
    expect((await db.select().from(workspaceOperations)).filter(row => oldOperations.some(old => old.id === row.id))).toEqual(failed);
    await fs.rename(f.root, f.root + "-original");
    for (const workspace of f.leaves) {
      const [saved] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspace.id));
      const ref = (await getWorkspaceSnapshot(db, { companyId: f.companyId, workspaceId: saved.id,
        snapshotId: readRemoteWorkspaceAuthority(saved.metadata)!.snapshotId! }))!;
      const archivePath = path.join(home, `${saved.id}.pcws`), targetDir = path.join(home, `${saved.id}-restored`);
      await loadWorkspaceSnapshotArchive({ storage, reference: ref, targetPath: archivePath });
      await restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: ref.manifestDigest });
      expect(await fs.readFile(path.join(targetDir, "saved.txt"), "utf8")).toBe(`${workspace.name} dirty tracked work\n`);
      expect(await fs.readFile(path.join(targetDir, "untracked.txt"), "utf8")).toBe(`${workspace.name} untracked work\n`);
    }
  }, 120_000);
  it.each(["fresh", "resume"] as const)("imports a larger same-root cohort with bounded work (%s)", async mode => {
    const f = await fixture(), selected = await aliasMembers(f, f.parent, 10), workspaceIds = selected.map(row => row.id);
    for (const child of f.leaves) await migrateRemoteWorkspace({ db, storage, companyId: f.companyId, workspaceId: child.id,
      apply: true, signal: AbortSignal.timeout(50_000) });
    await fs.writeFile(path.join(f.root, "root-untracked.txt"), "parent retained work\n");
    const inspect = onlineWorkspaceSource.inspectOnlineWorkspaceSource, transaction = db.transaction.bind(db), put = storage.putFile.bind(storage);
    let readers = 0, maximumReaders = 0, reservations = 0, maximumReservations = 0, uploads = 0, maximumUploads = 0;
    vi.spyOn(onlineWorkspaceSource, "inspectOnlineWorkspaceSource").mockImplementation(async (...args) => {
      readers++; maximumReaders = Math.max(maximumReaders, readers);
      try { return await inspect(...args); } finally { readers--; }
    });
    vi.spyOn(db, "transaction").mockImplementation(async (...args) => {
      reservations++; maximumReservations = Math.max(maximumReservations, reservations);
      try { return await transaction(...args); } finally { reservations--; }
    });
    const capture = vi.spyOn(workspaceArchive, "captureRemoteWorkspaceDirectory");
    let entered = 0, release!: () => void, interrupt = mode === "resume";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const barrier = new Promise<void>(done => { release = done; });
    vi.spyOn(storage, "putFile").mockImplementation(async input => {
      uploads++; maximumUploads = Math.max(maximumUploads, uploads);
      try {
        if (interrupt && ++entered === 2) throw new Error("large_cohort_upload_interrupted");
        if (!interrupt) {
          if (++entered === 1) timer = setTimeout(() => release(), 5000);
          if (entered === 8) release();
          await barrier;
        }
        return await put(input);
      } finally { uploads--; }
    });
    let savedOperations: Array<{ id: string; metadata: Record<string, unknown> | null }> = [], savedSnapshotIds: string[] = [];
    try {
      if (mode === "resume") {
        await expect(run(f, { workspaceIds, concurrency: 1 })).rejects.toThrow("large_cohort_upload_interrupted");
        savedOperations = (await db.select().from(workspaceOperations)).filter(row => workspaceIds.includes(row.executionWorkspaceId!));
        savedSnapshotIds = (await db.select().from(executionWorkspaceSnapshots)).filter(row => workspaceIds.includes(row.executionWorkspaceId)).map(row => row.id);
        expect(savedOperations).toHaveLength(10); expect(savedSnapshotIds).toHaveLength(2);
        interrupt = false; entered = 0;
      }
      await expect(run(f, { workspaceIds, concurrency: 8 })).resolves.toMatchObject({ applied: true });
    } finally { clearTimeout(timer); }
    expect(maximumReaders).toBe(8); expect(maximumReservations).toBe(8); expect(maximumUploads).toBe(8);
    expect(readers).toBe(0); expect(reservations).toBe(0); expect(uploads).toBe(0);
    const operations = (await db.select().from(workspaceOperations)).filter(row => workspaceIds.includes(row.executionWorkspaceId!));
    expect(operations).toHaveLength(10); expect(operations.every(row => row.status === "succeeded")).toBe(true);
    if (mode === "fresh") expect(capture.mock.calls.filter(([input]) => f.leaves.some(child => input.cwd === child.cwd)
      && path.basename(input.archivePath) === "current.pcws")).toHaveLength(4);
    else {
      expect(operations.map(row => row.id).sort()).toEqual(savedOperations.map(row => row.id).sort());
      expect(operations.every(row => JSON.stringify(row.metadata!.cohortMigration) === JSON.stringify(savedOperations[0].metadata!.cohortMigration))).toBe(true);
      expect((await db.select().from(executionWorkspaceSnapshots)).filter(row => savedSnapshotIds.includes(row.id))).toHaveLength(2);
    }
    await expect(run(f, { workspaceIds })).resolves.toMatchObject({ applied: true, replayed: true });
    await fs.rename(f.root, f.root + "-original");
    for (const workspace of selected) {
      const [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspace.id));
      const ref = (await getWorkspaceSnapshot(db, { companyId: f.companyId, workspaceId: row.id,
        snapshotId: readRemoteWorkspaceAuthority(row.metadata)!.snapshotId! }))!;
      const archivePath = path.join(home, `${row.id}.pcws`), targetDir = path.join(home, `${row.id}-cold`);
      await loadWorkspaceSnapshotArchive({ storage, reference: ref, targetPath: archivePath });
      await restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: ref.manifestDigest });
      expect(await fs.readFile(path.join(targetDir, "saved.txt"), "utf8")).toBe("committed base\n");
      expect(await fs.readFile(path.join(targetDir, "root-untracked.txt"), "utf8")).toBe("parent retained work\n");
      expect(await git(targetDir, "log", "-1", "--format=%s")).toBe("Original history");
    }
  }, 90_000);
  it.each(["failure", "cancel"] as const)("joins the first extended reader batch before stopping later members (%s)", async mode => {
    const f = await fixture(), selected = await aliasMembers(f, f.parent, 10), ids = selected.map(row => row.id).sort();
    for (const child of f.leaves) await migrateRemoteWorkspace({ db, storage, companyId: f.companyId, workspaceId: child.id,
      apply: true, signal: AbortSignal.timeout(50_000) });
    const operations = await db.select().from(workspaceOperations), snapshots = await db.select().from(executionWorkspaceSnapshots);
    const inspect = onlineWorkspaceSource.inspectOnlineWorkspaceSource, calls = new Map<string, number>(), started: string[] = [];
    let bothEntered!: () => void, release!: () => void, failed!: () => void, settled = false;
    const both = new Promise<void>(done => { bothEntered = done; }), held = new Promise<void>(done => { release = done; });
    const observed = new Promise<void>(done => { failed = done; }), controller = new AbortController();
    vi.spyOn(onlineWorkspaceSource, "inspectOnlineWorkspaceSource").mockImplementation(async (...args) => {
      const id = args[1].id, call = (calls.get(id) ?? 0) + 1; calls.set(id, call);
      if (ids.includes(id) && call === 2) {
        started.push(id);
        if (id === ids[0]) {
          await both; failed();
          if (mode === "failure") throw new Error("extended_reader_failure");
          controller.abort(new Error("extended_reader_cancelled"));
        } else if (id === ids[1]) { bothEntered(); await held; }
      }
      return inspect(...args);
    });
    const put = vi.spyOn(storage, "putFile"), other = createDb(database.connectionString, { maxConnections: 1 });
    const pending = run(f, { workspaceIds: ids, signal: controller.signal })
      .then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    try {
      await both; await observed;
      expect(started).toContain(ids[0]); expect(started).toContain(ids[1]);
      expect(started.every(id => ids.slice(0, 8).includes(id))).toBe(true);
      expect(settled).toBe(false);
      await expect(withWorkspaceSourceLocks(other, { companyId: f.companyId, projectIds: [f.projectId] }, async () => true, true))
        .rejects.toBeInstanceOf(IsolatedRepositorySourceBusy);
      expect(put).not.toHaveBeenCalled();
    } finally { release(); await other.$client.end({ timeout: 1 }); }
    expect(await pending).toMatchObject({ error: expect.objectContaining({ message: mode === "failure"
      ? "extended_reader_failure" : "extended_reader_cancelled" }) });
    expect(started.sort()).toEqual(ids.slice(0, 8));
    expect(calls.get(ids[8])).toBe(1); expect(calls.get(ids[9])).toBe(1);
    expect(await db.select().from(workspaceOperations)).toEqual(operations);
    expect(await db.select().from(executionWorkspaceSnapshots)).toEqual(snapshots);
    expect(put).not.toHaveBeenCalled();
  }, 60_000);
  it("refuses more than eight members across different canonical leaf roots", async () => {
    const f = await fixture(), aliases = await aliasMembers(f, f.leaves[0], 8);
    const workspaces = [f.leaves[1], ...aliases], noStorage = new Proxy(storage, { get() { throw new Error("storage_must_not_be_used"); } });
    await expect(run(f, { storage: noStorage, workspaceIds: workspaces.map(row => row.id) }))
      .rejects.toThrow("workspace_cohort_same_root_required");
    expect(await db.select().from(workspaceOperations)).toHaveLength(0);
    expect(await db.select().from(executionWorkspaceSnapshots)).toHaveLength(0);
    await assertLocal(f);
  });
  it("resumes the same uploaded cohort after an archived companion is independently migrated", async () => {
    const f = await fixture("cohort"), held = await recoverable(f), cwd = path.join(f.root, ".paperclip", "worktrees", "retired"), closedAt = new Date();
    await git(f.root, "worktree", "add", "-qb", "retired", cwd);
    await git(f.root, "worktree", "remove", cwd);
    const receipt = await git(f.root, "branch", "-d", "retired");
    const [projectWorkspace] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: f.projectId,
      name: "Original repository", cwd: f.root, repoUrl: f.parent.repoUrl }).returning();
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, projectId: f.projectId, title: "Retired companion" }).returning();
    const [companion] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, projectId: f.projectId,
      projectWorkspaceId: projectWorkspace.id, sourceIssueId: issue.id, name: "retired", mode: "isolated_workspace",
      strategyType: "git_worktree", providerType: "git_worktree", cwd, providerRef: cwd, repoUrl: f.parent.repoUrl,
      branchName: "retired", status: "archived", closedAt, metadata: { createdByRuntime: true, gitBranchOwnershipVersion: 1 } }).returning();
    await db.insert(workspaceOperations).values({ companyId: f.companyId, executionWorkspaceId: companion.id,
      phase: "worktree_cleanup", status: "succeeded", command: "git branch -d retired", stdoutExcerpt: receipt,
      startedAt: new Date(), finishedAt: new Date() });
    const put = storage.putFile.bind(storage); let uploads = 0;
    const upload = vi.spyOn(storage, "putFile").mockImplementation(async input => {
      if (++uploads === 2) throw new Error("interrupted_cohort_upload");
      return put(input);
    });
    await expect(run(f, { concurrency: 1 })).rejects.toThrow("interrupted_cohort_upload");
    upload.mockRestore();
    const saved = (await db.select().from(workspaceOperations)).filter(row => row.phase === "remote_workspace_migration");
    expect(saved).toHaveLength(2);
    const cohort = saved[0].metadata!.cohortMigration as { id: string; sourceProof: string; members: unknown[] };
    const snapshots = await db.select().from(executionWorkspaceSnapshots);
    expect(snapshots.some(row => row.status === "uploaded")).toBe(true);
    await migrateRemoteWorkspace({ db, storage, companyId: f.companyId, workspaceId: companion.id, apply: true,
      signal: AbortSignal.timeout(50_000) });
    const noStorage = new Proxy(storage, { get() { throw new Error("unexpected_storage_operation"); } });
    await db.transaction(async tx => {
      await expect(run(f, { db: tx as unknown as Db, storage: noStorage, apply: false }))
        .resolves.toMatchObject({ applied: false, eligible: true, cohortId: cohort.id });
    }, { accessMode: "read only" });
    const other = createDb(database.connectionString, { maxConnections: 1 });
    try {
      await withWorkspaceSourceLocks(other, { companyId: f.companyId, projectIds: [f.projectId] }, async () => {
        await expect(run(f, { storage: noStorage })).rejects.toThrow("workspace_source_busy");
      }, true);
      await other.transaction(async tx => {
        expect(await tryLockNativeWorkspaceFinalization(tx as unknown as Db, { companyId: f.companyId, runId: held.runId })).toBe(true);
        await expect(run(f, { storage: noStorage })).rejects.toThrow("remote_copyback_owned");
      });
    } finally { await other.$client.end({ timeout: 1 }); }
    const inspect = onlineWorkspaceSource.inspectOnlineWorkspaceSource, cancelled = new AbortController(), calls = new Map<string, number>();
    const probe = vi.spyOn(onlineWorkspaceSource, "inspectOnlineWorkspaceSource").mockImplementation(async (...args) => {
      const result = await inspect(...args), count = (calls.get(args[1].id) ?? 0) + 1; calls.set(args[1].id, count);
      if (count === 5) cancelled.abort(new Error("cancel_cohort_proof_refresh"));
      return result;
    });
    await expect(run(f, { storage: noStorage, signal: cancelled.signal })).rejects.toThrow("cancel_cohort_proof_refresh");
    probe.mockRestore();
    const last = [...saved].sort((a, b) => a.executionWorkspaceId!.localeCompare(b.executionWorkspaceId!)).at(-1)!;
    await db.execute(sql.raw(`create function cohort_reserve_fault() returns trigger language plpgsql as $$ begin if new.id='${last.id}'::uuid then raise exception 'cohort_proof_refresh_fault'; end if; return new; end $$`));
    await db.execute(sql`create trigger cohort_reserve_fault before update on workspace_operations for each row execute function cohort_reserve_fault()`);
    await expect(run(f, { storage: noStorage })).rejects.toThrow();
    await db.execute(sql`drop trigger cohort_reserve_fault on workspace_operations`);
    await db.execute(sql`drop function cohort_reserve_fault()`);
    expect((await db.select().from(workspaceOperations)).filter(row => saved.some(old => old.id === row.id))).toEqual(saved);
    await assertLocal(f);
    await expect(run(f)).resolves.toMatchObject({ applied: true, cohortId: cohort.id });
    const current = (await db.select().from(workspaceOperations)).filter(row => saved.some(old => old.id === row.id));
    expect(current).toHaveLength(2);
    for (const operation of current) {
      const refreshed = operation.metadata!.cohortMigration as typeof cohort;
      expect(refreshed).toMatchObject({ id: cohort.id, members: cohort.members });
      expect(refreshed.sourceProof).not.toBe(cohort.sourceProof);
      expect(operation.status).toBe("succeeded");
    }
    expect((await db.select().from(executionWorkspaceSnapshots)).filter(row => snapshots.some(old => old.id === row.id))).toHaveLength(snapshots.length);
    await expect(run(f)).resolves.toMatchObject({ applied: true, replayed: true, cohortId: cohort.id });
    for (const workspace of f.leaves) {
      const [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspace.id));
      const ref = (await getWorkspaceSnapshot(db, { companyId: f.companyId, workspaceId: row.id,
        snapshotId: readRemoteWorkspaceAuthority(row.metadata)!.snapshotId! }))!;
      const archivePath = path.join(home, `${workspace.name}-resumed.pcws`), targetDir = path.join(home, `${workspace.name}-resumed`);
      await loadWorkspaceSnapshotArchive({ storage, reference: ref, targetPath: archivePath });
      await restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: ref.manifestDigest });
      expect(await fs.readFile(path.join(targetDir, "saved.txt"), "utf8")).toBe(`${workspace.name} dirty tracked work\n`);
      expect(await fs.readFile(path.join(targetDir, "untracked.txt"), "utf8")).toBe(`${workspace.name} untracked work\n`);
    }
  }, 60_000);
  it("resumes the exact membership after reservation stops halfway", async () => {
    const f = await fixture(), second = [...f.leaves].sort((a, b) => a.id.localeCompare(b.id))[1];
    await db.execute(sql.raw(`create function cohort_reserve_fault() returns trigger language plpgsql as $$ begin if new.execution_workspace_id='${second.id}'::uuid then raise exception 'cohort_reservation_fault'; end if; return new; end $$`));
    await db.execute(sql`create trigger cohort_reserve_fault before insert on workspace_operations for each row execute function cohort_reserve_fault()`);
    await expect(run(f)).rejects.toThrow();
    const [operation] = await db.select().from(workspaceOperations);
    expect(operation.status).toBe("running");
    const membership = operation.metadata!.cohortMigration;
    expect(await db.select().from(workspaceOperations)).toHaveLength(1);
    await assertLocal(f);
    const noStorage = new Proxy(storage, { get() { throw new Error("readonly_preflight_storage_forbidden"); } });
    await db.transaction(async tx => {
      await tx.execute(sql`set local statement_timeout='8s'`);
      await tx.execute(sql`set local lock_timeout='1s'`);
      expect((await tx.execute(sql`select current_setting('transaction_read_only') as ro`))[0].ro).toBe("on");
      await expect(run(f, { db: tx as unknown as Db, storage: noStorage, apply: false }))
        .resolves.toMatchObject({ applied: false, eligible: true, cohortId: (membership as { id: string }).id });
    }, { accessMode: "read only" });
    expect(await db.select().from(workspaceOperations)).toHaveLength(1);
    expect(await db.select().from(executionWorkspaceSnapshots)).toHaveLength(0);
    await expect(run(f, { workspaceIds: [operation.executionWorkspaceId!] })).rejects.toThrow("workspace_cohort_membership_changed");
    await expect(migrateRemoteWorkspace({ db, storage, companyId: f.companyId, workspaceId: operation.executionWorkspaceId!,
      apply: true, signal: AbortSignal.timeout(50_000) })).rejects.toThrow("remote_workspace_cohort_resume_required");
    await db.execute(sql`drop trigger cohort_reserve_fault on workspace_operations`);
    await expect(run(f)).resolves.toMatchObject({ applied: true, cohortId: (membership as { id: string }).id });
    const operations = await db.select().from(workspaceOperations);
    expect(operations).toHaveLength(2);
    expect(operations.every(row => row.status === "succeeded" && JSON.stringify(row.metadata!.cohortMigration) === JSON.stringify(membership))).toBe(true);
  });
  it.each(["first", "last"] as const)("does not persist a stale cohort source proof when the %s member changes before reservation", async position => {
    const f = await fixture(), [first, second] = [...f.leaves].sort((a, b) => a.id.localeCompare(b.id));
    const changedMember = position === "first" ? first : second;
    await db.execute(sql.raw(`create function cohort_reserve_fault() returns trigger language plpgsql as $$ begin if new.execution_workspace_id='${second.id}'::uuid then raise exception 'cohort_reservation_fault'; end if; return new; end $$`));
    await db.execute(sql`create trigger cohort_reserve_fault before insert on workspace_operations for each row execute function cohort_reserve_fault()`);
    const inspect = onlineWorkspaceSource.inspectOnlineWorkspaceSource; let changed = false;
    vi.spyOn(onlineWorkspaceSource, "inspectOnlineWorkspaceSource").mockImplementation(async (...args) => {
      if (!changed) {
        changed = true;
        await db.update(executionWorkspaces).set({ metadata: { ...changedMember.metadata, preservedEvidence: "new source metadata" } })
          .where(eq(executionWorkspaces.id, changedMember.id));
      }
      return inspect(...args);
    });
    await expect.soft(run(f)).rejects.toThrow("workspace_cohort_source_changed");
    expect.soft(await db.select().from(workspaceOperations)).toHaveLength(0);
    expect.soft(await db.select().from(executionWorkspaceSnapshots)).toHaveLength(0);
    await assertLocal(f);
    vi.restoreAllMocks();
    await db.execute(sql`drop trigger cohort_reserve_fault on workspace_operations`);
    await expect(run(f)).resolves.toMatchObject({ applied: true });
  });
  it("refuses changed source fingerprints after partial reservation before storage or more journal work", async () => {
    const f = await fixture(), second = [...f.leaves].sort((a, b) => a.id.localeCompare(b.id))[1];
    await db.execute(sql.raw(`create function cohort_reserve_fault() returns trigger language plpgsql as $$ begin if new.execution_workspace_id='${second.id}'::uuid then raise exception 'cohort_reservation_fault'; end if; return new; end $$`));
    await db.execute(sql`create trigger cohort_reserve_fault before insert on workspace_operations for each row execute function cohort_reserve_fault()`);
    await expect(run(f)).rejects.toThrow();
    await db.execute(sql`drop trigger cohort_reserve_fault on workspace_operations`);
    const operations = await db.select().from(workspaceOperations);
    expect(operations).toHaveLength(1);
    await db.update(executionWorkspaces).set({ metadata: { ...second.metadata, preservedEvidence: "changed after reservation" } })
      .where(eq(executionWorkspaces.id, second.id));
    const calls: string[] = [], noStorage = new Proxy(storage, { get(_target, key) {
      calls.push(String(key)); throw new Error("unexpected_storage_operation");
    } });
    await expect(run(f, { storage: noStorage, apply: false })).rejects.toThrow("workspace_cohort_membership_changed");
    await expect(run(f, { storage: noStorage })).rejects.toThrow("workspace_cohort_membership_changed");
    expect(calls).toEqual([]);
    expect(await db.select().from(workspaceOperations)).toEqual(operations);
    expect(await db.select().from(executionWorkspaceSnapshots)).toHaveLength(0);
    await assertLocal(f);
  });
  it("refuses mixed local and independently imported members before storage or journal work", async () => {
    const f = await fixture(), [first, second] = f.leaves;
    await migrateRemoteWorkspace({ db, storage, companyId: f.companyId, workspaceId: first.id, apply: true,
      signal: AbortSignal.timeout(50_000) });
    const operations = await db.select().from(workspaceOperations), snapshots = await db.select().from(executionWorkspaceSnapshots);
    const workspaces = await rows(f);
    expect(readRemoteWorkspaceAuthority(workspaces.find(row => row.id === first.id)!.metadata)).not.toBeNull();
    const calls: string[] = [], noStorage = new Proxy(storage, { get(_target, key) {
      calls.push(String(key)); throw new Error("unexpected_storage_operation");
    } });
    await expect(run(f, { storage: noStorage, apply: false })).rejects.toThrow("workspace_cohort_membership_changed");
    await expect(run(f, { storage: noStorage })).rejects.toThrow("workspace_cohort_membership_changed");
    expect(calls).toEqual([]);
    expect(await db.select().from(workspaceOperations)).toEqual(operations);
    expect(await db.select().from(executionWorkspaceSnapshots)).toEqual(snapshots);
    expect(await rows(f)).toEqual(workspaces);
    expect(await fs.readFile(path.join(second.cwd!, "saved.txt"), "utf8")).toBe(`${second.name} dirty tracked work\n`);
  });
  it.each(["cancelled", "failed", "running-finished"] as const)("refuses a %s member journal before preflight or snapshot work", async status => {
    const f = await fixture(), second = [...f.leaves].sort((a, b) => a.id.localeCompare(b.id))[1];
    await db.execute(sql.raw(`create function cohort_reserve_fault() returns trigger language plpgsql as $$ begin if new.execution_workspace_id='${second.id}'::uuid then raise exception 'cohort_reservation_fault'; end if; return new; end $$`));
    await db.execute(sql`create trigger cohort_reserve_fault before insert on workspace_operations for each row execute function cohort_reserve_fault()`);
    await expect(run(f)).rejects.toThrow();
    await db.execute(sql`drop trigger cohort_reserve_fault on workspace_operations`);
    const [operation] = await db.select().from(workspaceOperations);
    expect(operation.status).toBe("running");
    await db.update(workspaceOperations).set({ status: status === "running-finished" ? "running" : status, finishedAt: new Date() })
      .where(eq(workspaceOperations.id, operation.id));
    const calls: string[] = [], noStorage = new Proxy(storage, { get(_target, key) {
      calls.push(String(key)); throw new Error("unexpected_storage_operation");
    } });
    await db.transaction(async tx => {
      expect((await tx.execute(sql`select current_setting('transaction_read_only') as ro`))[0].ro).toBe("on");
      await expect.soft(run(f, { db: tx as unknown as Db, storage: noStorage, apply: false }))
        .rejects.toThrow("workspace_cohort_journal_changed");
    }, { accessMode: "read only" });
    await expect.soft(run(f, { storage: noStorage })).rejects.toThrow("workspace_cohort_journal_changed");
    expect.soft(calls).toEqual([]);
    expect.soft(await db.select().from(executionWorkspaceSnapshots)).toHaveLength(0);
    expect.soft(await db.select().from(workspaceOperations)).toHaveLength(1);
    await assertLocal(f);
  });
  it.each(["preflight", "reservation", "recovery"] as const)("joins concurrent %s validation readers before releasing the fence", async phase => {
    const f = await fixture(), held = await recoverable(f), inspect = onlineWorkspaceSource.inspectOnlineWorkspaceSource;
    const counts = new Map<string, number>(), selected = new Set(f.leaves.map(row => row.id));
    const phaseCall = phase === "preflight" ? 2 : phase === "reservation" ? 3 : 4;
    let entered = 0, settled = false, bothEntered!: () => void, release!: () => void, firstFailed!: () => void;
    const both = new Promise<void>(resolve => { bothEntered = resolve; }), peer = new Promise<void>(resolve => { release = resolve; });
    const failed = new Promise<void>(resolve => { firstFailed = resolve; }), timer = setTimeout(() => bothEntered(), 5000);
    vi.spyOn(onlineWorkspaceSource, "inspectOnlineWorkspaceSource").mockImplementation(async (...args) => {
      const id = args[1].id, call = (counts.get(id) ?? 0) + 1; counts.set(id, call);
      if (selected.has(id) && call === phaseCall) {
        if (++entered === 1) { await both; firstFailed(); throw new Error("first_validation_failure"); }
        bothEntered(); await peer;
      }
      return inspect(...args);
    });
    const put = vi.spyOn(storage, "putFile"), other = createDb(database.connectionString, { maxConnections: 1 });
    const pending = run(f).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    try {
      await both; await failed;
      expect(entered).toBe(2);
      expect(settled).toBe(false);
      await expect(withWorkspaceSourceLocks(other, { companyId: f.companyId, projectIds: [f.projectId] }, async () => true, true))
        .rejects.toBeInstanceOf(IsolatedRepositorySourceBusy);
      if (phase === "recovery") await other.transaction(async tx =>
        expect(await tryLockNativeWorkspaceFinalization(tx as unknown as Db, { companyId: f.companyId, runId: held.runId })).toBe(false));
      expect(put).not.toHaveBeenCalled();
    } finally { clearTimeout(timer); bothEntered(); release(); await pending; await other.$client.end({ timeout: 1 }); }
    expect(await pending).toMatchObject({ error: { message: "first_validation_failure" } });
    await expect(withWorkspaceSourceLocks(db, { companyId: f.companyId, projectIds: [f.projectId] }, async () => true, true)).resolves.toBe(true);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, held.runId)))[0]).toEqual(held.owner);
    await assertLocal(f);
    expect(await db.select().from(workspaceOperations)).toHaveLength(phase === "preflight" ? 0 : phase === "reservation" ? 1 : 2);
    expect(await db.select().from(executionWorkspaceSnapshots)).toHaveLength(0);
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });
  it.each(["failure", "cancel"] as const)("joins active capture peers and keeps the fence on %s", async mode => {
    const f = await fixture(), controller = new AbortController(); let entered = 0, firstFailed!: () => void, release!: () => void;
    const both = new Promise<void>(resolve => { firstFailed = resolve; }), peer = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(storage, "putFile").mockImplementation(async () => {
      const index = ++entered;
      if (index === 2) { if (mode === "cancel") controller.abort(new Error("caller_stop")); firstFailed(); }
      if (index === 1) { await both; if (mode === "failure") throw new Error("capture_upload_failure"); }
      await peer; throw new Error("peer_finished_after_abort");
    });
    let settled = false;
    const pending = run(f, { signal: controller.signal }).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    await both;
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(settled).toBe(false);
    const other = createDb(database.connectionString, { maxConnections: 1 });
    try { await expect(withWorkspaceSourceLocks(other, { companyId: f.companyId, projectIds: [f.projectId] }, async () => true, true))
      .rejects.toBeInstanceOf(IsolatedRepositorySourceBusy); }
    finally { release(); await other.$client.end({ timeout: 1 }); }
    expect(await pending).toHaveProperty("error");
    await assertLocal(f);
    expect(await db.select().from(workspaceOperations)).toHaveLength(2);
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });
  it("does not publish after its actual fence connection is lost", async () => {
    const f = await fixture(), put = storage.putFile.bind(storage); let killed = false;
    vi.spyOn(storage, "putFile").mockImplementation(async input => {
      const result = await put(input);
      if (!killed) {
        killed = true; const key = `managed_project_source:${f.companyId}:${f.projectId}`;
        const held = await db.execute(sql`select distinct pid from pg_locks where locktype='advisory' and granted
          and classid=((hashtextextended(${key},0)>>32)&4294967295)::oid and objid=(hashtextextended(${key},0)&4294967295)::oid`);
        expect(held).toHaveLength(1); await db.execute(sql`select pg_terminate_backend(${Number(held[0].pid)})`);
      }
      return result;
    });
    await expect(run(f)).rejects.toThrow();
    await assertLocal(f);
    expect(await db.select().from(activityLog)).toHaveLength(0);
    vi.restoreAllMocks();
    await expect(run(f)).resolves.toMatchObject({ applied: true });
    expect((await rows(f)).every(row => readRemoteWorkspaceAuthority(row.metadata))).toBe(true);
  });
  it("refuses unreviewed membership, a parent/child pair, and a foreign journal without captures", async () => {
    const f = await fixture(), put = vi.spyOn(storage, "putFile");
    await expect(run(f, { workspaceIds: Array(9).fill(f.leaves[0].id) })).rejects.toThrow();
    await expect(run(f, { concurrency: 9 })).rejects.toThrow();
    await expect(run(f, { workspaceIds: [f.leaves[0].id, f.leaves[0].id.toUpperCase()] })).rejects.toThrow("duplicate_member");
    await expect(run(f, { workspaceIds: [f.parent.id, f.leaves[0].id] })).rejects.toThrow("leaf_members_required");
    await db.insert(workspaceOperations).values({ companyId: f.companyId, executionWorkspaceId: f.parent.id,
      issueId: f.parent.sourceIssueId, cwd: f.root, phase: "workspace_finalize", status: "running", metadata: { uncertain: true } });
    await expect(run(f)).rejects.toThrow("workspace_operation_unresolved");
    expect(put).not.toHaveBeenCalled();
    expect(await db.select().from(workspaceOperations)).toHaveLength(1);
    await assertLocal(f);
  });

  it("keeps every authority and activity unpublished when the actual outer commit fails", async () => {
    const f = await fixture(), events: unknown[] = [], unsubscribe = subscribeCompanyLiveEvents(f.companyId, event => {
      if (event.type === "activity.logged") events.push(event);
    });
    await db.execute(sql`create function cohort_commit_fault() returns trigger language plpgsql as $$ begin raise exception 'outer_commit_fault'; end $$`);
    await db.execute(sql`create constraint trigger cohort_commit_fault after update on workspace_operations deferrable initially deferred
      for each row when (new.status='succeeded') execute function cohort_commit_fault()`);
    try {
      await expect(run(f)).rejects.toThrow();
      expect(events).toEqual([]);
      await assertLocal(f);
      expect(await db.select().from(activityLog)).toHaveLength(0);
      const journals = await db.select().from(workspaceOperations);
      expect(journals.every(row => row.status === "running")).toBe(true);
      expect((await db.select().from(executionWorkspaceSnapshots)).every(row => row.status === "uploaded")).toBe(true);
      await db.execute(sql`drop trigger cohort_commit_fault on workspace_operations`);
      await expect(run(f)).resolves.toMatchObject({ applied: true });
      expect(events).toHaveLength(2);
      expect((await db.select().from(workspaceOperations)).map(row => row.id).sort()).toEqual(journals.map(row => row.id).sort());
    } finally { unsubscribe(); }
  });
  it("does not return a savepoint success inside somebody else's source transaction", async () => {
    const f = await fixture(), put = vi.spyOn(storage, "putFile");
    await withWorkspaceSourceLocks(db, { companyId: f.companyId, projectIds: [f.projectId] }, async () => {
      await expect(run(f)).rejects.toBeInstanceOf(IsolatedRepositorySourceBusy);
      expect(await db.select().from(workspaceOperations)).toHaveLength(0);
    });
    expect(put).not.toHaveBeenCalled(); await assertLocal(f);
  });

});
