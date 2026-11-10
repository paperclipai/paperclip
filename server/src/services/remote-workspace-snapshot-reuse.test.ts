import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, closeRegisteredClients, companies, createDb, environmentLeases, environments,
  executionWorkspaces, executionWorkspaceSnapshots, heartbeatRuns, issues, workspaceOperations,
} from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { EnvironmentLease } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { remoteWorkspaceSnapshotRetentionService } from "./remote-workspace-snapshot-retention.js";
import { beginWorkspaceSnapshot } from "./remote-workspace-snapshot-storage.js";
import { captureRemoteWorkspaceDirectory } from "./remote-workspace-snapshot-archive.js";
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
    return { companyId, agentId, issueId, a, b, storage, puts, savedA, workspace, writer, save, snapshots, operations,
      captures: () => captures - capturesBefore };
  }

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
        await tx.execute((await import("drizzle-orm")).sql`set local lock_timeout = '500ms'`);
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
    await retention.tick();
    const parent = (await f.snapshots()).find(s => s.id === f.savedA.snapshotId)!;
    expect(parent).toMatchObject({ status: "committed", deleteAfter: null });
    await expect(f.storage.headObject(f.companyId, parent.objectKey!)).resolves.toMatchObject({ exists: true });
  });
});
