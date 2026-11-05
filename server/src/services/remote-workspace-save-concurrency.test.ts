import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, closeRegisteredClients, companies, createDb, environmentLeases, environments,
  executionWorkspaces, executionWorkspaceSnapshots, heartbeatRuns, issues, workspaceOperations,
} from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { EnvironmentLease } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { preserveRemoteWorkspacePreparationFailure } from "./native-runtime/native-workspace-finalization-state.js";
import {
  createSavedWorkspaceLoader, prepareRemoteWorkspace, readRemoteWorkspaceAuthority,
  provisionRemoteWorkspace, reserveRemoteWorkspace, saveRemoteWorkspace,
} from "./remote-workspaces.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { migrateRemoteWorkspace } from "./remote-workspace-migration.js";

const exec = promisify(execFile);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(ready => { resolve = ready; });
  return { promise, resolve };
}

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("remote workspace save parent lock order", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("workspace-save-order-");
    db = createDb(database.connectionString);
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "workspace-save-order-")));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "62".repeat(32));
    vi.stubEnv("DATABASE_URL", database.connectionString);
  }, 60_000);
  afterAll(async () => {
    if (database) await closeRegisteredClients(database.connectionString);
    await database?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function preparedFailure() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Save lock order", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Preserve saved work", status: "blocked", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, runtimeMode: "legacy",
      status: "running", executionStage: "preparing", contextSnapshot: { issueId } });
    const [environment] = await db.insert(environments).values({ name: runId, driver: "sandbox" }).returning();
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId,
      environmentId: environment.id, provider: "daytona", providerLeaseId: randomUUID(), status: "active" }).returning();
    const storage = { ...createStorageService(createLocalDiskStorageProvider(path.join(root, runId, "objects"))), provider: "s3" as const };
    const remoteCwd = path.join(root, runId, "remote");
    await mkdir(remoteCwd, { recursive: true });
    const transfer: NonNullable<NonNullable<AdapterSandboxExecutionTarget["runner"]>["syncIn"]> = async operations => {
      for (const operation of operations) for (const file of operation.files) {
        await mkdir(path.dirname(file.targetPath), { recursive: true });
        await cp(file.sourcePath, file.targetPath, { recursive: file.kind === "directory" });
      }
      return { operations: operations.map(operation => ({ operationId: operation.operationId,
        filesTransferred: operation.files.length, bytesTransferred: 0 })) };
    };
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote", transport: "sandbox", leaseId: lease.id, remoteCwd, timeoutMs: 30_000,
      runner: { syncIn: transfer, syncOut: transfer, execute: async input => {
        const result = await exec(input.command, input.args ?? [], { cwd: input.cwd ?? remoteCwd,
          env: { ...process.env, ...input.env }, timeout: input.timeoutMs, maxBuffer: 8 * 1024 * 1024 });
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr, signal: null, timedOut: false,
          pid: process.pid, startedAt: new Date().toISOString() };
      } },
    };
    const reserved = await reserveRemoteWorkspace({ db, storage, companyId, issueId, runId, agentId,
      environmentId: environment.id, projectId: null, projectWorkspaceId: null, existingWorkspaceId: null, source: { kind: "empty" } });
    const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId,
      lease: lease as EnvironmentLease, target });
    await writeFile(path.join(prepared.remoteRoot, "saved.txt"), "one preserved result\n");
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), errorCode: "setup_failed",
      resultJson: { workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: {
        schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [lease.id],
      } } }).where(eq(heartbeatRuns.id, runId));
    const [stoppedLease] = await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success",
      metadata: { ...prepared.lease.metadata, remoteExecutionTermination: remoteTerminationReceipt(lease,
        { providerLeaseId: lease.providerLeaseId, state: "stopped" }) } }).where(eq(environmentLeases.id, lease.id)).returning();
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, reserved.id));
    const snapshots = await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.executionWorkspaceId, workspace.id));
    return { companyId, agentId, issueId, runId, workspace, environmentId: environment.id,
      lease: stoppedLease as EnvironmentLease, target, storage, snapshotCount: snapshots.length,
      generation: Math.max(0, ...snapshots.map(snapshot => snapshot.generation)) };
  }

  it.each([
    { mode: "preserve", stage: "reservation" },
    { mode: "reserve", stage: "reservation" },
    { mode: "preserve", stage: "publication" },
  ] as const)("saves once beside actual $mode ($stage)", async ({ mode, stage }) => {
    const f = await preparedFailure();
    const nextRunId = randomUUID();
    if (mode === "reserve") await db.insert(heartbeatRuns).values({ id: nextRunId, companyId: f.companyId,
      agentId: f.agentId, issueId: f.issueId, runtimeMode: "legacy", status: "running", contextSnapshot: { issueId: f.issueId } });
    const saveDb = createDb(database.connectionString, { maxConnections: 1, applicationName: "save-order-save" });
    const peerDb = createDb(database.connectionString, { maxConnections: 1, applicationName: "save-order-preserve" });
    await saveDb.execute(sql`select set_config('deadlock_timeout', '50ms', false)`);
    const barrierKey = 7540291;
    await db.execute(sql.raw(`create function save_order_gate() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(${barrierKey}); return new; end $$`));
    const triggerTable = stage === "reservation" ? "workspace_operations" : "execution_workspace_snapshots";
    await db.execute(sql.raw(stage === "reservation"
      ? `create trigger save_order_gate before insert on workspace_operations for each row
          when (new.heartbeat_run_id = '${f.runId}'::uuid and new.phase = 'remote_workspace_snapshot') execute function save_order_gate()`
      : `create trigger save_order_gate before update on execution_workspace_snapshots for each row
          when (new.source_run_id = '${f.runId}'::uuid and new.status = 'committed' and old.status = 'uploaded') execute function save_order_gate()`));
    const ready = deferred(), release = deferred();
    const barrier = db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(${barrierKey})`);
      ready.resolve(); await release.promise;
    });
    await ready.promise;
    let saving: Promise<PromiseSettledResult<Awaited<ReturnType<typeof saveRemoteWorkspace>>>> | undefined;
    let preserving: Promise<PromiseSettledResult<unknown>> | undefined;
    const reserveNext = () => reserveRemoteWorkspace({ db: peerDb, storage: f.storage,
      companyId: f.companyId, issueId: f.issueId, runId: nextRunId, agentId: f.agentId,
      environmentId: f.environmentId, projectId: null, projectWorkspaceId: null,
      existingWorkspaceId: f.workspace.id, source: { kind: "empty" } });
    const settle = <T,>(work: Promise<T>): Promise<PromiseSettledResult<T>> => work.then(
      value => ({ status: "fulfilled", value }), reason => ({ status: "rejected", reason }));
    try {
      saving = settle(saveRemoteWorkspace({ db: saveDb, storage: f.storage, workspace: f.workspace,
        runId: f.runId, lease: f.lease, target: f.target, assertOwned: async () => undefined }));
      const activity = async (application: string) => (await db.execute<{ pid: number; query: string; wait_event: string; blockers: number[] }>(sql`
        select pid, query, wait_event, pg_blocking_pids(pid) as blockers from pg_stat_activity
        where datname = current_database() and application_name = ${application} and wait_event_type = 'Lock'`))[0];
      await expect.poll(async () => (await activity("save-order-save"))?.wait_event, { timeout: 5000 }).toBe("advisory");
      const savePid = (await activity("save-order-save"))!.pid;
      preserving = settle<unknown>(mode === "preserve" ? preserveRemoteWorkspacePreparationFailure(peerDb, f.lease) : reserveNext());
      await expect.poll(async () => (await activity("save-order-preserve"))?.blockers.includes(savePid), { timeout: 5000 }).toBe(true);
      const peer = await activity("save-order-preserve");
      release.resolve(); await barrier;
      const results = await Promise.all([saving, preserving]);
      const errors = results.filter((result, index) => result.status === "rejected" && (index === 0 || mode === "preserve"))
        .map(result => (result as PromiseRejectedResult).reason as Error & { cause?: { code?: string; detail?: string; where?: string } });
      if (errors.length) console.info("save-order-postgres-evidence", JSON.stringify({ mode, stage, peerQuery: peer?.query,
        errors: errors.map(error => ({ code: error.cause?.code, detail: error.cause?.detail, where: error.cause?.where })) }));
      expect(errors).toEqual([]);
      const saved = (results[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof saveRemoteWorkspace>>>).value;
      const restarted = createDb(database.connectionString);
      const [workspace] = await restarted.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspace.id));
      expect(readRemoteWorkspaceAuthority(workspace.metadata)).toMatchObject({ dirty: false, snapshotId: saved.snapshotId });
      const snapshots = await restarted.select().from(executionWorkspaceSnapshots).where(and(eq(executionWorkspaceSnapshots.companyId, f.companyId),
        eq(executionWorkspaceSnapshots.sourceRunId, f.runId)));
      expect(snapshots).toHaveLength(f.snapshotCount + 1);
      expect(snapshots.filter(snapshot => snapshot.status === "committed"))
        .toEqual([expect.objectContaining({ id: saved.snapshotId, generation: f.generation + 1 })]);
      expect(await restarted.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, f.companyId),
        eq(workspaceOperations.heartbeatRunId, f.runId), eq(workspaceOperations.phase, "remote_workspace_snapshot"),
        sql`${workspaceOperations.metadata}->>'boundary' = 'final'`)))
        .toEqual([expect.objectContaining({ status: "succeeded" })]);
      const loaded = await createSavedWorkspaceLoader(restarted, f.storage)({ companyId: f.companyId,
        workspaceId: f.workspace.id, snapshotId: saved.snapshotId });
      try { expect(await readFile(path.join(loaded.root, "saved.txt"), "utf8")).toBe("one preserved result\n"); }
      finally { await loaded.cleanup(); }
      if (mode === "reserve") {
        if (results[1].status === "rejected") expect(results[1].reason).toMatchObject({ details: { code: "remote_workspace_writer_pending" } });
        const admitted = await reserveNext(), repeated = await reserveNext();
        expect(readRemoteWorkspaceAuthority(admitted.metadata)).toMatchObject({ writerRunId: nextRunId,
          dirty: false, snapshotId: saved.snapshotId });
        expect(readRemoteWorkspaceAuthority(repeated.metadata)).toEqual(readRemoteWorkspaceAuthority(admitted.metadata));
      }
    } finally {
      release.resolve(); await barrier;
      await Promise.all([saving, preserving]);
      await db.execute(sql`drop trigger save_order_gate on ${sql.identifier(triggerTable)}`);
      await db.execute(sql`drop function save_order_gate()`);
      await saveDb.$client.end(); await peerDb.$client.end();
    }
  }, 30_000);

  it("releases database locks while a provisioning command is in flight", async () => {
    const f = await preparedFailure();
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
    const authority = readRemoteWorkspaceAuthority(f.workspace.metadata)!;
    const ready = deferred(), release = deferred();
    const execute = f.target.runner!.execute.bind(f.target.runner!);
    const command = "printf 'one effect\\n' >> in-flight.txt";
    let calls = 0;
    f.target.runner!.execute = async input => {
      if (input.command === "bash" && input.args?.[1] === command) {
        calls++; ready.resolve(); await release.promise;
      }
      return execute(input);
    };
    const provision = () => provisionRemoteWorkspace({ db, companyId: f.companyId, workspaceId: f.workspace.id,
      runId: f.runId, epoch: authority.epoch, remoteCwd: authority.location!.remoteCwd, target: f.target, commands: [command] });
    const provisioning = provision();
    try {
      await ready.promise;
      await saveRemoteWorkspace({ db, storage: f.storage, workspace: f.workspace, runId: f.runId,
        lease: f.lease, target: f.target, boundary: "checkpoint", assertOwned: async () => undefined });
      expect(calls).toBe(1);
      release.resolve(); await provisioning; await provision();
      expect(calls).toBe(1);
      expect(await readFile(path.join(authority.location!.remoteCwd, "in-flight.txt"), "utf8")).toBe("one effect\n");
    } finally { release.resolve(); await provisioning; }
  }, 30_000);

  it("holds an unknown provisioning effect after a lost command response", async () => {
    const f = await preparedFailure();
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
    const authority = readRemoteWorkspaceAuthority(f.workspace.metadata)!;
    const execute = f.target.runner!.execute.bind(f.target.runner!);
    const command = "printf 'one effect\\n' >> unknown-effect.txt";
    let calls = 0;
    f.target.runner!.execute = async input => {
      const result = await execute(input);
      if (input.command === "bash" && input.args?.[1] === command) { calls++; throw new Error("command response lost"); }
      return result;
    };
    const provision = () => provisionRemoteWorkspace({ db, companyId: f.companyId, workspaceId: f.workspace.id,
      runId: f.runId, epoch: authority.epoch, remoteCwd: authority.location!.remoteCwd, target: f.target, commands: [command] });
    await expect(provision()).rejects.toThrow("command response lost");
    await expect(provision()).rejects.toThrow("remote_workspace_provision_unverified");
    expect(calls).toBe(1);
    expect(await readFile(path.join(authority.location!.remoteCwd, "unknown-effect.txt"), "utf8")).toBe("one effect\n");
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspace.id));
    expect(readRemoteWorkspaceAuthority(workspace.metadata)).toEqual(authority);
    expect(await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, f.companyId),
      eq(workspaceOperations.heartbeatRunId, f.runId), eq(workspaceOperations.phase, "remote_workspace_provision"))))
      .toEqual([expect.objectContaining({ status: "running", metadata: expect.objectContaining({ uncertain: true }) })]);
  }, 30_000);

  it("does not admit Save before an administrative import publishes remote authority", async () => {
    const f = await preparedFailure(), workspaceId = randomUUID();
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Import legacy files" }).returning();
    const cwd = path.join(root, workspaceId); await mkdir(cwd);
    await writeFile(path.join(cwd, "local.txt"), "retained local work\n");
    const [workspace] = await db.insert(executionWorkspaces).values({ id: workspaceId, companyId: f.companyId,
      sourceIssueId: issue.id, mode: "isolated_workspace", strategyType: "project_primary", providerType: "local_fs",
      name: "Legacy files", cwd, providerRef: cwd }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issue.id));
    const ready = deferred(), release = deferred();
    const storage = { ...f.storage, putFile: async (input: Parameters<typeof f.storage.putFile>[0]) => {
      const saved = await f.storage.putFile(input); ready.resolve(); await release.promise; return saved;
    } };
    const migrating = migrateRemoteWorkspace({ db, storage, companyId: f.companyId, workspaceId, apply: true })
      .then(value => ({ value }), error => ({ error }));
    try {
      await ready.promise;
      await expect(saveRemoteWorkspace({ db, storage, workspace, runId: f.runId,
        lease: f.lease, target: f.target, assertOwned: async () => undefined })).rejects.toThrow("remote_workspace_save_binding_mismatch");
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, issueId: issue.id,
        runtimeMode: "legacy", status: "running", contextSnapshot: { issueId: issue.id } });
      release.resolve();
      expect(await migrating).toMatchObject({ error: expect.objectContaining({ message: expect.stringContaining("active_execution") }) });
      const [current] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
      expect(readRemoteWorkspaceAuthority(current.metadata)).toBeNull();
      expect(await readFile(path.join(cwd, "local.txt"), "utf8")).toBe("retained local work\n");
    } finally { release.resolve(); await migrating; }
  }, 30_000);

  it("rechecks the migration source task after waiting for the workspace", async () => {
    const f = await preparedFailure();
    const [other] = await db.insert(issues).values({ companyId: f.companyId, title: "Changed source" }).returning();
    const peerDb = createDb(database.connectionString, { maxConnections: 1, applicationName: "save-order-migration-binding" });
    const ready = deferred(), release = deferred();
    const barrier = db.transaction(async tx => {
      await tx.select({ id: executionWorkspaces.id }).from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, f.workspace.id)).for("update");
      ready.resolve(); await release.promise;
      await tx.update(executionWorkspaces).set({ sourceIssueId: other.id }).where(eq(executionWorkspaces.id, f.workspace.id));
    });
    await ready.promise;
    const migrating = migrateRemoteWorkspace({ db: peerDb, storage: f.storage, companyId: f.companyId,
      workspaceId: f.workspace.id, apply: true }).then(value => ({ value }), error => ({ error }));
    try {
      await expect.poll(async () => (await db.execute<{ waiting: boolean }>(sql`select exists(select 1 from pg_stat_activity
        where datname = current_database() and application_name = 'save-order-migration-binding'
          and wait_event_type = 'Lock' and query like '%"execution_workspaces"%') as waiting`))[0]?.waiting,
      { timeout: 5000 }).toBe(true);
      release.resolve(); await barrier;
      expect(await migrating).toMatchObject({ error: expect.objectContaining({ message: "remote_workspace_migration_source_changed" }) });
      const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspace.id));
      expect(readRemoteWorkspaceAuthority(workspace.metadata)).toEqual(readRemoteWorkspaceAuthority(f.workspace.metadata));
      expect(workspace.metadata?.remoteWorkspaceMigration).toBeUndefined();
      expect(await readFile(path.join(readRemoteWorkspaceAuthority(workspace.metadata)!.location!.remoteCwd, "saved.txt"), "utf8"))
        .toBe("one preserved result\n");
    } finally { release.resolve(); await barrier; await migrating; await peerDb.$client.end(); }
  }, 30_000);

  it("keeps import publication and an arriving legacy reservation in parent order", async () => {
    const f = await preparedFailure(), workspaceId = randomUUID();
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Import before admission" }).returning();
    const cwd = path.join(root, workspaceId); await mkdir(cwd);
    await writeFile(path.join(cwd, "local.txt"), "retained local work\n");
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId: f.companyId, sourceIssueId: issue.id,
      mode: "isolated_workspace", strategyType: "project_primary", providerType: "local_fs", name: "Legacy files", cwd, providerRef: cwd });
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issue.id));
    const migrationDb = createDb(database.connectionString, { maxConnections: 1, applicationName: "save-order-import-peer" });
    const reserveDb = createDb(database.connectionString, { maxConnections: 1, applicationName: "save-order-import-reserve" });
    await reserveDb.execute(sql`select set_config('deadlock_timeout', '50ms', false)`);
    const uploadReady = deferred(), uploadRelease = deferred(), lockReady = deferred(), lockRelease = deferred();
    const storage = { ...f.storage, putFile: async (input: Parameters<typeof f.storage.putFile>[0]) => {
      const saved = await f.storage.putFile(input); uploadReady.resolve(); await uploadRelease.promise; return saved;
    } };
    const migrating = migrateRemoteWorkspace({ db: migrationDb, storage, companyId: f.companyId, workspaceId, apply: true })
      .then(value => ({ value }), error => ({ error }));
    let barrier: Promise<void> | undefined, reserving: Promise<{ error: unknown } | { value: unknown }> | undefined;
    try {
      await uploadReady.promise;
      barrier = db.transaction(async tx => {
        await tx.select({ id: executionWorkspaces.id }).from(executionWorkspaces)
          .where(eq(executionWorkspaces.id, workspaceId)).for("update");
        lockReady.resolve(); await lockRelease.promise;
      });
      await lockReady.promise;
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
        issueId: issue.id, runtimeMode: "legacy", status: "running", contextSnapshot: { issueId: issue.id } }).returning();
      uploadRelease.resolve();
      const waiting = async (application: string) => (await db.execute<{ query: string; blockers: number[] }>(sql`
        select query, pg_blocking_pids(pid) as blockers from pg_stat_activity
        where datname = current_database() and application_name = ${application} and wait_event_type = 'Lock'`))[0];
      await expect.poll(async () => (await waiting("save-order-import-peer"))?.query, { timeout: 5000 }).toContain('"execution_workspaces"');
      reserving = reserveRemoteWorkspace({ db: reserveDb, storage: f.storage, companyId: f.companyId, issueId: issue.id,
        runId: run.id, agentId: f.agentId, environmentId: f.environmentId, projectId: null,
        projectWorkspaceId: null, existingWorkspaceId: workspaceId, source: { kind: "empty" } })
        .then(value => ({ value }), error => ({ error }));
      await expect.poll(async () => Boolean(await waiting("save-order-import-reserve")), { timeout: 5000 }).toBe(true);
      const peerWait = await waiting("save-order-import-peer"), reserveWait = await waiting("save-order-import-reserve");
      lockRelease.resolve(); await barrier;
      const results = await Promise.all([migrating, reserving]);
      const databaseErrors = results.flatMap(result => "error" in result && (result.error as { cause?: { code?: string } })?.cause?.code
        ? [result.error as { cause: { code: string; detail?: string; where?: string } }] : []);
      if (databaseErrors.length) console.info("save-order-import-postgres-evidence", JSON.stringify({
        peerQuery: peerWait?.query, reserveQuery: reserveWait?.query, errors: databaseErrors.map(error => error.cause) }));
      expect(databaseErrors).toEqual([]);
      expect(results[0]).toMatchObject({ error: expect.objectContaining({ message: expect.stringContaining("active_execution") }) });
      expect(results[1]).toMatchObject({ error: expect.objectContaining({ details: { code: "remote_workspace_migration_required" } }) });
      const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
      expect(readRemoteWorkspaceAuthority(workspace.metadata)).toBeNull();
      expect(await readFile(path.join(cwd, "local.txt"), "utf8")).toBe("retained local work\n");
      const snapshots = await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.executionWorkspaceId, workspaceId));
      expect(snapshots).toEqual([expect.objectContaining({ status: "uploaded" })]);
      expect((await f.storage.headObject(f.companyId, snapshots[0].objectKey!)).exists).toBe(true);
    } finally {
      uploadRelease.resolve(); lockRelease.resolve(); await barrier; await Promise.all([migrating, reserving]);
      await migrationDb.$client.end(); await reserveDb.$client.end();
    }
  }, 30_000);

  it.each(["prepare", "provision", "migrate"] as const)("saves beside actual %s started first", async mode => {
    const f = await preparedFailure();
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null, resultJson: null, errorCode: null })
      .where(eq(heartbeatRuns.id, f.runId));
    const metadata = { ...f.lease.metadata }; delete metadata.remoteExecutionTermination;
    const [lease] = await db.update(environmentLeases).set({ status: "active", releasedAt: null, cleanupStatus: null, metadata })
      .where(eq(environmentLeases.id, f.lease.id)).returning();
    const authority = readRemoteWorkspaceAuthority(f.workspace.metadata)!;
    const saveDb = createDb(database.connectionString, { maxConnections: 1, applicationName: "save-order-reverse-save" });
    const peerDb = createDb(database.connectionString, { maxConnections: 1, applicationName: "save-order-reverse-peer" });
    await saveDb.execute(sql`select set_config('deadlock_timeout', '50ms', false)`);
    const ready = deferred(), release = deferred();
    const barrier = db.transaction(async tx => {
      await tx.select({ id: executionWorkspaces.id }).from(executionWorkspaces)
        .where(eq(executionWorkspaces.id, f.workspace.id)).for("update");
      ready.resolve(); await release.promise;
    });
    await ready.promise;
    const command = "printf 'effect\\n' >> provision-count.txt";
    const provision = () => provisionRemoteWorkspace({ db: peerDb, companyId: f.companyId, workspaceId: f.workspace.id,
      runId: f.runId, epoch: authority.epoch, remoteCwd: authority.location!.remoteCwd, target: f.target, commands: [command] });
    const settle = <T,>(work: Promise<T>): Promise<PromiseSettledResult<T>> => work.then(
      value => ({ status: "fulfilled", value }), reason => ({ status: "rejected", reason }));
    let saving: Promise<PromiseSettledResult<Awaited<ReturnType<typeof saveRemoteWorkspace>>>> | undefined;
    let peer: Promise<PromiseSettledResult<unknown>> | undefined;
    try {
      const waiting = async (application: string) => (await db.execute<{ pid: number; query: string; blockers: number[] }>(sql`
        select pid, query, pg_blocking_pids(pid) as blockers from pg_stat_activity
        where datname = current_database() and application_name = ${application} and wait_event_type = 'Lock'`))[0];
      peer = settle<unknown>(mode === "prepare" ? prepareRemoteWorkspace({ db: peerDb, storage: f.storage,
        workspace: f.workspace, runId: f.runId, lease: lease as EnvironmentLease, target: f.target })
        : mode === "provision" ? provision() : migrateRemoteWorkspace({ db: peerDb, storage: f.storage,
          companyId: f.companyId, workspaceId: f.workspace.id, apply: true }));
      await expect.poll(async () => (await waiting("save-order-reverse-peer"))?.query,
        { timeout: 5000 }).toContain('"execution_workspaces"');
      const peerWait = await waiting("save-order-reverse-peer");
      saving = settle(saveRemoteWorkspace({ db: saveDb, storage: f.storage, workspace: f.workspace,
        runId: f.runId, lease: lease as EnvironmentLease, target: f.target, boundary: "checkpoint", assertOwned: async () => undefined }));
      await expect.poll(async () => Boolean(await waiting("save-order-reverse-save")), { timeout: 5000 }).toBe(true);
      const saveWait = await waiting("save-order-reverse-save");
      release.resolve(); await barrier;
      const results = await Promise.all([saving, peer]);
      const errors = results.filter(result => result.status === "rejected").map(result =>
        (result as PromiseRejectedResult).reason as Error & { cause?: { code?: string; detail?: string; where?: string } });
      if (errors.length) console.info("save-order-reverse-postgres-evidence", JSON.stringify({ mode,
        peerQuery: peerWait?.query, saveQuery: saveWait?.query,
        errors: errors.map(error => ({ code: error.cause?.code, detail: error.cause?.detail, where: error.cause?.where })) }));
      expect(errors).toEqual([]);
      if (mode === "migrate") expect((results[1] as PromiseFulfilledResult<unknown>).value).toMatchObject({ applied: true, replayed: true });
      if (mode === "provision") {
        await provision();
        expect(await readFile(path.join(authority.location!.remoteCwd, "provision-count.txt"), "utf8")).toBe("effect\n");
        expect(await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, f.companyId),
          eq(workspaceOperations.heartbeatRunId, f.runId), eq(workspaceOperations.phase, "remote_workspace_provision"))))
          .toEqual([expect.objectContaining({ issueId: f.issueId, status: "succeeded", metadata: expect.objectContaining({ uncertain: false }) })]);
      }
      const [current] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspace.id));
      const saved = await saveRemoteWorkspace({ db: saveDb, storage: f.storage, workspace: current,
        runId: f.runId, lease: lease as EnvironmentLease, target: f.target, assertOwned: async () => undefined });
      const loaded = await createSavedWorkspaceLoader(db, f.storage)({ companyId: f.companyId,
        workspaceId: f.workspace.id, snapshotId: saved.snapshotId });
      try {
        expect(await readFile(path.join(loaded.root, "saved.txt"), "utf8")).toBe("one preserved result\n");
        if (mode === "provision") expect(await readFile(path.join(loaded.root, "provision-count.txt"), "utf8")).toBe("effect\n");
      } finally { await loaded.cleanup(); }
    } finally {
      release.resolve(); await barrier; await Promise.all([saving, peer]);
      await saveDb.$client.end(); await peerDb.$client.end();
    }
  }, 30_000);

  it.each([false, true])("preserves immutable task identity while waiting for its lock (foreign company=%s)", async foreignCompany => {
    const f = await preparedFailure();
    const companyId = foreignCompany ? randomUUID() : f.companyId;
    if (foreignCompany) await db.insert(companies).values({ id: companyId, name: "Other owner", issuePrefix: `S${companyId.slice(0, 6)}` });
    const [otherIssue] = await db.insert(issues).values({ companyId, title: "Other task", status: "blocked" }).returning();
    const saveDb = createDb(database.connectionString, { maxConnections: 1, applicationName: "save-order-binding" });
    const ready = deferred(), release = deferred();
    const barrier = db.transaction(async tx => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, f.issueId)).for("update");
      ready.resolve(); await release.promise;
    });
    await ready.promise;
    const saving = saveRemoteWorkspace({ db: saveDb, storage: f.storage, workspace: f.workspace,
      runId: f.runId, lease: f.lease, target: f.target, assertOwned: async () => undefined })
      .then(value => ({ value }), error => ({ error }));
    try {
      await expect.poll(async () => (await db.execute<{ waiting: boolean }>(sql`select exists(select 1 from pg_stat_activity
        where datname = current_database() and application_name = 'save-order-binding'
          and wait_event_type = 'Lock' and query like '%"issues"%') as waiting`))[0]?.waiting,
      { timeout: 5000 }).toBe(true);
      await expect(db.update(heartbeatRuns).set({ issueId: otherIssue.id }).where(and(
        eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.id, f.runId))))
        .rejects.toMatchObject({ cause: { code: "P0001", message: "run task binding is immutable" } });
      release.resolve(); await barrier;
      const result = await saving;
      expect(result).toHaveProperty("value.snapshotId");
      const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
      expect(source.issueId).toBe(f.issueId);
      const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspace.id));
      expect(readRemoteWorkspaceAuthority(workspace.metadata)).toMatchObject({ dirty: false, writerRunId: null });
      expect(await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.executionWorkspaceId, workspace.id)))
        .toHaveLength(f.snapshotCount + 1);
      expect(await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, f.companyId),
        eq(workspaceOperations.heartbeatRunId, f.runId), sql`${workspaceOperations.metadata}->>'boundary' = 'final'`)))
        .toEqual([expect.objectContaining({ issueId: f.issueId, status: "succeeded" })]);
    } finally {
      release.resolve(); await barrier; await saving; await saveDb.$client.end();
    }
  }, 30_000);

  it("retains the uploaded snapshot when the workspace writer changes before publication", async () => {
    const f = await preparedFailure();
    const authority = readRemoteWorkspaceAuthority(f.workspace.metadata)!;
    const next = { ...authority, epoch: authority.epoch + 1, writerRunId: randomUUID() };
    let checks = 0;
    await expect(saveRemoteWorkspace({ db, storage: f.storage, workspace: f.workspace,
      runId: f.runId, lease: f.lease, target: f.target, assertOwned: async () => {
        if (++checks === 3) await db.update(executionWorkspaces).set({ metadata: { ...f.workspace.metadata, remoteWorkspace: next } })
          .where(eq(executionWorkspaces.id, f.workspace.id));
      } })).rejects.toThrow("remote_workspace_publication_fenced");
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspace.id));
    expect(readRemoteWorkspaceAuthority(workspace.metadata)).toEqual(next);
    const snapshots = await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.executionWorkspaceId, workspace.id));
    expect(snapshots).toHaveLength(f.snapshotCount + 1);
    const uploaded = snapshots.filter(snapshot => snapshot.status === "uploaded");
    expect(uploaded).toHaveLength(1);
    expect((await f.storage.headObject(f.companyId, uploaded[0].objectKey!)).exists).toBe(true);
    expect(snapshots.filter(snapshot => snapshot.status === "committed")).toHaveLength(1);
    expect(await readFile(path.join(authority.location!.remoteCwd, "saved.txt"), "utf8")).toBe("one preserved result\n");
  }, 30_000);

  it("ends a failed save operation with its redacted cause and reopens it for the retry", async () => {
    const f = await preparedFailure();
    const refused: AdapterSandboxExecutionTarget = { ...f.target, runner: { ...f.target.runner!,
      execute: async () => { throw new Error("Daytona sandbox lease SYNTHETIC-private-id is no longer active."); } } };
    await expect(saveRemoteWorkspace({ db, storage: f.storage, workspace: f.workspace, runId: f.runId, lease: f.lease,
      target: refused, assertOwned: async () => undefined }))
      .rejects.toThrow("remote_workspace_operation_failed: operation=archive_helper transport=sandbox_lease_inactive");
    const snapshotOperation = async () => (await db.select().from(workspaceOperations).where(and(
      eq(workspaceOperations.heartbeatRunId, f.runId), eq(workspaceOperations.phase, "remote_workspace_snapshot"),
      sql`${workspaceOperations.metadata}->>'boundary' = 'final'`)))[0]!;
    const failed = await snapshotOperation();
    expect(failed).toMatchObject({ status: "failed", exitCode: 1,
      stderrExcerpt: "remote_workspace_operation_failed\n"
        + "remote_workspace_operation_failed: operation=archive_helper transport=sandbox_lease_inactive\n",
      metadata: { lastFailure: { code: "remote_workspace_operation_failed",
        cause: "remote_workspace_operation_failed: operation=archive_helper transport=sandbox_lease_inactive" } } });
    expect(failed.finishedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(failed)).not.toContain("SYNTHETIC");

    // The bounded retry reuses the same boundary operation and records success.
    const saved = await saveRemoteWorkspace({ db, storage: f.storage, workspace: f.workspace, runId: f.runId, lease: f.lease,
      target: f.target, assertOwned: async () => undefined });
    const succeeded = await snapshotOperation();
    expect(succeeded.id).toBe(failed.id);
    expect(succeeded).toMatchObject({ status: "succeeded", metadata: { snapshotId: saved.snapshotId } });
    expect(await readFile(path.join(readRemoteWorkspaceAuthority(f.workspace.metadata)!.location!.remoteCwd, "saved.txt"), "utf8"))
      .toBe("one preserved result\n");
  }, 30_000);
});
