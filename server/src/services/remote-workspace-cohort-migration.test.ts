import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, environmentLeases, environments, heartbeatRuns, nativeRunFinalizations, executionWorkspaceSnapshots, executionWorkspaces, issues, projects, workspaceOperations, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import type { StorageService } from "../storage/types.js";
import { migrateRemoteWorkspace, migrateRemoteWorkspaceCohort } from "./remote-workspace-migration.js";
import { inspectOnlineWorkspaceSource } from "./online-workspace-source.js";
import { IsolatedRepositorySourceBusy, withWorkspaceSourceLocks } from "./workspace-source-lock.js";
import { getWorkspaceSnapshot, loadWorkspaceSnapshotArchive } from "./remote-workspace-snapshot-storage.js";
import { tryLockNativeWorkspaceFinalization } from "./native-runtime/native-workspace-finalization-ownership.js";
import { subscribeCompanyLiveEvents } from "./live-events.js";
import { restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";
import * as workspaceArchive from "./remote-workspace-snapshot-archive.js";

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
    await db.delete(activityLog); await db.delete(workspaceOperations); await db.delete(executionWorkspaceSnapshots);
    await db.execute(sql`drop trigger if exists cohort_publish_probe on execution_workspaces`);
    await db.execute(sql`drop function if exists cohort_publish_probe()`); await db.execute(sql`drop sequence if exists cohort_publish_attempts`);
    await db.execute(sql`drop trigger if exists cohort_commit_fault on workspace_operations`); await db.execute(sql`drop function if exists cohort_commit_fault()`);
    await db.execute(sql`drop trigger if exists cohort_reserve_fault on workspace_operations`); await db.execute(sql`drop function if exists cohort_reserve_fault()`);
    await db.delete(nativeRunFinalizations); await db.delete(environmentLeases); await db.delete(environments); await db.delete(heartbeatRuns);
    await db.delete(issues); await db.delete(agents); await db.delete(executionWorkspaces); await db.delete(projects); await db.delete(companies);
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
  it("shares the merged child verifier across parallel aliases under the complete cohort fence", async () => {
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
    await expect(run(f, { workspaceIds: [parent.id, alias.id] })).resolves.toMatchObject({ applied: true });
    expect(reads).toBe(1);
    expect(capture.mock.calls.filter(([input]) => input.cwd === cwd && path.basename(input.archivePath) === "current.pcws")).toHaveLength(4);
    expect(await fs.readFile(path.join(cwd, "untracked.txt"), "utf8")).toBe("nested dirty bytes\n");
  }, 60_000);
  it.each(["foreign", "journal"])("refuses a changed %s operation before any authority write", async mode => {
    const f = await fixture(), put = storage.putFile.bind(storage); let uploaded = 0;
    await db.execute(sql`create sequence cohort_publish_attempts minvalue 0 start 0`);
    await db.execute(sql`create function cohort_publish_probe() returns trigger language plpgsql as $$ begin perform nextval('cohort_publish_attempts'); return new; end $$`);
    await db.execute(sql`create trigger cohort_publish_probe before update on execution_workspaces for each row when (new.metadata->'remoteWorkspace' is not null) execute function cohort_publish_probe()`);
    vi.spyOn(storage, "putFile").mockImplementation(async input => {
      const result = await put(input);
      if (++uploaded === 2) {
        if (mode === "foreign") await db.insert(workspaceOperations).values({ companyId: f.companyId, executionWorkspaceId: f.parent.id,
          issueId: f.parent.sourceIssueId, cwd: f.root, phase: "worktree_prepare", status: "running" });
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
