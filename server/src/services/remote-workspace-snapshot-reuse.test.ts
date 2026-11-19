import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, closeRegisteredClients, companies, createDb, environmentLeases, environments,
  executionWorkspaces, executionWorkspaceSnapshots, heartbeatRuns, issueRecoveryActions, issues, workspaceOperations,
} from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { remoteWorkspaceRunReferenceSchema, type EnvironmentLease } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import { remoteWorkspaceSnapshotRetentionService } from "./remote-workspace-snapshot-retention.js";
import { beginWorkspaceSnapshot } from "./remote-workspace-snapshot-storage.js";
import { captureRemoteWorkspaceDirectory } from "./remote-workspace-snapshot-archive.js";
import { immutableRemoteWorkspaceRecoveryAttachment, verifiedWorkspaceRepairReceipt } from "./workspace-recovery-receipt.js";
import { remoteWorkspaceReplacementEvidence } from "./native-runtime/native-safe-replacement.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import {
  createSavedWorkspaceLoader, prepareRemoteWorkspace, readRemoteWorkspaceAuthority, reserveRemoteWorkspace, saveRemoteWorkspace,
} from "./remote-workspaces.js";

const exec = promisify(execFile);
const support = await getEmbeddedPostgresTestSupport();
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(ready => { resolve = ready; });
  return { promise, resolve };
}

describe.skipIf(!support.supported)("captured unchanged workspace snapshots", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("workspace-snapshot-reuse-");
    db = createDb(database.connectionString);
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "workspace-snapshot-reuse-")));
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "64".repeat(32));
    vi.stubEnv("DATABASE_URL", database.connectionString);
  }, 60_000);
  afterAll(async () => {
    if (database) await closeRegisteredClients(database.connectionString);
    await database?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Snapshot reuse", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Save workspace", status: "in_progress", assigneeAgentId: agentId });
    const [environment] = await db.insert(environments).values({ name: issueId, driver: "sandbox" }).returning();
    const storage = { ...createStorageService(createLocalDiskStorageProvider(path.join(root, issueId, "objects"))), provider: "s3" as const };
    const puts = vi.spyOn(storage, "putFile");
    const remoteCwd = path.join(root, issueId, "remote"), providerLeaseId = randomUUID();
    await mkdir(remoteCwd, { recursive: true });
    let captures = 0;
    const transfer: NonNullable<NonNullable<AdapterSandboxExecutionTarget["runner"]>["syncIn"]> = async operations => {
      for (const operation of operations) for (const file of operation.files) {
        await mkdir(path.dirname(file.targetPath), { recursive: true });
        await cp(file.sourcePath, file.targetPath, { recursive: file.kind === "directory" });
      }
      return { operations: operations.map(operation => ({ operationId: operation.operationId,
        filesTransferred: operation.files.length, bytesTransferred: 0 })) };
    };
    const target = (leaseId: string): AdapterSandboxExecutionTarget => ({
      kind: "remote", transport: "sandbox", leaseId, remoteCwd, timeoutMs: 30_000,
      runner: { syncIn: transfer, syncOut: async operations => { captures++; return transfer(operations); }, execute: async input => {
        const result = await exec(input.command, input.args ?? [], { cwd: input.cwd ?? remoteCwd,
          env: { ...process.env, ...input.env }, timeout: input.timeoutMs, maxBuffer: 8 * 1024 * 1024 });
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr, signal: null, timedOut: false,
          pid: process.pid, startedAt: new Date().toISOString() };
      } },
    });
    const writer = async (existingWorkspaceId: string | null) => {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, runtimeMode: "legacy",
        status: "running", contextSnapshot: { issueId } });
      const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId,
        environmentId: environment.id, provider: "daytona", providerLeaseId, status: "active" }).returning();
      const reserved = await reserveRemoteWorkspace({ db, storage, companyId, issueId, runId, agentId,
        environmentId: environment.id, projectId: null, projectWorkspaceId: null, existingWorkspaceId, source: { kind: "empty" } });
      const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId,
        lease: lease as EnvironmentLease, target: target(lease.id) });
      return { runId, lease: prepared.lease, workspaceId: reserved.id, remoteRoot: prepared.remoteRoot };
    };
    const a = await writer(null);
    const workspace = async () => (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, a.workspaceId)))[0]!;
    await writeFile(path.join(a.remoteRoot, "saved.txt"), "saved result\n");
    const savedA = await saveRemoteWorkspace({ db, storage, workspace: await workspace(), runId: a.runId,
      lease: a.lease, target: target(a.lease.id), assertOwned: async () => undefined });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, a.runId));
    const b = await writer(a.workspaceId);
    puts.mockClear();
    const capturesBefore = captures;
    const save = async (boundary?: string) => saveRemoteWorkspace({ db, storage, workspace: await workspace(), runId: b.runId,
      lease: b.lease, target: target(b.lease.id), assertOwned: async () => undefined, boundary });
    const snapshots = () => db.select().from(executionWorkspaceSnapshots).where(and(
      eq(executionWorkspaceSnapshots.companyId, companyId), eq(executionWorkspaceSnapshots.executionWorkspaceId, a.workspaceId)));
    const operations = () => db.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, companyId),
      eq(workspaceOperations.heartbeatRunId, b.runId), eq(workspaceOperations.phase, "remote_workspace_snapshot")));
    return { companyId, agentId, issueId, a, b, storage, puts, savedA, workspace, writer, save, snapshots, operations, target,
      captures: () => captures - capturesBefore };
  }

  async function recoveredReuseFixture() {
    const f = await fixture(), saved = await f.save();
    const run = async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.b.runId)))[0]!;
    const current = await run(), reference = remoteWorkspaceRunReferenceSchema.parse(current.runnerProfileJson?.remoteWorkspace);
    const [originalLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.b.lease.id));
    const [stoppedLease] = await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success",
      metadata: { ...originalLease.metadata, remoteExecutionTermination: remoteTerminationReceipt(originalLease,
        { providerLeaseId: originalLease.providerLeaseId!, state: "stopped" }) } }).where(eq(environmentLeases.id, originalLease.id)).returning();
    await db.update(issues).set({ executionWorkspaceId: f.a.workspaceId }).where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ status: "failed", runtimeMode: "native", nativeIssueId: f.issueId, finishedAt: new Date(),
      runnerProfileJson: { ...current.runnerProfileJson, nativeExecutionInput: { workspace: { cwd: reference.remoteCwd } } } })
      .where(eq(heartbeatRuns.id, f.b.runId));
    const [action] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "stranded_assigned_issue", cause: "fixture", fingerprint: randomUUID(), ownerType: "board",
      nextAction: "Continue recovered work", evidence: { workspaceRecovery: { schema: "paperclip.workspace-recovery.v1",
        runId: f.b.runId, status: "recovered", stage: "saving_receipts", attempt: 1, requestIds: [] } } }).returning();
    const [receipt] = await db.insert(workspaceOperations).values({ companyId: f.companyId, issueId: f.issueId,
      executionWorkspaceId: f.a.workspaceId, heartbeatRunId: f.b.runId, phase: "workspace_recovery", status: "succeeded",
      metadata: { storage: "remote_workspace", recoveryActionId: action.id, leaseId: reference.leaseId,
        providerLeaseId: reference.providerLeaseId, epoch: reference.epoch, snapshotId: saved.snapshotId,
        sha256: saved.sha256, generation: saved.generation } }).returning();
    return { ...f, saved, run, stoppedLease, receipt };
  }

  it("accepts a verified reused archive for recovery and stopped native replacement", async () => {
    const f = await recoveredReuseFixture(), run = await f.run();
    expect(await verifiedWorkspaceRepairReceipt(db, run)).toBe(f.receipt.id);
    expect(await immutableRemoteWorkspaceRecoveryAttachment(db, run)).toMatchObject({ snapshotId: f.savedA.snapshotId,
      operationId: f.receipt.id, generation: f.savedA.generation });
    expect(await remoteWorkspaceReplacementEvidence(db, run, f.issueId, [f.stoppedLease]))
      .toEqual({ workspacePreserved: true, providerStopped: true });
    expect(await db.transaction(tx => remoteWorkspaceReplacementEvidence(tx, run, f.issueId, [f.stoppedLease], true)))
      .toEqual({ workspacePreserved: true, providerStopped: true });
    expect((await f.snapshots()).find(s => s.id === f.savedA.snapshotId)).toMatchObject({ sourceRunId: f.a.runId, epoch: 1 });
  });

  it("keeps an immutable recovery attachment after the next writer advances but refuses old execution authority", async () => {
    const f = await recoveredReuseFixture(), run = await f.run(), next = await f.writer(f.a.workspaceId);
    await writeFile(path.join(next.remoteRoot, "saved.txt"), "next writer contents\n");
    await saveRemoteWorkspace({ db, storage: f.storage, workspace: await f.workspace(), runId: next.runId,
      lease: next.lease, target: f.target(next.lease.id), assertOwned: async () => undefined });
    expect((await f.snapshots()).find(s => s.id === f.savedA.snapshotId)!.status).toBe("superseded");
    expect(await immutableRemoteWorkspaceRecoveryAttachment(db, run)).toMatchObject({ snapshotId: f.savedA.snapshotId });
    expect(await verifiedWorkspaceRepairReceipt(db, run)).toBeNull();
    expect(await remoteWorkspaceReplacementEvidence(db, run, f.issueId, [f.stoppedLease]))
      .toEqual({ workspacePreserved: false, providerStopped: true });
  });

  it.each(["missing_marker", "pending_generation", "journaled_upload", "wrong_epoch", "wrong_lease",
    "unfinished_work", "unknown_work", "wrong_generation", "wrong_boundary", "foreign_run"])(
    "refuses an unverified reuse receipt for all recovery readers: %s", async fault => {
      const f = await recoveredReuseFixture(), run = await f.run();
      const operation = (await f.operations())[0]!, metadata = structuredClone(operation.metadata!);
      const pending = (await f.snapshots()).find(s => s.sourceRunId === f.b.runId)!;
      if (fault === "missing_marker") delete metadata.reusedSnapshotId;
      if (fault === "wrong_epoch") metadata.epoch = Number(metadata.epoch) + 1;
      if (fault === "wrong_generation") metadata.generation = Number(metadata.generation) + 1;
      if (fault === "wrong_boundary") metadata.boundary = "repositories:checkpoint";
      if (fault === "wrong_lease") metadata.exportCleanup = { ...(metadata.exportCleanup as Record<string, unknown>), leaseId: randomUUID() };
      if (fault === "unfinished_work") metadata.saveWork = { ...(metadata.saveWork as Record<string, unknown>), activeIds: [randomUUID()] };
      if (fault === "unknown_work") metadata.saveWork = { ...(metadata.saveWork as Record<string, unknown>), unknown: true };
      await db.update(workspaceOperations).set({ metadata, ...(fault === "foreign_run" ? { heartbeatRunId: f.a.runId } : {}) })
        .where(eq(workspaceOperations.id, operation.id));
      if (fault === "pending_generation") await db.update(executionWorkspaceSnapshots).set({ status: "pending" })
        .where(eq(executionWorkspaceSnapshots.id, pending.id));
      if (fault === "journaled_upload") await db.update(executionWorkspaceSnapshots).set({ metadata: { uploads: [{ objectKey: "owned-uncertain-attempt" }] } })
        .where(eq(executionWorkspaceSnapshots.id, pending.id));
      expect(await verifiedWorkspaceRepairReceipt(db, run)).toBeNull();
      expect(await immutableRemoteWorkspaceRecoveryAttachment(db, run)).toBeNull();
      expect(await remoteWorkspaceReplacementEvidence(db, run, f.issueId, [f.stoppedLease]))
        .toEqual({ workspacePreserved: false, providerStopped: true });
    });

  it.each(["retry", "missing", "forbidden"])("counts real S3 metadata attempts in save statistics: %s", async outcome => {
    const f = await fixture(), parent = (await f.snapshots()).find(s => s.id === f.savedA.snapshotId)!;
    let requests = 0;
    const server = createServer((request, response) => {
      requests++;
      if (request.method !== "HEAD") { response.writeHead(405); response.end(); return; }
      const status = outcome === "missing" ? 404 : outcome === "forbidden" ? 403 : requests === 1 ? 503 : 200;
      response.writeHead(status, status === 200 ? { "content-length": String(parent.byteSize) } : {});
      response.end();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const names = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_MAX_ATTEMPTS", "AWS_EC2_METADATA_DISABLED"];
    const previous = new Map(names.map(name => [name, process.env[name]]));
    process.env.AWS_ACCESS_KEY_ID = "snapshot-reuse-test";
    process.env.AWS_SECRET_ACCESS_KEY = "snapshot-reuse-test-secret";
    process.env.AWS_MAX_ATTEMPTS = "2";
    process.env.AWS_EC2_METADATA_DISABLED = "true";
    for (const name of ["AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_DEFAULT_PROFILE"]) delete process.env[name];
    try {
      const provider = createStorageService(createS3StorageProvider({ bucket: "snapshots", region: "us-east-1",
        endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, forcePathStyle: true }));
      vi.spyOn(f.storage, "headObject").mockImplementation(provider.headObject);
      if (outcome === "forbidden") {
        await expect(f.save()).rejects.toBeDefined();
        expect(f.puts).not.toHaveBeenCalled();
        expect(readRemoteWorkspaceAuthority((await f.workspace()).metadata)).toMatchObject({ dirty: true, writerRunId: f.b.runId });
      } else {
        const saved = await f.save();
        if (outcome === "retry") expect(saved).toMatchObject({ snapshotId: f.savedA.snapshotId, unchanged: true });
        else expect(saved.snapshotId).not.toBe(f.savedA.snapshotId);
      }
      const operation = (await f.operations())[0]!;
      const timing = operation.metadata!.saveTiming as { storage: { requests: { requests: number; attempts: number; failedRequests: number } } };
      expect(timing.storage.requests).toMatchObject({ requests: 1, attempts: outcome === "retry" ? 2 : 1,
        failedRequests: outcome === "retry" ? 0 : 1 });
      expect(requests).toBe(outcome === "retry" ? 2 : 1);
    } finally {
      for (const [name, value] of previous) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("reuses the saved archive after a real capture and records finalization, replay, restore and waiter wake", async () => {
    const f = await fixture(), waiterId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: waiterId, companyId: f.companyId, agentId: f.agentId, issueId: f.issueId,
      status: "scheduled_retry", scheduledRetryReason: "workspace_busy", scheduledRetryAt: new Date(Date.now() + 300_000),
      contextSnapshot: { issueId: f.issueId, workspaceBusyWait: { key: `execution:${f.a.workspaceId}`, holderRunId: f.b.runId,
        waitingSince: new Date().toISOString(), issueExecutionWorkspaceId: f.a.workspaceId, issueProjectWorkspaceId: null } } });
    const saved = await f.save();
    expect(saved).toMatchObject({ snapshotId: f.savedA.snapshotId, generation: f.savedA.generation, unchanged: true });
    expect(f.captures()).toBeGreaterThan(0);
    expect(f.puts).not.toHaveBeenCalled();
    expect(readRemoteWorkspaceAuthority((await f.workspace()).metadata)).toMatchObject({ snapshotId: saved.snapshotId, dirty: false, writerRunId: null });
    expect(await f.operations()).toEqual([expect.objectContaining({ status: "succeeded",
      metadata: expect.objectContaining({ snapshotId: saved.snapshotId, reusedSnapshotId: saved.snapshotId,
        exportCleanup: expect.objectContaining({ state: "cleaned" }), saveWork: expect.objectContaining({ activeIds: [] }) }) })]);
    expect((await f.snapshots()).filter(s => s.sourceRunId === f.b.runId))
      .toEqual([expect.objectContaining({ status: "deleted", objectKey: null, deleteAfter: null })]);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.b.runId));
    expect(run.runnerProfileJson?.remoteWorkspace).toMatchObject({ snapshotId: saved.snapshotId, state: "saved" });
    const [waiter] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, waiterId));
    expect(waiter.scheduledRetryAt!.getTime()).toBeLessThanOrEqual(Date.now());
    const beforeReplay = f.captures();
    await expect(f.save()).resolves.toMatchObject({ snapshotId: saved.snapshotId, unchanged: true });
    expect(f.captures()).toBe(beforeReplay);
    expect(f.puts).not.toHaveBeenCalled();
    const loader = await createSavedWorkspaceLoader(db, f.storage)({ companyId: f.companyId,
      workspaceId: f.a.workspaceId, snapshotId: saved.snapshotId });
    try { expect(await readFile(path.join(loader.root, "saved.txt"), "utf8")).toBe("saved result\n"); }
    finally { await loader.cleanup(); }
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId),
      eq(activityLog.runId, f.b.runId), eq(activityLog.action, "workspace.snapshot_skipped_unchanged")))).toHaveLength(1);
  });

  it("uploads changed contents and leaves their prior version on normal retention", async () => {
    const f = await fixture();
    await writeFile(path.join(f.b.remoteRoot, "saved.txt"), "changed result\n");
    const saved = await f.save();
    expect(saved.snapshotId).not.toBe(f.savedA.snapshotId);
    expect(saved).not.toHaveProperty("unchanged");
    expect(f.puts).toHaveBeenCalledTimes(1);
    const previous = (await f.snapshots()).find(s => s.id === f.savedA.snapshotId)!;
    expect(previous.status).toBe("superseded");
    expect(previous.deleteAfter!.getTime()).toBeGreaterThan(Date.now() + 6 * 86400_000);
  });

  it("reuses intermediate checkpoints without ending the writer, then reuses the final save", async () => {
    const f = await fixture();
    await expect(f.save("repositories:unchanged")).resolves.toMatchObject({ snapshotId: f.savedA.snapshotId, unchanged: true });
    expect(readRemoteWorkspaceAuthority((await f.workspace()).metadata)).toMatchObject({ dirty: true, writerRunId: f.b.runId });
    await expect(f.save()).resolves.toMatchObject({ snapshotId: f.savedA.snapshotId, unchanged: true });
    expect(f.puts).not.toHaveBeenCalled();
    expect(await f.operations()).toHaveLength(2);
  });

  it("stores a fresh archive if the matching parent object is missing", async () => {
    const f = await fixture();
    const parent = (await f.snapshots()).find(s => s.id === f.savedA.snapshotId)!;
    await f.storage.deleteObject(f.companyId, parent.objectKey!);
    const saved = await f.save();
    expect(saved.snapshotId).not.toBe(parent.id);
    expect(f.puts).toHaveBeenCalledTimes(1);
    expect(readRemoteWorkspaceAuthority((await f.workspace()).metadata)).toMatchObject({ dirty: false, writerRunId: null });
  });

  it("requires the wrapped plaintext hash as well as matching manifest metadata", async () => {
    const f = await fixture();
    await writeFile(path.join(f.b.remoteRoot, "saved.txt"), "new content despite stale metadata\n");
    const captured = await captureRemoteWorkspaceDirectory({ cwd: f.b.remoteRoot, archivePath: path.join(root, `${f.issueId}.pcws`) });
    await db.update(executionWorkspaceSnapshots).set({ manifestDigest: captured.manifestDigest })
      .where(eq(executionWorkspaceSnapshots.id, f.savedA.snapshotId));
    const saved = await f.save();
    expect(saved.snapshotId).not.toBe(f.savedA.snapshotId);
    expect(f.puts).toHaveBeenCalledTimes(1);
    const loaded = await createSavedWorkspaceLoader(db, f.storage)({ companyId: f.companyId,
      workspaceId: f.a.workspaceId, snapshotId: saved.snapshotId });
    try { expect(await readFile(path.join(loaded.root, "saved.txt"), "utf8")).toBe("new content despite stale metadata\n"); }
    finally { await loaded.cleanup(); }
  });

  it("does not reuse an archive whose object metadata has the wrong size", async () => {
    const f = await fixture();
    vi.spyOn(f.storage, "headObject").mockResolvedValueOnce({ exists: true, contentLength: 1 });
    expect((await f.save()).snapshotId).not.toBe(f.savedA.snapshotId);
    expect(f.puts).toHaveBeenCalledTimes(1);
  });

  it("does not reuse another company's identical manifest", async () => {
    const f = await fixture(), foreign = await fixture();
    const row = await f.workspace(), authority = readRemoteWorkspaceAuthority(row.metadata)!;
    await db.update(executionWorkspaces).set({ metadata: { ...row.metadata,
      remoteWorkspace: { ...authority, snapshotId: foreign.savedA.snapshotId } } }).where(eq(executionWorkspaces.id, row.id));
    const heads = vi.spyOn(f.storage, "headObject");
    const saved = await f.save();
    expect(saved.snapshotId).not.toBe(foreign.savedA.snapshotId);
    expect(heads).not.toHaveBeenCalled();
    expect(f.puts).toHaveBeenCalledTimes(1);
    expect((await foreign.snapshots()).find(s => s.id === foreign.savedA.snapshotId)!.status).toBe("committed");
  });

  it.each(["epoch", "writer", "location"])("fences a changed %s while the object metadata request is in flight", async changed => {
    const f = await fixture(), head = f.storage.headObject.bind(f.storage);
    let moved = readRemoteWorkspaceAuthority((await f.workspace()).metadata)!;
    vi.spyOn(f.storage, "headObject").mockImplementationOnce(async (...args) => {
      const result = await head(...args), row = await f.workspace(), authority = readRemoteWorkspaceAuthority(row.metadata)!;
      moved = { ...authority, ...(changed === "epoch" ? { epoch: authority.epoch + 1 }
        : changed === "writer" ? { writerRunId: randomUUID() }
        : { location: { ...authority.location!, providerLeaseId: randomUUID() } }) };
      await db.update(executionWorkspaces).set({ metadata: { ...row.metadata, remoteWorkspace: moved } })
        .where(eq(executionWorkspaces.id, row.id));
      return result;
    });
    await expect(f.save()).rejects.toThrow("publication_fenced");
    expect(f.puts).not.toHaveBeenCalled();
    expect(readRemoteWorkspaceAuthority((await f.workspace()).metadata)).toEqual(moved);
    expect((await f.snapshots()).filter(s => s.sourceRunId === f.b.runId)).toEqual([expect.objectContaining({ status: "pending" })]);
  });

  it("preserves a newly journaled upload attempt instead of discarding uncertain producer work", async () => {
    const f = await fixture(), head = f.storage.headObject.bind(f.storage);
    vi.spyOn(f.storage, "headObject").mockImplementationOnce(async (...args) => {
      const result = await head(...args);
      const pending = (await f.snapshots()).find(s => s.sourceRunId === f.b.runId)!;
      await db.update(executionWorkspaceSnapshots).set({ metadata: { uploads: [{ objectKey: `${f.companyId}/pending-owned-attempt` }] } })
        .where(eq(executionWorkspaceSnapshots.id, pending.id));
      return result;
    });
    await expect(f.save()).rejects.toThrow("publication_changed");
    expect(f.puts).not.toHaveBeenCalled();
    expect((await f.snapshots()).find(s => s.sourceRunId === f.b.runId)).toMatchObject({ status: "pending",
      metadata: { uploads: [{ objectKey: `${f.companyId}/pending-owned-attempt` }] } });
    expect(readRemoteWorkspaceAuthority((await f.workspace()).metadata)).toMatchObject({ dirty: true, writerRunId: f.b.runId });
  });

  it("does not hold the workspace lock during a slow storage metadata request", async () => {
    const f = await fixture(), started = deferred(), release = deferred(), head = f.storage.headObject.bind(f.storage);
    vi.spyOn(f.storage, "headObject").mockImplementationOnce(async (...args) => {
      started.resolve(); await release.promise; return head(...args);
    });
    const save = f.save();
    await started.promise;
    try {
      await db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '500ms'`);
        expect(await tx.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.a.workspaceId)).for("update")).toHaveLength(1);
      });
    } finally { release.resolve(); }
    await expect(save).resolves.toMatchObject({ snapshotId: f.savedA.snapshotId, unchanged: true });
  });

  it("keeps concurrent final saves on one durable reused receipt", async () => {
    const f = await fixture(), first = deferred(), both = deferred(), head = f.storage.headObject.bind(f.storage);
    let requests = 0;
    vi.spyOn(f.storage, "headObject").mockImplementation(async (...args) => {
      requests++; first.resolve(); if (requests === 2) both.resolve(); await both.promise; return head(...args);
    });
    const a = f.save(); await first.promise; const b = f.save();
    const saved = await Promise.all([a, b]);
    expect(saved).toEqual([expect.objectContaining({ snapshotId: f.savedA.snapshotId, unchanged: true }),
      expect.objectContaining({ snapshotId: f.savedA.snapshotId, unchanged: true })]);
    expect(f.puts).not.toHaveBeenCalled();
    expect(await f.operations()).toEqual([expect.objectContaining({ status: "succeeded" })]);
    expect((await f.snapshots()).filter(s => s.sourceRunId === f.b.runId)).toHaveLength(1);
  });

  it("reads a peer's completed receipt when its own registered save has not begun its snapshot", async () => {
    const f = await fixture(), headStarted = deferred(), releaseHead = deferred(), beginStarted = deferred(), releaseBegin = deferred();
    const head = f.storage.headObject.bind(f.storage), transaction = db.transaction.bind(db);
    vi.spyOn(f.storage, "headObject").mockImplementationOnce(async (...args) => {
      headStarted.resolve(); await releaseHead.promise; return head(...args);
    });
    const first = f.save();
    await headStarted.promise;
    let transactions = 0;
    const delayed = vi.spyOn(db, "transaction").mockImplementation(async (action, config) => {
      if (++transactions === 2) { beginStarted.resolve(); await releaseBegin.promise; }
      return transaction(action, config);
    });
    const second = f.save();
    try {
      await beginStarted.promise;
      releaseHead.resolve();
      await expect(first).resolves.toMatchObject({ snapshotId: f.savedA.snapshotId, unchanged: true });
      expect((await f.snapshots()).find(s => s.sourceRunId === f.b.runId)!.status).toBe("deleted");
      releaseBegin.resolve();
      await expect(second).resolves.toMatchObject({ snapshotId: f.savedA.snapshotId, unchanged: true });
    } finally {
      releaseHead.resolve(); releaseBegin.resolve();
      await Promise.allSettled([first, second]);
      delayed.mockRestore();
    }
    expect(f.captures()).toBe(1);
    expect(f.puts).not.toHaveBeenCalled();
    expect(await f.operations()).toEqual([expect.objectContaining({ status: "succeeded",
      metadata: expect.objectContaining({ saveWork: expect.objectContaining({ activeIds: [], unknown: false }) }) })]);
  });

  it.each([false, true])("retires a prior save only when its work is known to be settled (unknown=%s)", async unknown => {
    const f = await fixture(), row = await f.workspace(), authority = readRemoteWorkspaceAuthority(row.metadata)!;
    const operationId = randomUUID(), at = new Date();
    await db.insert(workspaceOperations).values({ id: operationId, companyId: f.companyId, executionWorkspaceId: row.id,
      heartbeatRunId: f.b.runId, issueId: f.issueId, phase: "remote_workspace_snapshot", status: "failed",
      metadata: { boundary: "repositories:prior", epoch: authority.epoch, generation: f.savedA.generation + 1,
        lastFailure: { code: "remote_workspace_save_failed", at: at.toISOString() },
        saveWork: { schema: "paperclip.remote-workspace-save-work.v1", activeIds: [], unknown, quiescedAt: at.toISOString() },
        exportCleanup: { ...authority.location, state: "pending" } } });
    await beginWorkspaceSnapshot(db, { companyId: f.companyId, workspaceId: row.id, operationId, runId: f.b.runId,
      parentSnapshotId: f.savedA.snapshotId, generation: f.savedA.generation + 1, epoch: authority.epoch });
    await expect(f.save()).resolves.toMatchObject({ snapshotId: f.savedA.snapshotId, unchanged: true });
    const previous = (await f.operations()).find(o => o.id === operationId)!;
    if (unknown) expect(previous.metadata).not.toHaveProperty("retiredSave");
    else expect(previous.metadata).toMatchObject({ retiredSave: { snapshotId: f.savedA.snapshotId },
      exportCleanup: { state: "cleaned" } });
    expect(f.puts).not.toHaveBeenCalled();
  });

  it("keeps the reused current archive pinned when its old retention deadline passes", async () => {
    const f = await fixture();
    await f.save();
    const future = new Date(Date.now() + 30 * 86400_000);
    await db.update(executionWorkspaceSnapshots).set({ deleteAfter: new Date(0) }).where(eq(executionWorkspaceSnapshots.id, f.savedA.snapshotId));
    const retention = remoteWorkspaceSnapshotRetentionService(db, { storage: f.storage, now: () => future });
    for (let pass = 0; pass < 10; pass++) {
      const result = await retention.tick();
      expect(result.failed).toBe(0);
      if (!result.truncated) break;
      expect(pass).toBeLessThan(9);
    }
    const parent = (await f.snapshots()).find(s => s.id === f.savedA.snapshotId)!;
    expect(parent).toMatchObject({ status: "committed", deleteAfter: null });
    await expect(f.storage.headObject(f.companyId, parent.objectKey!)).resolves.toMatchObject({ exists: true });
  });
});
