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
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { preserveRemoteWorkspacePreparationFailure } from "./native-runtime/native-workspace-finalization-state.js";
import {
  createSavedWorkspaceLoader, prepareRemoteWorkspace, readRemoteWorkspaceAuthority,
  reserveRemoteWorkspace, saveRemoteWorkspace,
} from "./remote-workspaces.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";

const exec = promisify(execFile);

describe("remote workspace save parent lock order", () => {
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
    const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
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

  it.each([false, true])("preserves immutable task identity while waiting for its lock (foreign company=%s)", async foreignCompany => {
    const f = await preparedFailure();
    const companyId = foreignCompany ? randomUUID() : f.companyId;
    if (foreignCompany) await db.insert(companies).values({ id: companyId, name: "Other owner", issuePrefix: `S${companyId.slice(0, 6)}` });
    const [otherIssue] = await db.insert(issues).values({ companyId, title: "Other task", status: "blocked" }).returning();
    const saveDb = createDb(database.connectionString, { maxConnections: 1, applicationName: "save-order-binding" });
    const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
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
});
