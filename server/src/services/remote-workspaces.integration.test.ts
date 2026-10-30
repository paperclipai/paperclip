import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { activityLog, agents, applyPendingMigrations, closeRegisteredClients, companies, createDb, environmentLeases, environments,
  executionWorkspaces, executionWorkspaceSnapshots, heartbeatRuns, issues, projects, projectWorkspaces, workspaceOperations } from "@paperclipai/db";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { EnvironmentLease } from "@paperclipai/shared";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import type { StorageService } from "../storage/types.js";
import { createSavedWorkspaceLoader, prepareRemoteWorkspace, readRemoteWorkspaceAuthority,
  reserveRemoteWorkspace, saveRemoteWorkspace, shouldUseRemoteWorkspaces } from "./remote-workspaces.js";
import { createRemoteWorkspaceGitAuth } from "./remote-workspace-git-auth.js";
import type { createGitRemoteAuthProvider } from "./git-credentials.js";

const exec = promisify(execFile);
const databaseUrl = process.env.PAPERCLIP_REMOTE_WORKSPACE_TEST_DATABASE_URL;
if (databaseUrl && !/^remote_workspace_[a-z_]*test$/.test(new URL(databaseUrl).pathname.slice(1))) throw new Error("Disposable workspace database required");
const suite = databaseUrl ? describe : describe.skip;
const s3Bucket = process.env.PAPERCLIP_REMOTE_WORKSPACE_TEST_S3_BUCKET;
if (s3Bucket && !s3Bucket.startsWith("paperclip-workspace-")) throw new Error("Disposable workspace S3 bucket required");

suite("remote workspace lifecycle with real Postgres and independent filesystem execution", () => {
  let db: ReturnType<typeof createDb>, root: string, storage: StorageService;
  let ids: { company: string; agent: string; issue: string; run: string; environment: string; lease: string };
  beforeAll(async () => { await applyPendingMigrations(databaseUrl!); db = createDb(databaseUrl!); }, 120_000);
  afterAll(async () => { await closeRegisteredClients(databaseUrl!); });
  beforeEach(async () => {
    vi.stubEnv("DATABASE_URL", databaseUrl!); vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "62".repeat(32));
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pc-remote-workspace-lifecycle-")));
    storage = s3Bucket ? createStorageService(createS3StorageProvider({ bucket: s3Bucket, region: "us-east-1", prefix: "lifecycle-tests" }))
      : { ...createStorageService(createLocalDiskStorageProvider(path.join(root, "objects"))), provider: "s3" };
    ids = Object.fromEntries(["company", "agent", "issue", "run", "environment", "lease"].map(key => [key, randomUUID()])) as typeof ids;
    await db.insert(companies).values({ id: ids.company, name: "Disposable remote workspace proof", issuePrefix: "RWP" });
    await db.insert(agents).values({ id: ids.agent, companyId: ids.company, name: "Native worker", adapterType: "paperclip_runner" });
    await db.insert(environments).values({ id: ids.environment, name: "Independent filesystem execution", driver: "sandbox", config: {} });
    await db.insert(issues).values({ id: ids.issue, companyId: ids.company, title: "Use a remote workspace", status: "in_progress", assigneeAgentId: ids.agent });
    await db.insert(heartbeatRuns).values({ id: ids.run, companyId: ids.company, agentId: ids.agent, nativeIssueId: ids.issue,
      runtimeMode: "native", status: "running" });
    await db.insert(environmentLeases).values({ id: ids.lease, companyId: ids.company, environmentId: ids.environment,
      heartbeatRunId: ids.run, issueId: ids.issue, provider: "daytona", providerLeaseId: `allocation-${ids.lease}`, status: "active" });
  });
  afterEach(async () => {
    const snapshots = await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.companyId, ids.company));
    for (const row of snapshots) for (const key of new Set([row.objectKey, ...(Array.isArray(row.metadata?.uploads)
      ? (row.metadata.uploads as { objectKey: string }[]).map(item => item.objectKey) : [])].filter((value): value is string => !!value))) {
      await storage.deleteObject(ids.company, key);
    }
    await db.delete(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.companyId, ids.company));
    await db.delete(workspaceOperations).where(eq(workspaceOperations.companyId, ids.company));
    await db.delete(activityLog).where(eq(activityLog.companyId, ids.company));
    await db.delete(environmentLeases).where(eq(environmentLeases.companyId, ids.company));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, ids.company));
    await db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.companyId, ids.company));
    await db.delete(executionWorkspaces).where(eq(executionWorkspaces.companyId, ids.company));
    await db.delete(issues).where(eq(issues.companyId, ids.company));
    await db.delete(projectWorkspaces).where(eq(projectWorkspaces.companyId, ids.company));
    await db.delete(projects).where(eq(projects.companyId, ids.company));
    await db.delete(agents).where(eq(agents.companyId, ids.company));
    await db.delete(companies).where(eq(companies.id, ids.company));
    await db.delete(environments).where(eq(environments.id, ids.environment));
    await fs.rm(root, { recursive: true, force: true }); vi.unstubAllEnvs();
  });
  async function target(name: string): Promise<AdapterExecutionTarget> {
    const remoteCwd = path.join(root, name); await fs.mkdir(remoteCwd);
    const runner: CommandManagedRuntimeRunner = {
      execute: async input => {
        try {
          const result = await exec(input.command, input.args ?? [], { cwd: input.cwd ?? remoteCwd,
            env: { ...process.env, ...input.env }, timeout: input.timeoutMs, maxBuffer: 4 * 1024 * 1024 });
          return { exitCode: 0, stdout: result.stdout, stderr: result.stderr, timedOut: false, signal: null, pid: process.pid, startedAt: new Date().toISOString() };
        } catch (error) { const failed = error as { code?: number; stdout?: string; stderr?: string };
          return { exitCode: typeof failed.code === "number" ? failed.code : 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", timedOut: false, signal: null, pid: process.pid, startedAt: new Date().toISOString() }; }
      },
      syncIn: async operations => transfer(operations), syncOut: async operations => transfer(operations),
    };
    return { kind: "remote", transport: "sandbox", remoteCwd, runner, provider: "daytona", leaseId: ids.lease,
      sandboxId: `allocation-${ids.lease}`, timeoutMs: 300_000 } as AdapterExecutionTarget;
  }
  async function transfer(operations: Parameters<NonNullable<CommandManagedRuntimeRunner["syncIn"]>>[0]) {
    const results = [];
    for (const operation of operations) {
      let bytes = 0;
      for (const file of operation.files) {
        await fs.mkdir(path.dirname(file.targetPath), { recursive: true });
        await fs.cp(file.sourcePath, file.targetPath, { recursive: file.kind === "directory" });
        if (file.kind === "file") bytes += (await fs.stat(file.targetPath)).size;
      }
      results.push({ operationId: operation.operationId, filesTransferred: operation.files.length, bytesTransferred: bytes });
    }
    return { operations: results };
  }
  const lease = async () => (await db.select().from(environmentLeases).where(eq(environmentLeases.id, ids.lease)))[0]! as EnvironmentLease;
  const workspace = async (id: string) => (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, id)))[0]!;
  const reserve = (source: Parameters<typeof reserveRemoteWorkspace>[0]["source"]) => reserveRemoteWorkspace({ db, storage,
    companyId: ids.company, issueId: ids.issue, runId: ids.run, agentId: ids.agent, environmentId: ids.environment,
    projectId: null, projectWorkspaceId: null, existingWorkspaceId: null, source });

  it("prepares, saves and restores task files without a controller checkout or original allocation", async () => {
    const reserved = await reserve({ kind: "empty" }), first = await target("sandbox-A");
    const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: ids.run, lease: await lease(), target: first });
    expect(readRemoteWorkspaceAuthority(prepared.workspace.metadata)?.snapshotId).toBeTruthy();
    expect(await fs.readdir(path.join(prepared.remoteRoot, ".paperclip-runtime", "workspace-snapshots"))).toEqual([]);
    await fs.writeFile(path.join(prepared.remoteRoot, "report.md"), "useful saved result\n");
    await fs.mkdir(path.join(prepared.remoteRoot, "empty-folder"));
    await fs.writeFile(path.join(prepared.remoteRoot, "binary.bin"), Buffer.from([0, 1, 255]));
    const saved = await saveRemoteWorkspace({ db, storage, workspace: prepared.workspace, runId: ids.run,
      lease: prepared.lease, target: first, assertOwned: async () => undefined });
    const current = await workspace(reserved.id);
    expect(readRemoteWorkspaceAuthority(current.metadata)).toMatchObject({ dirty: false, writerRunId: null, snapshotId: saved.snapshotId });
    await fs.rm(path.dirname(prepared.remoteRoot), { recursive: true, force: true });
    const second = await target("sandbox-B");
    const nextRun = randomUUID(), nextLease = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextRun, companyId: ids.company, agentId: ids.agent, nativeIssueId: ids.issue, runtimeMode: "native", status: "running" });
    await db.insert(environmentLeases).values({ id: nextLease, companyId: ids.company, environmentId: ids.environment,
      heartbeatRunId: nextRun, issueId: ids.issue, provider: "daytona", providerLeaseId: `allocation-${nextLease}`, status: "active" });
    const reservedAgain = await reserveRemoteWorkspace({ db, storage, companyId: ids.company, issueId: ids.issue, runId: nextRun,
      agentId: ids.agent, environmentId: ids.environment, projectId: null, projectWorkspaceId: null, existingWorkspaceId: reserved.id, source: { kind: "empty" } });
    const newLease = (await db.select().from(environmentLeases).where(eq(environmentLeases.id, nextLease)))[0]! as EnvironmentLease;
    const restored = await prepareRemoteWorkspace({ db, storage, workspace: reservedAgain, runId: nextRun, lease: newLease, target: second });
    expect(await fs.readFile(path.join(restored.remoteRoot, "report.md"), "utf8")).toBe("useful saved result\n");
    expect(await fs.readFile(path.join(restored.remoteRoot, "binary.bin"))).toEqual(Buffer.from([0, 1, 255]));
    expect((await fs.stat(path.join(restored.remoteRoot, "empty-folder"))).isDirectory()).toBe(true);
    const browse = await createSavedWorkspaceLoader(db, storage)({ companyId: ids.company, workspaceId: reserved.id, snapshotId: saved.snapshotId });
    try { expect(await fs.readFile(path.join(browse.root, "report.md"), "utf8")).toContain("useful saved result"); } finally { await browse.cleanup(); }
  }, 60_000);

  it("reconnects to the same live folder without replaying preparation or overwriting unsaved edits", async () => {
    const reserved = await reserve({ kind: "empty" }), first = await target("same-sandbox");
    const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: ids.run, lease: await lease(), target: first });
    await fs.writeFile(path.join(prepared.remoteRoot, "in-flight.txt"), "still running");
    const before = await workspace(reserved.id);
    const reattached = await prepareRemoteWorkspace({ db, storage, workspace: before, runId: ids.run, lease: await lease(), target: first,
      provisionCommand: "exit 99" });
    expect(reattached.remoteRoot).toBe(prepared.remoteRoot);
    expect(await fs.readFile(path.join(reattached.remoteRoot, "in-flight.txt"), "utf8")).toBe("still running");
    expect((await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.companyId, ids.company))).length).toBe(1);
  }, 60_000);

  it("fences stale same-run preparation from replacing a dirty workspace allocation or lease", async () => {
    const reserved = await reserve({ kind: "empty" }), first = await target("dirty-owner");
    const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: ids.run,
      lease: await lease(), target: first, assertOwned: async () => undefined });
    await fs.writeFile(path.join(prepared.remoteRoot, "unsaved.txt"), "only the first allocation has this work\n");
    const originalAuthority = readRemoteWorkspaceAuthority((await workspace(reserved.id)).metadata)!;
    for (const sameAllocation of [false, true]) {
      const leaseId = randomUUID();
      const providerLeaseId = sameAllocation ? prepared.lease.providerLeaseId! : `allocation-${leaseId}`;
      await db.insert(environmentLeases).values({ id: leaseId, companyId: ids.company, environmentId: ids.environment,
        heartbeatRunId: ids.run, issueId: ids.issue, provider: "daytona", providerLeaseId, status: "active" });
      const replacementLease = (await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId)))[0]! as EnvironmentLease;
      const replacement = sameAllocation ? first : await target("stale-replacement");
      await expect(prepareRemoteWorkspace({ db, storage, workspace: sameAllocation ? await workspace(reserved.id) : reserved, runId: ids.run,
        lease: replacementLease, target: replacement, assertOwned: async () => undefined }))
        .rejects.toThrow("remote_workspace_authority_changed");
      expect(readRemoteWorkspaceAuthority((await workspace(reserved.id)).metadata)).toEqual(originalAuthority);
      expect(await fs.readFile(path.join(prepared.remoteRoot, "unsaved.txt"), "utf8"))
        .toBe("only the first allocation has this work\n");
    }
  }, 60_000);

  it("publishes a cold restored workspace despite lost cleanup replies and retries cleanup without overwriting later edits", async () => {
    const reserved = await reserve({ kind: "empty" }), first = await target("restore-cleanup-source");
    const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: ids.run,
      lease: await lease(), target: first });
    await fs.writeFile(path.join(prepared.remoteRoot, "saved.txt"), "saved before the original allocation was lost\n");
    const saved = await saveRemoteWorkspace({ db, storage, workspace: prepared.workspace, runId: ids.run,
      lease: prepared.lease, target: first, assertOwned: async () => undefined });
    await fs.rm(path.dirname(prepared.remoteRoot), { recursive: true, force: true });
    const nextRun = randomUUID(), nextLease = randomUUID(), providerLeaseId = `allocation-${nextLease}`;
    await db.insert(heartbeatRuns).values({ id: nextRun, companyId: ids.company, agentId: ids.agent,
      nativeIssueId: ids.issue, runtimeMode: "native", status: "running" });
    await db.insert(environmentLeases).values({ id: nextLease, companyId: ids.company, environmentId: ids.environment,
      heartbeatRunId: nextRun, issueId: ids.issue, provider: "daytona", providerLeaseId, status: "active" });
    const nextWorkspace = await reserveRemoteWorkspace({ db, storage, companyId: ids.company, issueId: ids.issue,
      runId: nextRun, agentId: ids.agent, environmentId: ids.environment, projectId: null, projectWorkspaceId: null,
      existingWorkspaceId: reserved.id, source: { kind: "empty" } });
    const nextTarget = await target("restore-cleanup-destination");
    const sandbox = nextTarget as Extract<AdapterExecutionTarget, { transport: "sandbox" }>;
    const expectedRemoteRoot = path.join(sandbox.remoteCwd, ".paperclip-workspaces", reserved.id);
    const execute = sandbox.runner!.execute.bind(sandbox.runner!);
    let failCleanup = true, cleanupAttempts = 0;
    sandbox.runner!.execute = async input => {
      const result = await execute(input);
      if (input.args?.[1]?.includes("remote_workspace_export_cleanup_failed") && result.exitCode === 0) {
        cleanupAttempts++;
        if (failCleanup) throw new Error("lost restore cleanup reply");
      }
      return result;
    };
    const nextLeaseRow = (await db.select().from(environmentLeases).where(eq(environmentLeases.id, nextLease)))[0]! as EnvironmentLease;
    const restored = await prepareRemoteWorkspace({ db, storage, workspace: nextWorkspace, runId: nextRun,
      lease: nextLeaseRow, target: nextTarget, assertOwned: async () => undefined });
    expect(restored.remoteRoot).toBe(expectedRemoteRoot);
    const location = { environmentId: ids.environment, leaseId: nextLease, providerLeaseId, remoteCwd: restored.remoteRoot };
    expect(cleanupAttempts).toBeGreaterThan(0);
    expect(readRemoteWorkspaceAuthority((await workspace(reserved.id)).metadata)).toMatchObject({
      location, snapshotId: saved.snapshotId, writerRunId: nextRun, dirty: true,
    });
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, nextLease)))[0]?.metadata?.remoteCwd).toBe(restored.remoteRoot);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, nextRun)))[0]?.runnerProfileJson?.remoteWorkspace)
      .toMatchObject({ workspaceId: reserved.id, leaseId: nextLease, providerLeaseId,
        remoteCwd: restored.remoteRoot, state: "prepared", snapshotId: saved.snapshotId });
    expect(await fs.readFile(path.join(restored.remoteRoot, "saved.txt"), "utf8"))
      .toBe("saved before the original allocation was lost\n");
    const [operation] = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, ids.company),
      eq(workspaceOperations.heartbeatRunId, nextRun), eq(workspaceOperations.phase, "remote_workspace_restore")));
    expect(operation).toMatchObject({ status: "succeeded", metadata: { exportCleanup: { ...location, state: "pending" } } });
    await fs.writeFile(path.join(restored.remoteRoot, "saved.txt"), "later agent edits\n");
    await fs.writeFile(path.join(restored.remoteRoot, "newer.txt"), "keep untracked work\n");
    failCleanup = false;
    const transfer = vi.spyOn(sandbox.runner!, "syncIn");
    const upload = vi.spyOn(storage, "putFile");
    await prepareRemoteWorkspace({ db, storage, workspace: await workspace(reserved.id), runId: nextRun,
      lease: restored.lease, target: nextTarget, assertOwned: async () => undefined });
    expect((await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, operation!.id)))[0])
      .toMatchObject({ status: "succeeded", metadata: { exportCleanup: { ...location, state: "cleaned" } } });
    expect(await fs.readFile(path.join(restored.remoteRoot, "saved.txt"), "utf8")).toBe("later agent edits\n");
    expect(await fs.readFile(path.join(restored.remoteRoot, "newer.txt"), "utf8")).toBe("keep untracked work\n");
    expect(transfer).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  }, 60_000);

  it("reuses one saved shared workspace across separate tasks while fencing a second writer", async () => {
    const projectId = randomUUID(), sourceId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: ids.company, name: "Synthetic shared project" });
    await db.insert(projectWorkspaces).values({ id: sourceId, companyId: ids.company, projectId,
      name: "Shared files", sourceType: "empty", sharedWorkspaceKey: "synthetic-shared" });
    await db.update(issues).set({ projectId, projectWorkspaceId: sourceId }).where(eq(issues.id, ids.issue));
    const input = { db, storage, companyId: ids.company, issueId: ids.issue, runId: ids.run,
      agentId: ids.agent, environmentId: ids.environment, projectId, projectWorkspaceId: sourceId,
      existingWorkspaceId: null, source: { kind: "empty" as const }, mode: "shared_workspace" };
    const first = await target("shared-sandbox"), reserved = await reserveRemoteWorkspace(input);
    const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: ids.run,
      lease: await lease(), target: first });
    await fs.writeFile(path.join(prepared.remoteRoot, "shared-result.txt"), "from the first task\n");
    const secondIssue = randomUUID(), secondRun = randomUUID(), secondLease = randomUUID();
    await db.insert(issues).values({ id: secondIssue, companyId: ids.company, projectId, projectWorkspaceId: sourceId,
      title: "Continue shared work", status: "in_progress", assigneeAgentId: ids.agent });
    await db.insert(heartbeatRuns).values({ id: secondRun, companyId: ids.company, agentId: ids.agent,
      nativeIssueId: secondIssue, runtimeMode: "native", status: "running" });
    const next = { ...input, issueId: secondIssue, runId: secondRun };
    await expect(reserveRemoteWorkspace(next)).rejects.toThrow("unfinished writer");
    await saveRemoteWorkspace({ db, storage, workspace: prepared.workspace, runId: ids.run,
      lease: prepared.lease, target: first, assertOwned: async () => undefined });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, ids.run));
    const reused = await reserveRemoteWorkspace(next);
    expect(reused.id).toBe(reserved.id);
    expect(readRemoteWorkspaceAuthority(reused.metadata)).toMatchObject({ epoch: 2, writerRunId: secondRun });
    await db.insert(environmentLeases).values({ id: secondLease, companyId: ids.company, environmentId: ids.environment,
      heartbeatRunId: secondRun, issueId: secondIssue, provider: "daytona", providerLeaseId: `allocation-${ids.lease}`, status: "active" });
    const newLease = (await db.select().from(environmentLeases).where(eq(environmentLeases.id, secondLease)))[0]! as EnvironmentLease;
    const continued = await prepareRemoteWorkspace({ db, storage, workspace: reused, runId: secondRun, lease: newLease, target: first });
    expect(await fs.readFile(path.join(continued.remoteRoot, "shared-result.txt"), "utf8")).toBe("from the first task\n");
    await saveRemoteWorkspace({ db, storage, workspace: continued.workspace, runId: secondRun,
      lease: continued.lease, target: first, assertOwned: async () => undefined });
    const [operation] = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.heartbeatRunId, secondRun),
      eq(workspaceOperations.phase, "remote_workspace_snapshot")));
    expect(operation?.issueId).toBe(secondIssue);
  }, 60_000);

  it("retains the writer and previous snapshot when object storage fails", async () => {
    const reserved = await reserve({ kind: "empty" }), first = await target("outage-sandbox");
    const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: ids.run, lease: await lease(), target: first });
    await fs.writeFile(path.join(prepared.remoteRoot, "unpublished.txt"), "retain this source");
    const failing: StorageService = { ...storage, putFile: async () => { throw new Error("storage offline"); } };
    await expect(saveRemoteWorkspace({ db, storage: failing, workspace: prepared.workspace, runId: ids.run,
      lease: prepared.lease, target: first, assertOwned: async () => undefined })).rejects.toThrow("storage offline");
    expect(readRemoteWorkspaceAuthority((await workspace(reserved.id)).metadata)).toMatchObject({ dirty: true, writerRunId: ids.run,
      snapshotId: readRemoteWorkspaceAuthority(prepared.workspace.metadata)!.snapshotId });
    expect((await fs.readdir(path.join(prepared.remoteRoot, ".paperclip-runtime", "workspace-snapshots"))).length).toBe(1);
    const saved = await saveRemoteWorkspace({ db, storage, workspace: await workspace(reserved.id), runId: ids.run,
      lease: prepared.lease, target: first, assertOwned: async () => undefined });
    expect(saved.generation).toBe(2);
    expect(await fs.readdir(path.join(prepared.remoteRoot, ".paperclip-runtime", "workspace-snapshots"))).toEqual([]);
  }, 60_000);

  it("records and retries export cleanup after a lost reply without another upload", async () => {
    const reserved = await reserve({ kind: "empty" }), first = await target("cleanup-sandbox");
    const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: ids.run, lease: await lease(), target: first });
    await fs.writeFile(path.join(prepared.remoteRoot, "saved.txt"), "keep working files\n");
    const sandbox = first as Extract<AdapterExecutionTarget, { transport: "sandbox" }>;
    const execute = sandbox.runner!.execute.bind(sandbox.runner!);
    let lost = false;
    sandbox.runner!.execute = async input => {
      const result = await execute(input);
      if (!lost && input.args?.[1]?.includes("remote_workspace_export_cleanup_failed") && result.exitCode === 0) {
        lost = true; throw new Error("lost cleanup reply");
      }
      return result;
    };
    const upload = vi.spyOn(storage, "putFile");
    const input = { db, storage, workspace: prepared.workspace, runId: ids.run, lease: prepared.lease,
      target: first, assertOwned: async () => undefined };
    const saved = await saveRemoteWorkspace(input);
    const [before] = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.heartbeatRunId, ids.run),
      eq(workspaceOperations.phase, "remote_workspace_snapshot"), eq(workspaceOperations.status, "succeeded"),
      eq(workspaceOperations.id, (await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, saved.snapshotId)))[0]!.sourceOperationId)));
    expect(before?.metadata?.exportCleanup).toMatchObject({ state: "pending", lastError: "remote_workspace_export_cleanup_failed" });
    expect(await saveRemoteWorkspace(input)).toMatchObject({ snapshotId: saved.snapshotId, generation: saved.generation });
    expect(upload).toHaveBeenCalledOnce();
    const [after] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, before!.id));
    expect(after?.metadata?.exportCleanup).toMatchObject({ state: "cleaned", lastError: null });
    expect(await fs.readFile(path.join(prepared.remoteRoot, "saved.txt"), "utf8")).toBe("keep working files\n");
  }, 60_000);

  it("replays an acknowledged preparation save after a newer boundary without recapture", async () => {
    const reserved = await reserve({ kind: "empty" }), first = await target("boundary-sandbox");
    const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: ids.run, lease: await lease(), target: first });
    const input = { db, storage, workspace: prepared.workspace, runId: ids.run, lease: prepared.lease,
      target: first, assertOwned: async () => undefined };
    const older = await saveRemoteWorkspace({ ...input, boundary: "repository:one" });
    await fs.writeFile(path.join(prepared.remoteRoot, "later.txt"), "later acknowledged work\n");
    const newer = await saveRemoteWorkspace({ ...input, boundary: "repository:two" });
    const upload = vi.spyOn(storage, "putFile");
    expect(await saveRemoteWorkspace({ ...input, boundary: "repository:one" })).toMatchObject({ snapshotId: older.snapshotId });
    expect(upload).not.toHaveBeenCalled();
    expect(readRemoteWorkspaceAuthority((await workspace(reserved.id)).metadata)?.snapshotId).toBe(newer.snapshotId);
  }, 60_000);

  it("retains an uncertain provisioning command and never replays its external effect", async () => {
    const reserved = await reserve({ kind: "empty" }), first = await target("provision-sandbox");
    const sandbox = first as Extract<AdapterExecutionTarget, { transport: "sandbox" }>;
    const execute = sandbox.runner!.execute.bind(sandbox.runner!);
    let commandCalls = 0;
    sandbox.runner!.execute = async input => {
      const result = await execute(input);
      if (input.command === "bash") { commandCalls++; throw new Error("lost provisioning reply"); }
      return result;
    };
    const input = { db, storage, workspace: reserved, runId: ids.run, lease: await lease(), target: first,
      provisionCommand: "printf 'one effect\\n' >> setup-result.txt" };
    await expect(prepareRemoteWorkspace(input)).rejects.toThrow("lost provisioning reply");
    const retained = await workspace(reserved.id), authority = readRemoteWorkspaceAuthority(retained.metadata)!;
    expect(authority).toMatchObject({ dirty: true, writerRunId: ids.run, snapshotId: null });
    expect(authority.location).toBeTruthy();
    await expect(prepareRemoteWorkspace({ ...input, workspace: retained, lease: await lease() })).rejects.toThrow("remote_workspace_provision_unverified");
    expect(commandCalls).toBe(1);
    expect(await fs.readFile(path.join(authority.location!.remoteCwd, "setup-result.txt"), "utf8")).toBe("one effect\n");
    const [journal] = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, ids.company), eq(workspaceOperations.phase, "remote_workspace_provision")));
    expect(journal).toMatchObject({ status: "running", metadata: { uncertain: true } });
  }, 60_000);

  it("preserves enrolled workspaces after disabling enrollment and rejects a legacy writer", async () => {
    const reserved = await reserve({ kind: "empty" });
    expect(shouldUseRemoteWorkspaces({ adapterType: "paperclip_runner", environmentDriver: "sandbox", experimentalEnabled: false, existingWorkspace: reserved })).toBe(true);
    expect(() => shouldUseRemoteWorkspaces({ adapterType: "codex_local", environmentDriver: "sandbox", experimentalEnabled: false, existingWorkspace: reserved })).toThrow("native sandbox");
  });

  it("selects Git credentials with the current run's agent, responsible user, and task", async () => {
    await db.update(heartbeatRuns).set({ responsibleUserId: "synthetic-current-user" }).where(eq(heartbeatRuns.id, ids.run));
    const contexts: unknown[] = [];
    const create = ((_db, companyId, context) => {
      expect(companyId).toBe(ids.company); contexts.push(context); return async () => null;
    }) as typeof createGitRemoteAuthProvider;
    await createRemoteWorkspaceGitAuth(db, ids.company, ids.run, create);
    expect(contexts).toEqual([{ issueId: ids.issue, heartbeatRunId: ids.run, agentId: ids.agent,
      responsibleUserId: "synthetic-current-user" }]);
    await expect(createRemoteWorkspaceGitAuth(db, randomUUID(), ids.run, create)).rejects.toThrow("remote_workspace_git_run_unavailable");
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, ids.run));
    await expect(createRemoteWorkspaceGitAuth(db, ids.company, ids.run, create)).rejects.toThrow("remote_workspace_git_run_unavailable");
    expect(contexts).toHaveLength(1);
  });

  it("reclaims an unused reservation after allocation failed without granting a second live writer", async () => {
    const reserved = await reserve({ kind: "empty" });
    const nextRun = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextRun, companyId: ids.company, agentId: ids.agent, nativeIssueId: ids.issue,
      runtimeMode: "native", status: "running" });
    const input = { db, storage, companyId: ids.company, issueId: ids.issue, runId: nextRun, agentId: ids.agent,
      environmentId: ids.environment, projectId: null, projectWorkspaceId: null, existingWorkspaceId: reserved.id, source: { kind: "empty" as const } };
    await expect(reserveRemoteWorkspace(input)).rejects.toThrow("unfinished writer");
    await db.delete(environmentLeases).where(eq(environmentLeases.id, ids.lease));
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, ids.run));
    const reclaimed = await reserveRemoteWorkspace(input);
    expect(readRemoteWorkspaceAuthority(reclaimed.metadata)).toMatchObject({ writerRunId: nextRun, epoch: 2, dirty: false, location: null });
  });

  it("rejects publication after writer ownership changes, retaining the uploaded recovery obligation", async () => {
    const reserved = await reserve({ kind: "empty" }), first = await target("stale-writer");
    const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: ids.run, lease: await lease(), target: first });
    await fs.writeFile(path.join(prepared.remoteRoot, "work.txt"), "must not overwrite a newer owner");
    let calls = 0;
    await expect(saveRemoteWorkspace({ db, storage, workspace: prepared.workspace, runId: ids.run, lease: prepared.lease, target: first,
      assertOwned: async () => {
        if (++calls !== 3) return;
        const row = await workspace(reserved.id), authority = readRemoteWorkspaceAuthority(row.metadata)!;
        await db.update(executionWorkspaces).set({ metadata: { ...row.metadata, remoteWorkspace: { ...authority, epoch: authority.epoch + 1 } } })
          .where(eq(executionWorkspaces.id, row.id));
      } })).rejects.toThrow("remote_workspace_publication_fenced");
    const current = readRemoteWorkspaceAuthority((await workspace(reserved.id)).metadata)!;
    expect(current.snapshotId).toBe(readRemoteWorkspaceAuthority(prepared.workspace.metadata)!.snapshotId);
    expect(current.dirty).toBe(true);
    const snapshots = await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.companyId, ids.company));
    expect(snapshots.map(snapshot => snapshot.status).sort()).toEqual(["committed", "uploaded"]);
  }, 60_000);

  it("saves dirty and unpushed Git work and restores it without contacting the original source", async () => {
    const origin = path.join(root, "source-repository"); await fs.mkdir(origin);
    const git = (cwd: string, ...args: string[]) => exec("git", ["-C", cwd, "-c", "user.name=Synthetic test", "-c", "user.email=test@example.invalid", ...args]);
    await git(origin, "init", "--initial-branch=main");
    await fs.writeFile(path.join(origin, "code.txt"), "original\n"); await git(origin, "add", "."); await git(origin, "commit", "-m", "Synthetic baseline");
    const reserved = await reserve({ kind: "git", repoUrl: origin, ref: "HEAD", branchName: "task-work" }), first = await target("git-sandbox");
    const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: ids.run, lease: await lease(), target: first });
    await fs.writeFile(path.join(prepared.remoteRoot, "code.txt"), "unpushed commit\n");
    await git(prepared.remoteRoot, "add", "."); await git(prepared.remoteRoot, "commit", "-m", "Synthetic unpushed work");
    const head = (await git(prepared.remoteRoot, "rev-parse", "HEAD")).stdout.trim();
    await fs.writeFile(path.join(prepared.remoteRoot, "code.txt"), "staged edit\n"); await git(prepared.remoteRoot, "add", "code.txt");
    await fs.writeFile(path.join(prepared.remoteRoot, "code.txt"), "unstaged edit\n");
    await fs.writeFile(path.join(prepared.remoteRoot, "untracked.txt"), "untracked work\n");
    const status = (await git(prepared.remoteRoot, "status", "--porcelain")).stdout;
    const saved = await saveRemoteWorkspace({ db, storage, workspace: prepared.workspace, runId: ids.run, lease: prepared.lease,
      target: first, assertOwned: async () => undefined });
    await fs.rm(origin, { recursive: true, force: true }); await fs.rm(prepared.remoteRoot, { recursive: true, force: true });
    const recovered = await createSavedWorkspaceLoader(db, storage)({ companyId: ids.company, workspaceId: reserved.id, snapshotId: saved.snapshotId });
    try {
      expect((await git(recovered.root, "rev-parse", "HEAD")).stdout.trim()).toBe(head);
      expect((await git(recovered.root, "status", "--porcelain")).stdout).toBe(status);
      expect((await git(recovered.root, "show", ":code.txt")).stdout).toBe("staged edit\n");
      expect(await fs.readFile(path.join(recovered.root, "code.txt"), "utf8")).toBe("unstaged edit\n");
    } finally { await recovered.cleanup(); }
  }, 60_000);
});
