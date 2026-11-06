import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sql, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, environmentLeases, environments, executionWorkspaceSnapshots, executionWorkspaces, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, projects, workspaceOperations, type Db } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority, readRemoteWorkspaceRunReference } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { resolveManagedProjectWorkspaceDir, resolvePaperclipInstanceRoot } from "../home-paths.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import type { StorageService } from "../storage/types.js";
import { inventoryRemoteWorkspaceMigration, migrateRemoteWorkspace } from "./remote-workspace-migration.js";
import { getWorkspaceSnapshot, loadWorkspaceSnapshotArchive } from "./remote-workspace-snapshot-storage.js";
import { restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";
import { materializeManagedProjectWorkspace } from "./managed-repository-checkout.js";
import { withExecutionWorkspaceLifecycleLock } from "./execution-workspace-lifecycle-lock.js";
import { IsolatedRepositorySourceBusy, withIsolatedRepositorySourceLock, withWorkspaceSourceLocks } from "./workspace-source-lock.js";
import { tryLockNativeWorkspaceFinalization } from "./native-runtime/native-workspace-finalization-ownership.js";
import { recordNativeFinalizationFailure } from "./native-runtime/native-run-finalizer.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("online ordinary physical source fence", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>, home: string, storage: StorageService;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("online-ordinary-source-");
    db = createDb(database.connectionString, { maxConnections: 1 });
    await db.execute(sql`set client_min_messages = warning`);
  }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });
  beforeEach(async () => {
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pc-online-source-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "61".repeat(32));
    storage = createStorageService(createLocalDiskStorageProvider(path.join(home, "objects")));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(activityLog);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaceSnapshots);
    await db.delete(nativeRunFinalizations);
    await db.delete(environmentLeases);
    await db.delete(environments);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });
  async function fixture() {
    const companyId = randomUUID(), projectId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Online source", issuePrefix: `O${companyId.slice(0, 6)}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "Shared legacy project" });
    const cwd = resolveManagedProjectWorkspaceDir({ companyId, projectId });
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(cwd, "saved.txt"), "saved legacy edits\n");
    const aliases = [];
    for (let n = 0; n < 3; n++) {
      const [issue] = await db.insert(issues).values({ companyId, projectId, title: `Legacy task ${n}` }).returning();
      const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId, sourceIssueId: issue.id,
        name: `Alias ${n}`, mode: "shared_workspace", strategyType: "project_primary", providerType: "local_fs", cwd, providerRef: cwd }).returning();
      await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, issue.id));
      aliases.push({ issue, workspace });
    }
    return { companyId, projectId, cwd, aliases, workspaceId: aliases[0].workspace.id };
  }
  async function stored(workspaceId: string) {
    return (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId)))[0];
  }
  function uploadBarrier() {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const put = storage.putFile.bind(storage);
    vi.spyOn(storage, "putFile").mockImplementationOnce(async input => {
      const result = await put(input); entered(); await pending; return result;
    });
    return { started, release };
  }
  async function remoteWriter(companyId: string, agentId: string) {
    const workspaceId = randomUUID(), runId = randomUUID(), leaseId = randomUUID(), providerLeaseId = randomUUID();
    const [issue] = await db.insert(issues).values({ companyId, title: "Unrelated object-backed task" }).returning();
    const [environment] = await db.insert(environments).values({ name: runId, driver: "daytona" }).returning();
    const remoteCwd = `/workspaces/${workspaceId}`;
    const authority = { schema: "paperclip.remote-workspace.v1", epoch: 1, snapshotId: null, source: { kind: "empty" },
      location: { environmentId: environment.id, leaseId, providerLeaseId, remoteCwd }, writerRunId: runId, dirty: true };
    const [workspace] = await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issue.id,
      name: "Unrelated remote writer", mode: "isolated_workspace", strategyType: "project_primary", providerType: "cloud_sandbox",
      cwd: remoteCwd, metadata: { remoteWorkspace: authority } }).returning();
    const reference = { schema: "paperclip.remote-workspace-run.v1", workspaceId, leaseId, providerLeaseId,
      remoteCwd, epoch: 1, state: "prepared", snapshotId: null };
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId: issue.id,
      nativeIssueId: issue.id, status: "running", runtimeMode: "native", contextSnapshot: { executionWorkspaceId: workspaceId },
      runnerProfileJson: { remoteWorkspace: reference } }).returning();
    await db.insert(environmentLeases).values({ id: leaseId, companyId, heartbeatRunId: runId, issueId: issue.id,
      executionWorkspaceId: workspaceId, environmentId: environment.id, provider: "daytona", providerLeaseId,
      status: "active", metadata: { remoteCwd } });
    expect(readRemoteWorkspaceAuthority(workspace.metadata)).toEqual(authority);
    expect(readRemoteWorkspaceRunReference(run.runnerProfileJson?.remoteWorkspace)).toEqual(reference);
    return run;
  }
  it("imports an alias with unrelated object-backed execution still running and leaves all original files", async () => {
    const f = await fixture();
    const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Unrelated active agent" }).returning();
    const run = await remoteWriter(f.companyId, agent.id);
    expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: true });
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).resolves.toMatchObject({ applied: true });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]).toEqual(run);
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
    expect(await stored(f.aliases[1].workspace.id)).toEqual(f.aliases[1].workspace);
    const authority = readRemoteWorkspaceAuthority((await stored(f.workspaceId)).metadata)!;
    const reference = await getWorkspaceSnapshot(db, { ...f, snapshotId: authority.snapshotId! });
    const archivePath = path.join(home, "restored.pcws"), targetDir = path.join(home, "restored");
    await loadWorkspaceSnapshotArchive({ storage, reference: reference!, targetPath: archivePath });
    await restoreRemoteWorkspaceArchive({ archivePath, targetDir, expectedManifestDigest: reference!.manifestDigest });
    expect(await fs.readFile(path.join(targetDir, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
  });
  it("fences future issues and alias lifecycle owners while another project can materialize", async () => {
    const f = await fixture(), barrier = uploadBarrier();
    const migration = migrateRemoteWorkspace({ db, storage, ...f, apply: true });
    await Promise.race([barrier.started, migration.then(() => { throw new Error("capture did not reach upload"); })]);
    let lifecycleEntered = false, preparationEntered = false;
    const preparation = withIsolatedRepositorySourceLock(db, f.companyId, randomUUID(), async () => {
      await materializeManagedProjectWorkspace(path.join(f.cwd, "new-issue"), { repoUrl: null });
      preparationEntered = true;
    });
    const lifecycle = withExecutionWorkspaceLifecycleLock(db, f.aliases[1].workspace.id, async () => { lifecycleEntered = true; });
    try {
      expect(await fs.lstat(path.join(f.cwd, "new-issue")).catch(() => null)).toBeNull();
      const unrelated = resolveManagedProjectWorkspaceDir({ companyId: f.companyId, projectId: randomUUID() });
      await withIsolatedRepositorySourceLock(db, f.companyId, randomUUID(), () =>
        materializeManagedProjectWorkspace(unrelated, { repoUrl: null }));
      expect((await fs.stat(unrelated)).isDirectory()).toBe(true);
      await vi.waitFor(async () => {
        const rows = await db.execute(sql`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event='advisory'`);
        expect(rows[0].n).toBeGreaterThan(0);
      });
      expect(lifecycleEntered).toBe(false);
      expect(preparationEntered).toBe(false);
    } finally { barrier.release(); await migration; await lifecycle; await preparation; }
    expect(lifecycleEntered).toBe(true);
    expect(preparationEntered).toBe(true);
  });
  it("checks every alias issue lock before creating a migration journal", async () => {
    const f = await fixture();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const owner = withIsolatedRepositorySourceLock(db, f.companyId, f.aliases[2].issue.id, async () => { entered(); await pending; });
    await started;
    try {
      await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toBeInstanceOf(IsolatedRepositorySourceBusy);
      expect(await db.select().from(workspaceOperations)).toEqual([]);
    } finally { release(); await owner; }
  });
  it("fences a configured alias of an existing isolated task directory using its original issue key", async () => {
    const f = await fixture(), sourceIssueId = f.aliases[0].issue.id;
    const cwd = path.join(resolvePaperclipInstanceRoot(), "isolated-workspaces", f.companyId, sourceIssueId);
    await fs.mkdir(cwd, { recursive: true });
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const owner = withIsolatedRepositorySourceLock(db, f.companyId, sourceIssueId, async () => { entered(); await pending; });
    await started;
    try {
      await expect(withIsolatedRepositorySourceLock(db, f.companyId, randomUUID(), () =>
        materializeManagedProjectWorkspace(path.join(cwd, "new-alias"), { repoUrl: null })))
        .rejects.toBeInstanceOf(IsolatedRepositorySourceBusy);
      expect(await fs.lstat(path.join(cwd, "new-alias")).catch(() => null)).toBeNull();
    } finally { release(); await owner; }
  });
  it("bounds source-lock closures before reserving a connection", async () => {
    await expect(withWorkspaceSourceLocks(db, { companyId: randomUUID(), issueIds: Array.from({ length: 129 }, () => randomUUID()) },
      async () => { throw new Error("scope must not be admitted"); })).rejects.toThrow("workspace_source_scope_limit");
  });
  it.each(["task", "operation", "foreign", "descendant"] as const)("retains the %s guard across the complete alias closure", async kind => {
    const f = await fixture(), alias = f.aliases[2];
    if (kind === "task") {
      const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Alias checkout" }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: agent.id, status: "succeeded" }).returning();
      await db.update(issues).set({ checkoutRunId: run.id }).where(eq(issues.id, alias.issue.id));
    }
    if (kind === "operation") await db.insert(workspaceOperations).values({ companyId: f.companyId,
      executionWorkspaceId: alias.workspace.id, phase: "cleanup", status: "running" });
    if (kind === "foreign") {
      const companyId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Foreign", issuePrefix: "FOREIGN" });
      await db.insert(executionWorkspaces).values({ companyId, name: "Foreign alias", mode: "shared_workspace",
        strategyType: "project_primary", providerType: "local_fs", cwd: f.cwd });
    }
    if (kind === "descendant") await db.update(executionWorkspaces).set({ cwd: path.join(f.cwd, "child") }).where(eq(executionWorkspaces.id, alias.workspace.id));
    expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: false });
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("remote_workspace_migration_blocked");
    expect(readRemoteWorkspaceAuthority((await stored(f.workspaceId)).metadata)).toBeNull();
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
  });
  it("rechecks closure membership before publication and preserves the uploaded journal on change", async () => {
    const f = await fixture(), put = storage.putFile.bind(storage);
    vi.spyOn(storage, "putFile").mockImplementationOnce(async input => {
      const result = await put(input);
      await db.update(executionWorkspaces).set({ providerRef: "/unproven/new/source" }).where(eq(executionWorkspaces.id, f.aliases[2].workspace.id));
      return result;
    });
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow("online_workspace_source_scope_changed");
    expect(readRemoteWorkspaceAuthority((await stored(f.workspaceId)).metadata)).toBeNull();
    expect((await db.select().from(workspaceOperations))[0].status).toBe("running");
  });
  it("does not publish after the actual source lock connection is terminated", async () => {
    const f = await fixture(), barrier = uploadBarrier();
    const migration = migrateRemoteWorkspace({ db, storage, ...f, apply: true }).then(value => ({ value }), error => ({ error }));
    await Promise.race([barrier.started, migration.then(result => { if ("error" in result) throw result.error; throw new Error("capture did not reach upload"); })]);
    const key = `managed_project_source:${f.companyId}:${f.projectId}`;
    const rows = await db.execute(sql`select distinct a.pid from pg_stat_activity a join pg_locks l on l.pid=a.pid
      where a.datname=current_database() and l.locktype='advisory' and l.granted
      and l.classid=((hashtextextended(${key},0)>>32)&4294967295)::oid
      and l.objid=(hashtextextended(${key},0)&4294967295)::oid`);
    expect(rows).toHaveLength(1);
    await db.execute(sql`select pg_terminate_backend(${Number(rows[0].pid)})`);
    barrier.release();
    expect(await migration).toHaveProperty("error");
    expect(readRemoteWorkspaceAuthority((await stored(f.workspaceId)).metadata)).toBeNull();
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
  });
  async function recoveryFixture() {
    const f = await fixture(), runId = randomUUID();
    const [agent] = await db.insert(agents).values({ companyId: f.companyId, name: "Terminal native worker", adapterType: "paperclip_runner" }).returning();
    const reference = { schema: "paperclip.native-workspace-sync/v3", state: "prepared", workspaceId: f.workspaceId,
      leaseId: randomUUID(), providerLeaseId: randomUUID(), remoteCwd: "/workspaces/retained",
      descriptorSha256: "12".repeat(32), baselineSha256: "34".repeat(32), resourceDisposition: "destroy" };
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: agent.id,
      nativeIssueId: f.aliases[0].issue.id, status: "failed", runtimeMode: "native", runnerProfileJson: { nativeWorkspaceSync: reference } }).returning();
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: f.aliases[0].issue.id,
      runId, phase: "observed" });
    const [environment] = await db.insert(environments).values({ name: runId, driver: "daytona" }).returning();
    const [lease] = await db.insert(environmentLeases).values({ id: reference.leaseId, companyId: f.companyId,
      issueId: f.aliases[0].issue.id, heartbeatRunId: runId, executionWorkspaceId: f.workspaceId, environmentId: environment.id,
      provider: "daytona", providerLeaseId: reference.providerLeaseId, status: "retained", leasePolicy: "retain_on_failure",
      metadata: { remoteCwd: reference.remoteCwd } }).returning();
    await recordNativeFinalizationFailure({ db, runId, error: new Error("native_workspace_sync_out_unrecoverable"),
      failureScope: "workspace", permanent: true });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [owner] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    const [warning] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.aliases[0].issue.id));
    expect(warning).toMatchObject({ kind: "active_run_watchdog", cause: "native_workspace_sync_out_unrecoverable",
      status: "active", evidence: { runId } });
    return { ...f, run, owner, lease, warning };
  }
  it("imports a terminal prepared source while retaining its original provider and finalization obligations", async () => {
    const f = await recoveryFixture(), put = storage.putFile.bind(storage);
    const unrelated = await remoteWriter(f.companyId, f.run.agentId);
    expect(await inventoryRemoteWorkspaceMigration(db, f)).toMatchObject({ eligible: true });
    vi.spyOn(storage, "putFile").mockImplementationOnce(async input => {
      await db.transaction(async tx => {
        expect(await tryLockNativeWorkspaceFinalization(tx as unknown as Db, { companyId: f.companyId, runId: f.run.id })).toBe(false);
      });
      return put(input);
    });
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).resolves.toMatchObject({ applied: true });
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.run.id)))[0]).toEqual(f.owner);
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0]).toEqual(f.lease);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.warning.id)))[0]).toEqual(f.warning);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unrelated.id)))[0]).toEqual(unrelated);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id));
    expect(run.runnerProfileJson?.nativeWorkspaceSync).toEqual(f.run.runnerProfileJson?.nativeWorkspaceSync);
    expect(run.runnerProfileJson?.legacyWorkspaceRecoveryMigration).toMatchObject({ workspaceId: f.workspaceId });
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
  });
  it.each(["expired_owner", "checkpoint", "allocation"] as const)("keeps a prepared source local when %s changes", async change => {
    const f = await recoveryFixture();
    if (change === "expired_owner") await db.update(nativeRunFinalizations).set({ leaseOwner: "still-owned", leaseExpiresAt: new Date(0) })
      .where(eq(nativeRunFinalizations.runId, f.run.id));
    else {
      const put = storage.putFile.bind(storage);
      vi.spyOn(storage, "putFile").mockImplementationOnce(async input => {
        const result = await put(input);
        if (change === "checkpoint") await db.update(nativeRunFinalizations).set({ recoveryHistory: [{ intent: "changed" }] })
          .where(eq(nativeRunFinalizations.runId, f.run.id));
        else await db.update(environmentLeases).set({ metadata: { remoteCwd: "/changed-allocation" } }).where(eq(environmentLeases.id, f.lease.id));
        return result;
      });
    }
    await expect(migrateRemoteWorkspace({ db, storage, ...f, apply: true })).rejects.toThrow();
    expect(readRemoteWorkspaceAuthority((await stored(f.workspaceId)).metadata)).toBeNull();
    expect(await fs.readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("saved legacy edits\n");
  });
});
