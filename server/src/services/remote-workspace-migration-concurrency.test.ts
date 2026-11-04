import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, closeRegisteredClients, companies, createDb, environmentLeases, executionWorkspaceSnapshots,
  executionWorkspaces, heartbeatRuns, issues, nativeRunFinalizations, workspaceOperations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { migrateRemoteWorkspace } from "./remote-workspace-migration.js";
import { commitNativeStatusDecision } from "./native-runtime/status-decision-committer.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION } from "./native-runtime/status-arbiter.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(ready => { resolve = ready; });
  return { promise, resolve };
}

describe("legacy workspace publication ownership contention", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>, root: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("workspace-import-order-");
    db = createDb(database.connectionString);
    root = await mkdtemp(path.join(os.tmpdir(), "workspace-import-order-"));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "62".repeat(32));
    vi.stubEnv("PAPERCLIP_EPHEMERAL_MIGRATION", "true");
  }, 60_000);
  afterAll(async () => {
    if (database) await closeRegisteredClients(database.connectionString);
    await database?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function fixture() {
    const companyId = randomUUID(), runId = randomUUID(), workspaceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Legacy publication", issuePrefix: `L${companyId.slice(0, 6)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Historical worker", adapterType: "paperclip_runner" }).returning();
    const [issue] = await db.insert(issues).values({ companyId, title: "Retain local work", status: "blocked" }).returning();
    const cwd = path.join(root, workspaceId); await mkdir(cwd);
    await writeFile(path.join(cwd, "saved.txt"), "original local work\n");
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issue.id,
      mode: "isolated_workspace", strategyType: "project_primary", providerType: "local_fs", name: "Legacy files", cwd, providerRef: cwd });
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issue.id));
    const reference = { schema: "paperclip.native-workspace-sync/v3", state: "prepared", workspaceId,
      leaseId: randomUUID(), providerLeaseId: randomUUID(), remoteCwd: "/workspaces/task",
      descriptorSha256: "12".repeat(32), baselineSha256: "34".repeat(32), finalHostSha256: null, resourceDisposition: "stop_and_retain" };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: agent.id, nativeIssueId: issue.id,
      runtimeMode: "native", status: "failed", finishedAt: new Date(), runnerProfileJson: { nativeWorkspaceSync: reference } });
    await db.insert(nativeRunFinalizations).values({ companyId, issueId: issue.id, runId, phase: "terminal_failure" });
    const storage = createStorageService(createLocalDiskStorageProvider(path.join(root, `${workspaceId}-objects`)));
    return { companyId, workspaceId, runId, issue, cwd, reference, storage,
      expectedProfile: { nativeWorkspaceSync: reference } as Record<string, unknown>, expectedPhase: "terminal_failure" };
  }

  async function retained(f: Awaited<ReturnType<typeof fixture>>) {
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(workspace.metadata?.remoteWorkspace).toBeUndefined();
    expect(workspace.metadata?.remoteWorkspaceMigration).toMatchObject({ state: "running" });
    expect(run.runnerProfileJson).toEqual(f.expectedProfile);
    expect(coordinator).toMatchObject({ phase: f.expectedPhase, leaseOwner: null, leaseExpiresAt: null });
    expect(await readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("original local work\n");
    const snapshots = await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.executionWorkspaceId, f.workspaceId));
    expect(snapshots).toEqual([expect.objectContaining({ status: "uploaded" })]);
    expect((await f.storage.headObject(f.companyId, snapshots[0].objectKey!)).exists).toBe(true);
    expect(await db.select().from(workspaceOperations).where(eq(workspaceOperations.executionWorkspaceId, f.workspaceId)))
      .toEqual([expect.objectContaining({ phase: "remote_workspace_migration", status: "running" })]);
  }

  it("refuses a busy publication beside an actual stale native status commit", async () => {
    const f = await fixture();
    const migrationDb = createDb(database.connectionString, { maxConnections: 1, applicationName: "import-native-migration" });
    const nativeDb = createDb(database.connectionString, { maxConnections: 1, applicationName: "import-native-status" });
    await migrationDb.execute(sql`select set_config('deadlock_timeout', '50ms', false)`);
    const uploadReady = deferred(), uploadRelease = deferred(), lockReady = deferred(), lockRelease = deferred();
    const storage = { ...f.storage, putFile: async (input: Parameters<typeof f.storage.putFile>[0]) => {
      const saved = await f.storage.putFile(input); uploadReady.resolve(); await uploadRelease.promise; return saved;
    } };
    let migrationSettled = false;
    const migrating = migrateRemoteWorkspace({ db: migrationDb, storage, companyId: f.companyId,
      workspaceId: f.workspaceId, apply: true, writersStopped: true })
      .then(value => ({ value }), error => ({ error })).finally(() => { migrationSettled = true; });
    let barrier: Promise<void> | undefined, committing: Promise<unknown> | undefined;
    try {
      await uploadReady.promise;
      barrier = db.transaction(async tx => {
        await tx.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
          .where(eq(nativeRunFinalizations.runId, f.runId)).for("update");
        lockReady.resolve(); await lockRelease.promise;
      });
      await lockReady.promise;
      committing = commitNativeStatusDecision({ db: nativeDb, companyId: f.companyId, issueId: f.issue.id,
        runId: f.runId, assessmentId: randomUUID(), priorStatus: f.issue.status,
        priorStatusVersion: f.issue.statusVersion + 1, priorDecisionId: null,
        decision: { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: "preserve", toStatus: "blocked",
          reasonCode: "stale_status_control", unblockDescriptor: null, effects: [] } })
        .then(value => ({ value }), error => ({ error }));
      const waiting = async (application: string) => (await db.execute<{ query: string }>(sql`select query from pg_stat_activity
        where datname = current_database() and application_name = ${application} and wait_event_type = 'Lock'`))[0];
      await expect.poll(async () => (await waiting("import-native-status"))?.query, { timeout: 5000 }).toContain('"native_run_finalizations"');
      uploadRelease.resolve();
      await expect.poll(async () => migrationSettled || Boolean(await waiting("import-native-migration")), { timeout: 5000 }).toBe(true);
      const migrationWait = await waiting("import-native-migration");
      lockRelease.resolve(); await barrier;
      const results = await Promise.all([migrating, committing]);
      const codes = results.map(result => (result as { error?: { cause?: { code?: string } } }).error?.cause?.code);
      if (codes.includes("40P01")) console.info("import-native-postgres-evidence", JSON.stringify({ migrationQuery: migrationWait?.query,
        errors: results.map(result => (result as { error?: { cause?: unknown } }).error?.cause) }));
      expect(codes).not.toContain("40P01");
      expect(results[0]).toMatchObject({ error: expect.objectContaining({ message: "remote_workspace_migration_blocked:execution_rows_busy" }) });
      expect(results[1]).toMatchObject({ error: expect.objectContaining({ code: "native_status_race" }) });
      await retained(f);
      await expect(migrateRemoteWorkspace({ db, storage: f.storage, companyId: f.companyId,
        workspaceId: f.workspaceId, apply: true, writersStopped: true })).resolves.toMatchObject({ applied: true });
      expect(await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.executionWorkspaceId, f.workspaceId)))
        .toEqual([expect.objectContaining({ status: "committed" })]);
    } finally {
      uploadRelease.resolve(); lockRelease.resolve(); await barrier; await Promise.all([migrating, committing]);
      await migrationDb.$client.end(); await nativeDb.$client.end();
    }
  }, 30_000);

  it.each(["run", "lease"] as const)("holds publication while the saved %s is busy", async kind => {
    const f = await fixture();
    if (kind === "lease") {
      await db.insert(environmentLeases).values({ id: f.reference.leaseId, companyId: f.companyId, heartbeatRunId: f.runId,
        issueId: f.issue.id, provider: "daytona", providerLeaseId: f.reference.providerLeaseId,
        status: "released", metadata: { remoteCwd: f.reference.remoteCwd } });
      f.expectedProfile = {}; f.expectedPhase = "observed";
      await db.update(heartbeatRuns).set({ runnerProfileJson: {}, resultJson: { workspaceRestoreRecovery: {
        schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [f.reference.leaseId] } } }).where(eq(heartbeatRuns.id, f.runId));
      await db.update(nativeRunFinalizations).set({ phase: "observed" }).where(eq(nativeRunFinalizations.runId, f.runId));
    }
    const ready = deferred(), release = deferred();
    const barrier = db.transaction(async tx => {
      if (kind === "run") await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)).for("update");
      else await tx.select({ id: environmentLeases.id }).from(environmentLeases).where(eq(environmentLeases.id, f.reference.leaseId)).for("update");
      ready.resolve(); await release.promise;
    });
    await ready.promise;
    let settled = false;
    const migrating = migrateRemoteWorkspace({ db, storage: f.storage, companyId: f.companyId,
      workspaceId: f.workspaceId, apply: true, writersStopped: true })
      .then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
    try {
      await expect.poll(() => settled, { timeout: 5000 }).toBe(true);
      expect(await migrating).toMatchObject({ error: expect.objectContaining({ message: "remote_workspace_migration_blocked:execution_rows_busy" }) });
      await retained(f);
      release.resolve(); await barrier;
      await expect(migrateRemoteWorkspace({ db, storage: f.storage, companyId: f.companyId,
        workspaceId: f.workspaceId, apply: true, writersStopped: true })).resolves.toMatchObject({ applied: true });
    } finally { release.resolve(); await barrier; await migrating; }
  }, 30_000);

  it("rolls back publication writes and preserves an unexpected database error", async () => {
    const f = await fixture();
    await db.update(nativeRunFinalizations).set({ phase: "observed", leaseOwner: "expired-controller",
      leaseExpiresAt: new Date(Date.now() - 60_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
    const [before] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    await db.execute(sql.raw(`create function import_publication_failure() returns trigger language plpgsql as $$
      begin raise exception 'publication constraint failed' using errcode = '23514'; end $$`));
    await db.execute(sql.raw(`create trigger import_publication_failure before update on execution_workspaces for each row
      when (new.id = '${f.workspaceId}'::uuid and new.metadata ? 'remoteWorkspace') execute function import_publication_failure()`));
    try {
      await expect(migrateRemoteWorkspace({ db, storage: f.storage, companyId: f.companyId,
        workspaceId: f.workspaceId, apply: true, writersStopped: true })).rejects.toMatchObject({ cause: { code: "23514" } });
      const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
      expect(workspace.metadata?.remoteWorkspace).toBeUndefined();
      expect(run.runnerProfileJson).toEqual(f.expectedProfile);
      expect(coordinator).toEqual(before);
      expect(await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.executionWorkspaceId, f.workspaceId)))
        .toEqual([expect.objectContaining({ status: "uploaded" })]);
      expect(await readFile(path.join(f.cwd, "saved.txt"), "utf8")).toBe("original local work\n");
    } finally {
      await db.execute(sql`drop trigger import_publication_failure on execution_workspaces`);
      await db.execute(sql`drop function import_publication_failure()`);
    }
  }, 30_000);
});
