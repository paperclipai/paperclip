import { parseNativeExecutionInput } from "../vendor/paperclip-runner/index.js";
import { readNativeWorkspaceMigration, migratedNativeExecutionCwd, canRestoreMigratedNativeSession } from "./native-runtime/native-workspace-migration.js";
import { buildNativeHarnessBackupManifest, verifyNativeHarnessBackup } from "./native-runtime/native-session-executor.js";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { activityLog, agents, agentTaskSessions, agentWakeupRequests, applyPendingMigrations, closeRegisteredClients, companies, createDb, environmentLeases, environments,
  executionWorkspaces, executionWorkspaceSnapshots, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issues, livenessDb, nativeRunFinalizations, projects, projectWorkspaces, workspaceOperations } from "@paperclipai/db";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { buildProjectMentionHref, type Environment, type EnvironmentLease } from "@paperclipai/shared";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import type { StorageService } from "../storage/types.js";
import { createSavedWorkspaceLoader, prepareRemoteWorkspace, readRemoteWorkspaceAuthority,
  clearRemoteWorkspaceLocationForReleasedLease, createRemoteWorkspaceGitAuth, prepareRemoteWorkspaceRepository,
  reserveRemoteWorkspace, saveRemoteWorkspace, shouldUseRemoteWorkspaces } from "./remote-workspaces.js";
import type { createGitRemoteAuthProvider } from "./git-credentials.js";
import { reconcileSafeNativeReplacements } from "./native-runtime/native-safe-replacement.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { RemoteWorkspaceRestoreError } from "./remote-workspace-transport.js";
import { notFound } from "../errors.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { createRemoteWorkspaceFiles } from "./remote-workspace-files.js";
import { workspaceFileResourceService } from "./workspace-file-resources.js";
import { nativeWorkspaceExportPendingForLease, preserveRemoteWorkspacePreparationFailure } from "./native-runtime/native-workspace-finalization-state.js";
import { preserveOrphanedNativeWorkspace } from "./native-runtime/native-failed-workspace-recovery.js";
import { terminalizeLegacyExecution } from "./legacy-execution-recovery.js";
import { environmentRuntimeService } from "./environment-runtime.js";
import { legacyControllerClaim, renewLegacyControllerLease } from "./legacy-controller-lease.js";
import { migrateRemoteWorkspace } from "./remote-workspace-migration.js";
import { registerRemoteWorkspaceSnapshotRetentionWork, remoteWorkspaceSnapshotRetentionService } from "./remote-workspace-snapshot-retention.js";
import { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { issueService } from "./issues.js";
import { instanceSettingsService } from "./instance-settings.js";
import { resolveRemoteWorkspaceSource } from "./heartbeat/remote-workspace-source.js";
import { toExecutionWorkspace } from "./execution-workspaces.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../__tests__/helpers/recovery-postgres.js";

const exec = promisify(execFile);
let databaseUrl = process.env.PAPERCLIP_REMOTE_WORKSPACE_TEST_DATABASE_URL;
if (databaseUrl && !/^remote_workspace_[a-z_]*test$/.test(new URL(databaseUrl).pathname.slice(1))) throw new Error("Disposable workspace database required");
const suite = databaseUrl || recoveryPostgresSupport.supported ? describe : describe.skip;
const s3Bucket = process.env.PAPERCLIP_REMOTE_WORKSPACE_TEST_S3_BUCKET;
if (s3Bucket && !s3Bucket.startsWith("paperclip-workspace-")) throw new Error("Disposable workspace S3 bucket required");

suite("remote workspace lifecycle with real Postgres and independent filesystem execution", () => {
  let db: ReturnType<typeof createDb>, root: string, storage: StorageService;
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>> | undefined;
  let ids: { company: string; agent: string; issue: string; run: string; environment: string; lease: string };
  beforeAll(async () => {
    if (!databaseUrl) {
      temporary = await startRecoveryPostgres("remote-workspace-lifecycle-");
      databaseUrl = temporary.connectionString;
    }
    await applyPendingMigrations(databaseUrl); db = createDb(databaseUrl);
  }, 120_000);
  afterAll(async () => {
    try { if (databaseUrl) await closeRegisteredClients(databaseUrl); }
    finally { await temporary?.cleanup(); }
  });
  beforeEach(async () => {
    vi.stubEnv("DATABASE_URL", databaseUrl!); vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "62".repeat(32));
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pc-remote-workspace-lifecycle-")));
    storage = s3Bucket ? createStorageService(createS3StorageProvider({ bucket: s3Bucket, region: "us-east-1", prefix: "lifecycle-tests" }))
      : { ...createStorageService(createLocalDiskStorageProvider(path.join(root, "objects"))), provider: "s3" };
    ids = Object.fromEntries(["company", "agent", "issue", "run", "environment", "lease"].map(key => [key, randomUUID()])) as typeof ids;
    await db.insert(companies).values({ id: ids.company, name: "Disposable remote workspace proof", issuePrefix: "RWP" });
    await db.insert(agents).values({ id: ids.agent, companyId: ids.company, name: "Native worker", adapterType: "paperclip_runner" });
    await db.insert(environments).values({ id: ids.environment, name: `Independent filesystem execution ${ids.environment}`, driver: "sandbox", config: {} });
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
    await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.companyId, ids.company));
    await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, ids.company));
    await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.companyId, ids.company));
    await db.delete(agentTaskSessions).where(eq(agentTaskSessions.companyId, ids.company));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.companyId, ids.company));
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, ids.company));
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
  async function target(name: string): Promise<Extract<AdapterExecutionTarget, { transport: "sandbox" }>> {
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
      sandboxId: `allocation-${ids.lease}`, timeoutMs: 300_000 } as Extract<AdapterExecutionTarget, { transport: "sandbox" }>;
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

  it("keeps a fresh preparation timeout eligible for bounded bootstrap recovery", async () => {
    const reserved = await reserve({ kind: "empty" }), remote = await target("timed-out-bootstrap");
    const execute = vi.spyOn(remote.runner!, "execute").mockResolvedValueOnce({
      exitCode: null, timedOut: true, stdout: "untrusted command output", stderr: "untrusted command output", signal: null,
      pid: null, startedAt: new Date().toISOString(),
    });
    await expect(prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: ids.run, lease: await lease(), target: remote }))
      .rejects.toMatchObject({ code: "remote_workspace_prepare_timeout" });
    expect(execute).toHaveBeenCalledOnce();
    expect(readRemoteWorkspaceAuthority((await workspace(reserved.id)).metadata)).toMatchObject({
      writerRunId: ids.run, location: null, snapshotId: null, dirty: false,
    });
    expect(await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.companyId, ids.company))).toHaveLength(0);
  });

  it.each(["dirty", "owner_changed"] as const)("does not grant bootstrap replay after the workspace becomes %s", async state => {
    const reserved = await reserve({ kind: "empty" }), remote = await target(`changed-${state}`);
    await fs.writeFile(path.join(remote.remoteCwd, "saved.txt"), "retain existing work\n");
    const authority = readRemoteWorkspaceAuthority(reserved.metadata)!;
    vi.spyOn(remote.runner!, "execute").mockImplementationOnce(async () => {
      await db.update(executionWorkspaces).set({ metadata: { ...reserved.metadata, remoteWorkspace: {
        ...authority, ...(state === "dirty" ? { dirty: true } : { epoch: authority.epoch + 1, writerRunId: randomUUID() }),
      } } }).where(eq(executionWorkspaces.id, reserved.id));
      return { exitCode: null, timedOut: true, stdout: "", stderr: "", signal: null, pid: null, startedAt: new Date().toISOString() };
    });
    await expect(prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: ids.run, lease: await lease(), target: remote }))
      .rejects.toMatchObject({ name: "RemoteWorkspaceOperationTimeoutError" });
    expect(await fs.readFile(path.join(remote.remoteCwd, "saved.txt"), "utf8")).toBe("retain existing work\n");
  });

  async function releaseBootstrapLease(receipt: boolean) {
    const pluginId = randomUUID();
    await db.update(environmentLeases).set({ metadata: { driver: "sandbox", pluginId, provider: "daytona",
      sandboxProviderPlugin: true } }).where(eq(environmentLeases.id, ids.lease));
    const runtime = environmentRuntimeService(db, { pluginWorkerManager: {
      isRunning: () => true,
      getWorker: () => ({ supportedMethods: ["environmentReleaseLease"] }),
      call: async (_id: string, method: string) => {
        expect(method).toBe("environmentReleaseLease");
        return receipt ? { providerLeaseId: `allocation-${ids.lease}`, state: "stopped" } : undefined;
      },
    } as never });
    await runtime.releaseRunLeases(ids.run, "failed");
    expect(await lease()).toMatchObject({ status: "failed", cleanupStatus: "success" });
    expect(Boolean((await lease()).metadata?.remoteExecutionTermination)).toBe(receipt);
  }

  it.each([["receipt", "fresh"], ["void", "fresh"], ["receipt", "reused"]] as const)(
    "continues unpublished preparation after %s cleanup on a %s allocation and retains the resulting work", async (cleanup, allocation) => {
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", nativeIssueId: null, issueId: ids.issue })
      .where(eq(heartbeatRuns.id, ids.run));
    const reserved = await reserve({ kind: "empty" }), first = await target("lost-bootstrap-reply");
    const interrupted = allocation === "reused";
    const actual = first.runner!.execute.bind(first.runner!);
    const execute = vi.spyOn(first.runner!, "execute").mockImplementationOnce(async input => {
      const result = await actual(input);
      expect(result.exitCode).toBe(0);
      return { ...result, timedOut: !interrupted };
    });
    let ownershipChecks = 0;
    const preparation = prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: ids.run, lease: await lease(), target: first,
      assertOwned: async () => { if (interrupted && ++ownershipChecks === 2) throw new Error("lease_released_before_terminal"); } });
    if (interrupted) await expect(preparation).rejects.toThrow("lease_released_before_terminal");
    else await expect(preparation).rejects.toMatchObject({ code: "remote_workspace_prepare_timeout" });
    const oldRoot = execute.mock.calls[0][0].args?.[2];
    if (!oldRoot) throw new Error("Preparation did not record its directory");
    const oldReceipt = await fs.readFile(path.join(oldRoot, ".paperclip-runtime", "workspace-ready.json"), "utf8");
    const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ids.run));
    await terminalizeLegacyExecution({ db, run: failed!, status: interrupted ? "interrupted" : "failed", patch: {
      errorCode: interrupted ? "lease_released_before_terminal" : "remote_workspace_prepare_timeout",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    } });
    await releaseBootstrapLease(cleanup === "receipt");
    const continueOn = async (name: string) => {
      const runId = randomUUID(), leaseId = randomUUID();
      const reused = allocation === "reused" && name === "fresh-bootstrap-retry";
      const providerLeaseId = reused ? `allocation-${ids.lease}` : `allocation-${leaseId}`;
      await db.insert(heartbeatRuns).values({ id: runId, companyId: ids.company, agentId: ids.agent,
        nativeIssueId: ids.issue, runtimeMode: "native", status: "running" });
      const [nextLease] = await db.insert(environmentLeases).values({ id: leaseId, companyId: ids.company,
        environmentId: ids.environment, heartbeatRunId: runId, issueId: ids.issue, provider: "daytona",
        providerLeaseId, status: "active" }).returning();
      const next = await reserveRemoteWorkspace({ db, storage, companyId: ids.company, issueId: ids.issue,
        runId, agentId: ids.agent, environmentId: ids.environment, projectId: null, projectWorkspaceId: null,
        existingWorkspaceId: reserved.id, source: { kind: "empty" } });
      const remote = reused ? { ...first, leaseId, sandboxId: providerLeaseId,
        runner: { ...first.runner!, execute: actual } } : await target(name);
      return prepareRemoteWorkspace({ db, storage, workspace: next, runId, lease: nextLease as EnvironmentLease,
        target: remote }).then(prepared => ({ runId, prepared, remote }));
    };
    const { runId, prepared, remote } = await continueOn("fresh-bootstrap-retry");
    expect(prepared.remoteRoot).not.toBe(oldRoot);
    await fs.writeFile(path.join(prepared.remoteRoot, "report.md"), "useful recovered result\n");
    const { snapshotId } = await saveRemoteWorkspace({ db, storage, workspace: prepared.workspace, runId,
      lease: prepared.lease, target: remote, assertOwned: async () => undefined });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    await fs.rm(prepared.remoteRoot, { recursive: true });
    const restored = await continueOn("cold-bootstrap-continuation");
    expect(await fs.readFile(path.join(restored.prepared.remoteRoot, "report.md"), "utf8")).toBe("useful recovered result\n");
    expect(restored.prepared.reference.snapshotId).not.toBeNull();
    expect(snapshotId).toBeTruthy();
    expect(execute).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(oldRoot, ".paperclip-runtime", "workspace-ready.json"), "utf8")).toBe(oldReceipt);
  }, 60_000);

  it.each(["unclassified", "provider_started", "retained_native", "runner_identity", "native_mode", "saved", "published", "dirty", "cleanup_failed", "active_lease"] as const)(
    "keeps receiptless workspace handoff blocked for %s", async state => {
      const reserved = await reserve({ kind: "empty" });
      let savedAuthority: ReturnType<typeof readRemoteWorkspaceAuthority> = null;
      let remoteRoot: string | undefined;
      if (state === "saved" || state === "published") {
        const remote = await target(`preserved-${state}`);
        const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: ids.run, lease: await lease(), target: remote });
        remoteRoot = prepared.remoteRoot;
        await fs.writeFile(path.join(remoteRoot, "saved.txt"), "keep prior files\n");
        await saveRemoteWorkspace({ db, storage, workspace: prepared.workspace, runId: ids.run,
          lease: prepared.lease, target: remote, boundary: "initial", assertOwned: async () => undefined });
        savedAuthority = readRemoteWorkspaceAuthority((await workspace(reserved.id)).metadata);
      }
      await db.update(heartbeatRuns).set({ status: "failed", runtimeMode: state === "native_mode" ? "native" : "legacy", finishedAt: new Date(),
        errorCode: state === "unclassified" ? "setup_failed" : "remote_workspace_prepare_timeout",
        nativeSessionId: state === "retained_native" ? randomUUID() : null,
        runnerInstanceId: state === "runner_identity" ? randomUUID() : null,
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: state === "provider_started" } },
      }).where(eq(heartbeatRuns.id, ids.run));
      if (state !== "active_lease") await releaseBootstrapLease(false);
      if (state === "cleanup_failed") await db.update(environmentLeases).set({ cleanupStatus: "failed" }).where(eq(environmentLeases.id, ids.lease));
      if (savedAuthority) await db.update(executionWorkspaces).set({ metadata: { ...reserved.metadata,
        remoteWorkspace: { ...savedAuthority, dirty: false, snapshotId: state === "published" ? null : savedAuthority.snapshotId },
      } }).where(eq(executionWorkspaces.id, reserved.id));
      if (state === "dirty") await db.update(executionWorkspaces).set({ metadata: { ...reserved.metadata,
        remoteWorkspace: { ...readRemoteWorkspaceAuthority(reserved.metadata)!, dirty: true },
      } }).where(eq(executionWorkspaces.id, reserved.id));
      const nextRun = randomUUID();
      await db.insert(heartbeatRuns).values({ id: nextRun, companyId: ids.company, agentId: ids.agent,
        nativeIssueId: ids.issue, runtimeMode: "native", status: "running" });
      await expect(reserveRemoteWorkspace({ db, storage, companyId: ids.company, issueId: ids.issue,
        runId: nextRun, agentId: ids.agent, environmentId: ids.environment, projectId: null, projectWorkspaceId: null,
        existingWorkspaceId: reserved.id, source: { kind: "empty" } })).rejects.toThrow("unfinished writer");
      expect(readRemoteWorkspaceAuthority((await workspace(reserved.id)).metadata)?.writerRunId).toBe(ids.run);
      if (remoteRoot) expect(await fs.readFile(path.join(remoteRoot, "saved.txt"), "utf8")).toBe("keep prior files\n");
    });

  it.each(["initial", "follow-up"] as const)("edits and cold-restores both an anchor and a referenced project's task copy (%s attachment)", async attachment => {
    vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC", "true");
    vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC_REMOTE", "true");
    const origins = path.join(root, "origins"); await fs.mkdir(origins);
    const git = (cwd: string, ...args: string[]) => exec("git", ["-C", cwd,
      "-c", "user.name=Task copies", "-c", "user.email=copies@example.invalid", ...args]);
    for (const name of ["main", "skills"]) {
      const directory = path.join(origins, name); await fs.mkdir(directory);
      await git(directory, "init", "--initial-branch=main");
      await fs.writeFile(path.join(directory, "README.md"), `${name} source\n`);
      await git(directory, "add", "."); await git(directory, "commit", "-m", "Source");
      if (name === "skills") {
        await git(directory, "checkout", "-b", "release");
        await fs.writeFile(path.join(directory, "README.md"), "skills release\n");
        await git(directory, "add", "."); await git(directory, "commit", "-m", "Release");
        await git(directory, "checkout", "main");
      }
    }
    const port = await new Promise<number>((resolve, reject) => {
      const listener = net.createServer(); listener.on("error", reject);
      listener.listen(0, "127.0.0.1", () => {
        const port = (listener.address() as net.AddressInfo).port;
        listener.close(error => error ? reject(error) : resolve(port));
      });
    });
    const daemon = spawn("git", ["daemon", "--reuseaddr", "--export-all", `--base-path=${origins}`,
      "--listen=127.0.0.1", `--port=${port}`, "--verbose", origins], { stdio: ["ignore", "ignore", "pipe"] });
    try {
      await new Promise<void>((resolve, reject) => {
        daemon.once("error", reject); daemon.once("exit", code => reject(new Error(`Git source exited: ${code}`)));
        daemon.stderr.on("data", bytes => { if (String(bytes).includes("Ready to rumble")) resolve(); });
      });
      const [anchor, reference] = await db.insert(projects).values(["Main", "Skills"].map(name => ({ companyId: ids.company, name }))).returning();
      const [anchorSource] = await db.insert(projectWorkspaces).values([
        { companyId: ids.company, projectId: anchor.id, name: "Main", repoUrl: `git://127.0.0.1:${port}/main`, sourceType: "git_repo" },
        { companyId: ids.company, projectId: reference.id, name: "Skills", repoUrl: `git://127.0.0.1:${port}/skills`, defaultRef: "release", sourceType: "git_repo" },
      ]).returning();
      await db.update(issues).set({ projectId: anchor.id, projectWorkspaceId: anchorSource.id,
        description: attachment === "initial" ? `Edit both projects, including [@Skills](${buildProjectMentionHref(reference.id)}).`
          : "Start in the main project." }).where(eq(issues.id, ids.issue));
      const input = { companyId: ids.company, issueId: ids.issue, agentId: ids.agent, runId: ids.run,
        responsibleUserId: null, projectId: anchor.id, projectWorkspaceId: anchorSource.id };
      const resolved = await resolveRemoteWorkspaceSource(db, input);
      if (resolved.authority !== "remote") throw new Error("Expected remote task copies");
      const reserved = await reserveRemoteWorkspace({ db, storage, ...input, environmentId: ids.environment,
        existingWorkspaceId: null, source: resolved.source });
      const first = await target("project-copies-A");
      const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: ids.run, lease: await lease(), target: first });
      const initialCopy = resolved.source.repositories?.[0];
      if (attachment === "initial") {
        expect(initialCopy?.projectId).toBe(reference.id); expect(initialCopy?.readOnly).not.toBe(true);
        expect(await fs.readFile(path.join(prepared.remoteRoot, initialCopy!.relativePath, "README.md"), "utf8")).toBe("skills release\n");
      }
      for (const relative of ["", ...(initialCopy ? [initialCopy.relativePath] : [])]) {
        await fs.writeFile(path.join(prepared.remoteRoot, relative, "result.md"), "saved edits\n");
      }
      for (const name of ["main", "skills"]) {
        await expect(fs.access(path.join(origins, name, "result.md"))).rejects.toMatchObject({ code: "ENOENT" });
      }
      await saveRemoteWorkspace({ db, storage, workspace: prepared.workspace, runId: ids.run,
        lease: prepared.lease, target: first, assertOwned: async () => undefined });
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, ids.run));
      await fs.rm(path.dirname(prepared.remoteRoot), { recursive: true });
      await fs.rm(path.join(origins, "main"), { recursive: true });
      if (attachment === "initial") await fs.rm(path.join(origins, "skills"), { recursive: true });
      else await db.update(issues).set({ description: `Now edit [@Skills](${buildProjectMentionHref(reference.id)}).` }).where(eq(issues.id, ids.issue));
      const nextRun = randomUUID(), nextLeaseId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: nextRun, companyId: ids.company, agentId: ids.agent,
        nativeIssueId: ids.issue, runtimeMode: "native", status: "running" });
      const [nextLease] = await db.insert(environmentLeases).values({ id: nextLeaseId, companyId: ids.company,
        environmentId: ids.environment, heartbeatRunId: nextRun, issueId: ids.issue,
        provider: "daytona", providerLeaseId: `allocation-${nextLeaseId}`, status: "active" }).returning();
      const resumed = await resolveRemoteWorkspaceSource(db, { ...input, runId: nextRun,
        existingWorkspace: toExecutionWorkspace(await workspace(reserved.id)) });
      if (resumed.authority !== "remote") throw new Error("Expected retained remote task copies");
      if (attachment === "initial") expect(resumed.source).toEqual(resolved.source);
      const copy = resumed.source.repositories![0]!;
      expect(copy.projectId).toBe(reference.id);
      const reservedAgain = await reserveRemoteWorkspace({ db, storage, ...input, runId: nextRun,
        environmentId: ids.environment, existingWorkspaceId: reserved.id, source: resumed.source });
      const second = await target("project-copies-B");
      const restored = await prepareRemoteWorkspace({ db, storage, workspace: reservedAgain, runId: nextRun,
        lease: nextLease as EnvironmentLease, target: second });
      for (const relative of ["", copy.relativePath]) {
        if (!relative || attachment === "initial") expect(await fs.readFile(path.join(restored.remoteRoot, relative, "result.md"), "utf8")).toBe("saved edits\n");
        await fs.writeFile(path.join(restored.remoteRoot, relative, "follow-up.md"), "continued edits\n");
      }
      expect(await fs.readFile(path.join(restored.remoteRoot, copy.relativePath, "README.md"), "utf8")).toBe("skills release\n");
      await saveRemoteWorkspace({ db, storage, workspace: restored.workspace, runId: nextRun,
        lease: restored.lease, target: second, assertOwned: async () => undefined });
      const final = await workspace(reserved.id), authority = readRemoteWorkspaceAuthority(final.metadata)!;
      expect(authority).toMatchObject({ dirty: false, writerRunId: null });
      expect(final.metadata?.remoteWorkspaceSnapshotRepositories).toEqual({ snapshotId: authority.snapshotId, repositories: resumed.source.repositories });
      await fs.rm(origins, { recursive: true, force: true });
      const saved = await createSavedWorkspaceLoader(db, storage)({ companyId: ids.company, workspaceId: reserved.id, snapshotId: authority.snapshotId! });
      try {
        for (const relative of ["", copy.relativePath]) expect(await fs.readFile(path.join(saved.root, relative, "follow-up.md"), "utf8")).toBe("continued edits\n");
        expect(await fs.readFile(path.join(saved.root, copy.relativePath, "README.md"), "utf8")).toBe("skills release\n");
      } finally { await saved.cleanup(); }
    } finally {
      if (daemon.exitCode === null) {
        const stopped = new Promise<void>(resolve => daemon.once("exit", () => resolve()));
        daemon.kill("SIGTERM"); await stopped;
      }
    }
  }, 60_000);

  it.each(["same root", "different root", "destroyed allocation", "occupied root", "missing object", "transient restore"] as const)(
    "preserves the published workspace path and files on a cold restore (%s)", async mode => {
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
    if (mode === "destroyed allocation") {
      const destroyed: EnvironmentLease = { ...prepared.lease, status: "released", releasedAt: new Date(), cleanupStatus: "success",
        metadata: { ...prepared.lease.metadata, remoteExecutionTermination: remoteTerminationReceipt(prepared.lease,
          { providerLeaseId: prepared.lease.providerLeaseId, state: "destroyed" }) } };
      await db.transaction(tx => clearRemoteWorkspaceLocationForReleasedLease({ db: tx, lease: destroyed }));
      expect(readRemoteWorkspaceAuthority((await workspace(reserved.id)).metadata)?.location).toBeNull();
    }
    await fs.rm(path.join(root, "sandbox-A"), { recursive: true, force: true });
    const second = await target(mode === "different root" ? "sandbox-B" : "sandbox-A");
    const expectedRemoteRoot = path.join(second.remoteCwd, ".paperclip-workspaces", path.basename(prepared.remoteRoot));
    const nextRun = randomUUID(), nextLease = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextRun, companyId: ids.company, agentId: ids.agent, nativeIssueId: ids.issue, runtimeMode: "native", status: "running" });
    await db.insert(environmentLeases).values({ id: nextLease, companyId: ids.company, environmentId: ids.environment,
      heartbeatRunId: nextRun, issueId: ids.issue, provider: "daytona", providerLeaseId: `allocation-${nextLease}`, status: "active" });
    const reservedAgain = await reserveRemoteWorkspace({ db, storage, companyId: ids.company, issueId: ids.issue, runId: nextRun,
      agentId: ids.agent, environmentId: ids.environment, projectId: null, projectWorkspaceId: null, existingWorkspaceId: reserved.id, source: { kind: "empty" } });
    const newLease = (await db.select().from(environmentLeases).where(eq(environmentLeases.id, nextLease)))[0]! as EnvironmentLease;
    if (mode === "occupied root") {
      await fs.mkdir(expectedRemoteRoot, { recursive: true });
      await fs.writeFile(path.join(expectedRemoteRoot, "unpublished.txt"), "preserve unknown preparation\n");
      const occupied = await prepareRemoteWorkspace({ db, storage, workspace: reservedAgain, runId: nextRun, lease: newLease, target: second })
        .then(() => null, (error: unknown) => error as RemoteWorkspaceRestoreError);
      // The restore names its step and the occupied folder; it is not retried.
      expect(occupied).toBeInstanceOf(RemoteWorkspaceRestoreError);
      expect(occupied).toMatchObject({ step: "sandbox_restore", retryable: false, message: "remote_workspace_restore_failed: step=sandbox_restore; "
        + "remote_workspace_operation_failed: operation=restore exit=1; remote_workspace_restore_failed: stage=inspect_root reason=occupied_root" });
      expect(await fs.readFile(path.join(expectedRemoteRoot, "unpublished.txt"), "utf8")).toBe("preserve unknown preparation\n");
      expect(readRemoteWorkspaceAuthority((await workspace(reserved.id)).metadata))
        .toEqual(readRemoteWorkspaceAuthority(reservedAgain.metadata));
      await fs.rename(expectedRemoteRoot, path.join(root, "retained-unknown-preparation"));
    }
    if (mode === "transient restore") {
      // An unnamed sandbox failure (an I/O error) is retryable; the retry restores the saved files.
      const run = second.runner!.execute.bind(second.runner);
      vi.spyOn(second.runner!, "execute").mockImplementation(async command => command.args?.[1]?.includes("remote_workspace_restore_failed")
        ? { exitCode: 1, stdout: "", stderr: "remote_workspace_restore_failed: stage=extract code=EIO exit=1", timedOut: false, signal: null,
          pid: process.pid, startedAt: new Date().toISOString() } : run(command));
      const transient = await prepareRemoteWorkspace({ db, storage, workspace: reservedAgain, runId: nextRun, lease: newLease, target: second })
        .then(() => null, (error: unknown) => error as RemoteWorkspaceRestoreError);
      expect(transient).toMatchObject({ step: "sandbox_restore", retryable: true, message: "remote_workspace_restore_failed: step=sandbox_restore; "
        + "remote_workspace_operation_failed: operation=restore exit=1; remote_workspace_restore_failed: stage=extract code=EIO exit=1" });
      expect(await fs.lstat(expectedRemoteRoot).catch(() => null)).toBeNull();
      vi.mocked(second.runner!.execute).mockRestore();
    }
    if (mode === "missing object") {
      // Storage reports a lost saved object as 404; retrying cannot bring it back.
      const lost: StorageService = { ...storage, getObject: async () => { throw notFound("Object not found"); } };
      const missing = await prepareRemoteWorkspace({ db, storage: lost, workspace: reservedAgain, runId: nextRun, lease: newLease, target: second })
        .then(() => null, (error: unknown) => error as RemoteWorkspaceRestoreError);
      expect(missing).toBeInstanceOf(RemoteWorkspaceRestoreError);
      expect(missing).toMatchObject({ step: "snapshot_download", retryable: false,
        message: "remote_workspace_restore_failed: step=snapshot_download; remote_workspace_snapshot_object_missing" });
      expect(await fs.lstat(expectedRemoteRoot).catch(() => null)).toBeNull();
    }
    const restored = await prepareRemoteWorkspace({ db, storage, workspace: reservedAgain, runId: nextRun, lease: newLease, target: second });
    expect(restored.remoteRoot).toBe(expectedRemoteRoot);
    if (mode !== "different root") expect(restored.remoteRoot).toBe(prepared.remoteRoot);
    expect(await fs.readFile(path.join(restored.remoteRoot, "report.md"), "utf8")).toBe("useful saved result\n");
    expect(await fs.readFile(path.join(restored.remoteRoot, "binary.bin"))).toEqual(Buffer.from([0, 1, 255]));
    expect((await fs.stat(path.join(restored.remoteRoot, "empty-folder"))).isDirectory()).toBe(true);
    const browse = await createSavedWorkspaceLoader(db, storage)({ companyId: ids.company, workspaceId: reserved.id, snapshotId: saved.snapshotId });
    try { expect(await fs.readFile(path.join(browse.root, "report.md"), "utf8")).toContain("useful saved result"); } finally { await browse.cleanup(); }
  }, 60_000);

  it.each(["per_turn", "warm", "occupied", "foreign-target", "foreign-allocation", "forged-receipt"])("preserves retained native workspace identity through migration: %s", async scenario => {
    const original = path.join(root, "old-controller", "workspace"); await fs.mkdir(original, { recursive: true });
    await fs.writeFile(path.join(original, "saved.txt"), "retained work");
    const remote = await target("legacy-provider-root");
    const [local] = await db.insert(executionWorkspaces).values({ companyId: ids.company, sourceIssueId: ids.issue,
      mode: "isolated_workspace", strategyType: "project_primary", providerType: "local_fs", name: "Retained session",
      cwd: original, providerRef: original }).returning();
    const sessionId = randomUUID(), runnerInstanceId = randomUUID();
    const execution = parseNativeExecutionInput({ schema: "paperclip.native-execution-input.v1",
      provider: { kind: "codex", model: null }, binding: { companyId: ids.company, agentId: ids.agent,
        issueId: ids.issue, runId: ids.run, executionWorkspaceId: local.id },
      task: { identifier: "RWP-1", title: "Retained work", description: null, prompt: "Continue.", workMode: "standard" },
      workspace: { cwd: original, repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: sessionId, driverKind: "codex_app_server", protocolVersion: 1,
        lifecyclePolicy: { mode: scenario === "warm" ? "warm" : "per_turn", idleTimeoutMs: scenario === "warm" ? 120000 : null } },
      completionContract: { id: randomUUID(), sha256: "fixture", schemaVersion: "paperclip.completion-contract.v1",
        contract: { revision: "1", objective: "Continue", criteria: [{ id: "objective", requirement: "Save work." }] } },
      credentialBindings: [], interactionResponses: [],
    });
    if (execution.schema !== "paperclip.native-execution-input.v1") throw new Error("Unexpected fixture schema");
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), nativeSessionId: sessionId,
      runnerInstanceId, runnerProfileJson: { nativeExecutionInput: execution, sessionCheckpoint: { sessionId }, nativeWorkspaceSync: {
        schema: "paperclip.native-workspace-sync/v3", state: "finalized", descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64),
        finalHostSha256: "c".repeat(64), workspaceId: local.id, leaseId: ids.lease, providerLeaseId: `allocation-${ids.lease}`,
        remoteCwd: remote.remoteCwd, resourceDisposition: "destroy",
      } } }).where(eq(heartbeatRuns.id, ids.run));
    await db.insert(agentTaskSessions).values({ companyId: ids.company, agentId: ids.agent, adapterType: "paperclip_runner",
      taskKey: ids.issue, lastRunId: ids.run });
    await db.update(issues).set({ executionWorkspaceId: local.id }).where(eq(issues.id, ids.issue));
    const backupRoot = path.join(root, "private-state"), current = path.join(backupRoot, "failover-backups", "current");
    await fs.mkdir(path.join(current, "runner"), { recursive: true }); await fs.mkdir(path.join(current, "codex-home"));
    await fs.writeFile(path.join(current, "runner", "state.json"), "unchanged opaque provider state");
    await fs.writeFile(path.join(current, "manifest.json"), JSON.stringify(buildNativeHarnessBackupManifest({ backupRoot: current,
      execution, runnerInstanceId, sourceProviderLeaseId: "retained-allocation", providerSessionIdentity: {
        providerSessionId: "retained-thread", providerBackendSessionId: "retained-backend", providerSessionIdentity: null } })));
    expect(verifyNativeHarnessBackup({ root: backupRoot, execution, runnerInstanceId })).not.toBeNull();
    await migrateRemoteWorkspace({ db, storage, companyId: ids.company, workspaceId: local.id, source: { kind: "empty" }, apply: true });
    const migrated = await workspace(local.id);
    const receipt = await readNativeWorkspaceMigration(db, migrated);
    expect(receipt?.remoteCwd).toBe(remote.remoteCwd);
    const continuation = { companyId: ids.company, workspaceId: local.id, agentId: ids.agent, issueId: ids.issue, sessionId, logicalCwd: original, remoteCwd: remote.remoteCwd };
    expect(await canRestoreMigratedNativeSession(db, continuation)).toBe(true);
    expect(await canRestoreMigratedNativeSession(db, { ...continuation, sessionId: randomUUID() })).toBe(false);
    expect(await canRestoreMigratedNativeSession(db, { ...continuation, remoteCwd: "/foreign" })).toBe(false);
    expect(migratedNativeExecutionCwd(receipt, { agentId: ids.agent, issueId: ids.issue, sessionId })).toBe(original);
    expect(migratedNativeExecutionCwd(receipt, { agentId: randomUUID(), issueId: ids.issue, sessionId })).toBeNull();
    await fs.rm(path.join(root, "old-controller"), { recursive: true });
    ids.run = randomUUID();
    await db.insert(heartbeatRuns).values({ id: ids.run, companyId: ids.company, agentId: ids.agent, nativeIssueId: ids.issue, runtimeMode: "native", status: "running" });
    await db.update(environmentLeases).set({ heartbeatRunId: ids.run }).where(eq(environmentLeases.id, ids.lease));
    const reserved = await reserveRemoteWorkspace({ db, storage, companyId: ids.company, issueId: ids.issue, runId: ids.run,
      agentId: ids.agent, environmentId: ids.environment, existingWorkspaceId: local.id, projectId: null, projectWorkspaceId: null, source: { kind: "empty" } });
    const preparation = { db, storage, workspace: reserved, runId: ids.run, lease: await lease(), target: remote };
    const allocationPath = ".paperclip-runtime/reusable-sandbox-lease.json";
    const allocationBytes = JSON.stringify({ version: 1, token: "owned-allocation", companyId: ids.company,
      environmentId: ids.environment, agentId: ids.agent, executionWorkspaceId: local.id, provider: "daytona" });
    await fs.mkdir(path.join(remote.remoteCwd, ".paperclip-runtime"));
    await fs.writeFile(path.join(remote.remoteCwd, allocationPath), allocationBytes);
    preparation.lease.metadata = { ...preparation.lease.metadata, workspaceAllocationFiles: {
      providerLeaseId: preparation.lease.providerLeaseId, remoteCwd: remote.remoteCwd,
      files: [{ relativePath: allocationPath, sha256: createHash("sha256").update(allocationBytes).digest("hex") }],
    } };

    if (scenario === "forged-receipt") {
      await db.update(executionWorkspaces).set({ metadata: { ...reserved.metadata,
        nativeWorkspaceMigration: { schema: "paperclip.native-workspace-migration.v1", operationId: randomUUID() } } }).where(eq(executionWorkspaces.id, local.id));
      await expect(prepareRemoteWorkspace(preparation)).rejects.toThrow("native_workspace_migration_receipt_invalid"); return;
    }
    if (scenario === "occupied") {
      await fs.writeFile(path.join(remote.remoteCwd, "unrelated.txt"), "do not overwrite");
      await expect(prepareRemoteWorkspace(preparation)).rejects.toThrow();
      expect(await fs.readFile(path.join(remote.remoteCwd, "unrelated.txt"), "utf8")).toBe("do not overwrite"); return;
    }
    if (scenario === "foreign-allocation") {
      const receipt = preparation.lease.metadata.workspaceAllocationFiles as { providerLeaseId: string };
      receipt.providerLeaseId = "another-allocation";
      await expect(prepareRemoteWorkspace(preparation)).rejects.toThrow("remote_workspace_allocation_receipt_invalid");
      expect(await fs.readFile(path.join(remote.remoteCwd, allocationPath), "utf8")).toBe(allocationBytes); return;
    }
    if (scenario === "foreign-target") {
      remote.remoteCwd = path.join(root, "different-provider-root");
      await expect(prepareRemoteWorkspace(preparation)).rejects.toThrow("native_workspace_migration_target_changed"); return;
    }
    const prepared = await prepareRemoteWorkspace(preparation);
    expect(prepared.remoteRoot).toBe(remote.remoteCwd);
    expect(await fs.readFile(path.join(prepared.remoteRoot, allocationPath), "utf8")).toBe(allocationBytes);
    expect(await fs.readFile(path.join(prepared.remoteRoot, "saved.txt"), "utf8")).toBe("retained work");
    const successor = { ...execution, workspace: { ...execution.workspace,
      cwd: migratedNativeExecutionCwd(receipt, { agentId: ids.agent, issueId: ids.issue, sessionId }) ?? prepared.remoteRoot } };
    expect(verifyNativeHarnessBackup({ root: backupRoot, execution: successor, runnerInstanceId })).not.toBeNull();
    expect(verifyNativeHarnessBackup({ root: backupRoot, execution: { ...successor, workspace: { ...successor.workspace,
      cwd: prepared.remoteRoot } }, runnerInstanceId })).toBeNull();
    expect(await fs.readFile(path.join(current, "runner", "state.json"), "utf8")).toBe("unchanged opaque provider state");
  }, 60_000);

  it.each(["path", "file-url"] as const)("cold restores an imported secondary %s repository and acquires only a new descriptor", async sourceKind => {
    const origin = path.join(root, "import-origin"), original = path.join(root, "old-checkout");
    await fs.mkdir(origin); await fs.mkdir(original);
    const git = (cwd: string, ...args: string[]) => exec("git", ["-C", cwd, "-c", "user.name=Import fixture", "-c", "user.email=import@example.invalid", ...args]);
    await git(origin, "init", "--initial-branch=main");
    await fs.writeFile(path.join(origin, "code.txt"), "saved secondary baseline\n");
    await git(origin, "add", "."); await git(origin, "commit", "-m", "Import baseline");
    const repoUrl = sourceKind === "path" ? origin : pathToFileURL(origin).href;
    await git(original, "clone", repoUrl, "secondary");
    await fs.writeFile(path.join(original, "secondary", "untracked.txt"), "imported secondary work\n");
    const pinnedCommit = (await git(origin, "rev-parse", "HEAD")).stdout.trim();
    const repository = { id: randomUUID(), relativePath: "secondary", repoUrl, ref: "HEAD", pinnedCommit };
    const source = { kind: "empty" as const, repositories: [repository] };
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, ids.run));
    const [local] = await db.insert(executionWorkspaces).values({ companyId: ids.company, sourceIssueId: ids.issue,
      mode: "isolated_workspace", strategyType: "project_primary", providerType: "local_fs", name: "Imported secondary",
      cwd: original, providerRef: original }).returning();
    await db.update(issues).set({ executionWorkspaceId: local.id }).where(eq(issues.id, ids.issue));
    await migrateRemoteWorkspace({ db, storage, companyId: ids.company, workspaceId: local.id, source, apply: true });
    const imported = readRemoteWorkspaceAuthority((await workspace(local.id)).metadata)!;
    expect(imported.source).toEqual(source);
    await fs.rm(original, { recursive: true }); await fs.rm(origin, { recursive: true });

    // This descriptor was not in the committed import. It must still use normal
    // acquisition rather than treating a missing directory as saved bytes.
    const newOrigin = path.join(root, "new-origin"); await fs.mkdir(newOrigin);
    await git(newOrigin, "init", "--initial-branch=main");
    await fs.writeFile(path.join(newOrigin, "new.txt"), "newly acquired work\n");
    await git(newOrigin, "add", "."); await git(newOrigin, "commit", "-m", "New source");
    const added = { id: randomUUID(), relativePath: "new-repository", repoUrl: newOrigin, ref: "HEAD" };
    const nextRun = randomUUID(), nextLease = randomUUID();
    await db.insert(heartbeatRuns).values({ id: nextRun, companyId: ids.company, agentId: ids.agent, nativeIssueId: ids.issue,
      runtimeMode: "native", status: "running" });
    await db.insert(environmentLeases).values({ id: nextLease, companyId: ids.company, environmentId: ids.environment,
      heartbeatRunId: nextRun, issueId: ids.issue, provider: "daytona", providerLeaseId: `allocation-${nextLease}`, status: "active" });
    const reserved = await reserveRemoteWorkspace({ db, storage, companyId: ids.company, issueId: ids.issue, runId: nextRun,
      agentId: ids.agent, environmentId: ids.environment, projectId: null, projectWorkspaceId: null,
      existingWorkspaceId: local.id, source });
    const next = (await db.select().from(environmentLeases).where(eq(environmentLeases.id, nextLease)))[0]! as EnvironmentLease;
    const remote = await target("import-restored-sandbox");
    const restored = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: nextRun, lease: next, target: remote,
      source: { ...source, repositories: [repository, added] } });
    const secondary = path.join(restored.remoteRoot, "secondary");
    expect((await git(secondary, "rev-parse", "HEAD")).stdout.trim()).toBe(pinnedCommit);
    expect((await git(secondary, "remote")).stdout.trim()).toBe("");
    expect(await fs.readFile(path.join(secondary, "untracked.txt"), "utf8")).toBe("imported secondary work\n");
    expect(await fs.readFile(path.join(restored.remoteRoot, added.relativePath, "new.txt"), "utf8")).toBe("newly acquired work\n");
    expect(readRemoteWorkspaceAuthority(restored.workspace.metadata)).toMatchObject({ source, snapshotId: imported.snapshotId });
    const resolveGitAuth = vi.fn(async () => null);
    const admission = { db, storage, workspace: restored.workspace, runId: nextRun, lease: restored.lease, target: remote,
      repository: { ...repository, ref: null }, resolveGitAuth };
    // Registered admission encodes the stored default HEAD as null. It must
    // verify the same saved descriptor without changing the source identity.
    await expect(prepareRemoteWorkspaceRepository(admission)).resolves.toMatchObject({ cwd: secondary, pinnedCommit });
    const beforeChanged = readRemoteWorkspaceAuthority((await workspace(local.id)).metadata)!;
    await expect(prepareRemoteWorkspaceRepository({ ...admission,
      workspace: await workspace(local.id), repository: { ...repository, ref: null, repoUrl: newOrigin } }))
      .rejects.toThrow("remote_workspace_operation_failed");
    expect(readRemoteWorkspaceAuthority((await workspace(local.id)).metadata)).toEqual(beforeChanged);
    expect(resolveGitAuth).not.toHaveBeenCalled();
    const newRepository = { ...added, id: randomUUID(), relativePath: "wrapper-new", ref: null };
    await expect(prepareRemoteWorkspaceRepository({ ...admission, workspace: await workspace(local.id), repository: newRepository }))
      .resolves.toMatchObject({ cwd: path.join(restored.remoteRoot, "wrapper-new") });
    expect(resolveGitAuth).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(restored.remoteRoot, "wrapper-new", "new.txt"), "utf8")).toBe("newly acquired work\n");
    expect(readRemoteWorkspaceAuthority((await workspace(local.id)).metadata)!.source).toEqual(source);
  }, 60_000);

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)("cleans saved reads with read-only folders without changing modes or following symlinks", async () => {
    const reserved = await reserve({ kind: "empty" }), first = await target("read-only-sandbox");
    const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: ids.run, lease: await lease(), target: first });
    const locked = path.join(prepared.remoteRoot, "locked"), outside = path.join(root, "outside");
    await fs.mkdir(locked); await fs.writeFile(path.join(locked, "report.txt"), "saved read-only result\n", { mode: 0o444 });
    await fs.mkdir(outside); await fs.writeFile(path.join(outside, "keep.txt"), "outside the extraction\n", { mode: 0o444 });
    await fs.chmod(locked, 0o555); await fs.chmod(outside, 0o555);
    let extraction: Awaited<ReturnType<ReturnType<typeof createSavedWorkspaceLoader>>> | undefined;
    try {
      const saved = await saveRemoteWorkspace({ db, storage, workspace: prepared.workspace, runId: ids.run,
        lease: prepared.lease, target: first, assertOwned: async () => undefined });
      const savedTemp = path.join(root, "saved-reads"); await fs.mkdir(savedTemp); vi.stubEnv("TMPDIR", savedTemp);
      const loadSavedWorkspace = createSavedWorkspaceLoader(db, storage);
      extraction = await loadSavedWorkspace({ companyId: ids.company, workspaceId: reserved.id, snapshotId: saved.snapshotId });
      expect((await fs.stat(path.join(extraction.root, "locked"))).mode & 0o777).toBe(0o555);
      expect((await fs.stat(path.join(extraction.root, "locked", "report.txt"))).mode & 0o777).toBe(0o444);
      expect(await fs.readFile(path.join(extraction.root, "locked", "report.txt"), "utf8")).toBe("saved read-only result\n");
      // Cleanup must unlink a symlink without changing its external target.
      await fs.symlink(outside, path.join(extraction.root, "outside-link"));
      await extraction.cleanup();
      await expect(fs.access(path.dirname(extraction.root))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.stat(outside)).mode & 0o777).toBe(0o555);
      expect((await fs.stat(path.join(outside, "keep.txt"))).mode & 0o777).toBe(0o444);
      expect(await fs.readFile(path.join(outside, "keep.txt"), "utf8")).toBe("outside the extraction\n");
      expect((await fs.stat(locked)).mode & 0o777).toBe(0o555);
      const current = await workspace(reserved.id), authority = readRemoteWorkspaceAuthority(current.metadata)!;
      await db.update(executionWorkspaces).set({ metadata: { ...current.metadata, remoteWorkspace: { ...authority, location: null } } })
        .where(eq(executionWorkspaces.id, reserved.id));
      const files = workspaceFileResourceService(db, undefined, { remoteFiles: createRemoteWorkspaceFiles(db, { loadSavedWorkspace }) });
      expect(await files.readContent(ids.issue, { workspace: "execution", path: "locked/report.txt" }))
        .toMatchObject({ content: { data: "saved read-only result\n" }, resource: { source: { kind: "saved" } } });
      expect(await fs.readdir(savedTemp)).toEqual([]);
      expect(await files.list(ids.issue, { workspace: "execution", mode: "all" })).toMatchObject({ state: "available" });
      expect(await fs.readdir(savedTemp)).toEqual([]);
      await expect(files.readContent(ids.issue, { workspace: "execution", path: "missing.txt" })).rejects.toMatchObject({ status: 404 });
      expect(await fs.readdir(savedTemp)).toEqual([]);
    } finally {
      if (extraction) {
        await fs.chmod(path.join(extraction.root, "locked"), 0o700).catch(() => undefined);
        await fs.rm(path.dirname(extraction.root), { recursive: true, force: true });
      }
      await fs.chmod(locked, 0o700); await fs.chmod(outside, 0o700);
    }
  }, 60_000);

  it("forwards cancellation through saved file access and removes failed extraction scratch", async () => {
    const reserved = await reserve({ kind: "empty" }), first = await target("cancelled-saved-read");
    const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: ids.run, lease: await lease(), target: first });
    await fs.writeFile(path.join(prepared.remoteRoot, "report.txt"), "saved result\n");
    const saved = await saveRemoteWorkspace({ db, storage, workspace: prepared.workspace, runId: ids.run,
      lease: prepared.lease, target: first, assertOwned: async () => undefined });
    const current = await workspace(reserved.id), authority = readRemoteWorkspaceAuthority(current.metadata)!;
    await db.update(executionWorkspaces).set({ metadata: { ...current.metadata, remoteWorkspace: { ...authority, location: null } } })
      .where(eq(executionWorkspaces.id, reserved.id));
    const savedTemp = path.join(root, "cancelled-reads"); await fs.mkdir(savedTemp); vi.stubEnv("TMPDIR", savedTemp);
    for (const mode of ["abort", "storage_failure"] as const) {
      const controller = new AbortController(), failure = new Error("Saved object unavailable");
      let observedSignal: AbortSignal | undefined;
      const interruptedStorage: StorageService = { ...storage, getObject: async (companyId, objectKey, options) => {
        observedSignal = options?.signal;
        if (mode === "storage_failure") throw failure;
        const object = await storage.getObject(companyId, objectKey, options);
        controller.abort(new DOMException("Saved read cancelled", "AbortError"));
        return object;
      } };
      const remoteFiles = createRemoteWorkspaceFiles(db, { loadSavedWorkspace: createSavedWorkspaceLoader(db, interruptedStorage) });
      let readError: unknown;
      const access = await remoteFiles.open({ companyId: ids.company, workspaceId: reserved.id, signal: controller.signal })
        .catch(error => { readError = error; return null; });
      await access?.close();
      expect(observedSignal).toBe(controller.signal);
      if (mode === "storage_failure") expect(readError).toBe(failure);
      else expect(readError).toMatchObject({ name: "AbortError" });
      expect(await fs.readdir(savedTemp)).toEqual([]);
    }
    const cancelled = new DOMException("Already cancelled", "AbortError");
    const getObject = vi.fn(storage.getObject.bind(storage));
    await expect(createSavedWorkspaceLoader(db, { ...storage, getObject })({ companyId: ids.company,
      workspaceId: reserved.id, snapshotId: saved.snapshotId, signal: AbortSignal.abort(cancelled) })).rejects.toBe(cancelled);
    expect(getObject).not.toHaveBeenCalled();
    expect(await fs.readdir(savedTemp)).toEqual([]);
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
    const expectedRemoteRoot = path.join(sandbox.remoteCwd, ".paperclip-workspaces", path.basename(prepared.remoteRoot));
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

  it.each([
    { mode: "shared_workspace", inherited: false },
    { mode: "shared_workspace", inherited: true },
    { mode: "isolated_workspace", inherited: true },
    { mode: "operator_branch", inherited: true },
  ])("continues saved $mode files while fencing a second writer (inherited=$inherited)", async ({ mode, inherited }) => {
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    const projectId = randomUUID(), sourceId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: ids.company, name: "Synthetic shared project" });
    await db.insert(projectWorkspaces).values({ id: sourceId, companyId: ids.company, projectId,
      name: "Shared files", sourceType: "empty", sharedWorkspaceKey: "synthetic-shared" });
    await db.update(issues).set({ projectId, projectWorkspaceId: sourceId }).where(eq(issues.id, ids.issue));
    const input = { db, storage, companyId: ids.company, issueId: ids.issue, runId: ids.run,
      agentId: ids.agent, environmentId: ids.environment, projectId, projectWorkspaceId: sourceId,
      existingWorkspaceId: null, source: { kind: "empty" as const }, mode };
    const first = await target("shared-sandbox"), reserved = await reserveRemoteWorkspace(input);
    const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: ids.run,
      lease: await lease(), target: first });
    await fs.writeFile(path.join(prepared.remoteRoot, "shared-result.txt"), "from the first task\n");
    const childInput = { title: "Continue saved work", status: "in_progress" as const, assigneeAgentId: ids.agent };
    const child = inherited ? await issueService(db).create(ids.company, { ...childInput, parentId: ids.issue })
      : (await db.insert(issues).values({ ...childInput, companyId: ids.company, projectId, projectWorkspaceId: sourceId }).returning())[0]!;
    if (inherited) expect(child.executionWorkspaceId).toBe(reserved.id);
    const secondIssue = child.id, secondRun = randomUUID(), secondLease = randomUUID();
    await db.insert(heartbeatRuns).values({ id: secondRun, companyId: ids.company, agentId: ids.agent,
      nativeIssueId: secondIssue, runtimeMode: "native", status: "running" });
    const next = { ...input, issueId: secondIssue, runId: secondRun,
      existingWorkspaceId: mode === "shared_workspace" ? null : child.executionWorkspaceId };
    await expect(reserveRemoteWorkspace(next)).rejects.toThrow("unfinished writer");
    await saveRemoteWorkspace({ db, storage, workspace: prepared.workspace, runId: ids.run,
      lease: prepared.lease, target: first, assertOwned: async () => undefined });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, ids.run));
    if (inherited) await fs.rm(path.dirname(prepared.remoteRoot), { recursive: true, force: true });
    const reused = await reserveRemoteWorkspace(next);
    expect(reused.id).toBe(reserved.id);
    expect(readRemoteWorkspaceAuthority(reused.metadata)).toMatchObject({ epoch: 2, writerRunId: secondRun });
    await db.insert(environmentLeases).values({ id: secondLease, companyId: ids.company, environmentId: ids.environment,
      heartbeatRunId: secondRun, issueId: secondIssue, provider: "daytona",
      providerLeaseId: `allocation-${inherited ? secondLease : ids.lease}`, status: "active" });
    const newLease = (await db.select().from(environmentLeases).where(eq(environmentLeases.id, secondLease)))[0]! as EnvironmentLease;
    const nextTarget = inherited ? { ...await target("child-sandbox"), leaseId: secondLease,
      sandboxId: newLease.providerLeaseId! } : first;
    const continued = await prepareRemoteWorkspace({ db, storage, workspace: reused, runId: secondRun, lease: newLease, target: nextTarget,
      runtimeProvisionCommand: "printf 'continued effect\\n' >> continued-provision.txt" });
    expect(await fs.readFile(path.join(continued.remoteRoot, "continued-provision.txt"), "utf8")).toBe("continued effect\n");
    const [provisioned] = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.heartbeatRunId, secondRun),
      eq(workspaceOperations.phase, "remote_workspace_provision")));
    expect(provisioned).toMatchObject({ issueId: secondIssue, status: "succeeded" });
    expect(await fs.readFile(path.join(continued.remoteRoot, "shared-result.txt"), "utf8")).toBe("from the first task\n");
    await fs.appendFile(path.join(continued.remoteRoot, "shared-result.txt"), "from the child task\n");
    const childSaved = await saveRemoteWorkspace({ db, storage, workspace: continued.workspace, runId: secondRun,
      lease: continued.lease, target: nextTarget, assertOwned: async () => undefined });
    const loaded = await createSavedWorkspaceLoader(db, storage)({ companyId: ids.company, workspaceId: reserved.id,
      snapshotId: childSaved.snapshotId });
    try { expect(await fs.readFile(path.join(loaded.root, "shared-result.txt"), "utf8")).toBe("from the first task\nfrom the child task\n"); }
    finally { await loaded.cleanup(); }
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

  it.each(["initial", "repository:additional"])("saves current files through a different repair boundary after a failed %s upload", async boundary => {
    if (boundary === "initial") await db.update(heartbeatRuns).set({ runtimeMode: "legacy", nativeIssueId: null,
      issueId: null, contextSnapshot: { issueId: ids.issue } }).where(eq(heartbeatRuns.id, ids.run));
    const reserved = await reserve({ kind: "empty" }), first = await target("failed-boundary");
    const failing: StorageService = { ...storage, putFile: async upload => {
      await storage.putFile(upload);
      throw new Error("boundary storage offline");
    } };
    if (boundary === "initial") {
      await expect(prepareRemoteWorkspace({ db, storage: failing, workspace: reserved, runId: ids.run,
        lease: await lease(), target: first, assertOwned: async () => undefined,
        provisionCommand: "printf 'one preparation effect\\n' > prepared.txt" })).rejects.toThrow("boundary storage offline");
    } else {
      const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: ids.run, lease: await lease(), target: first });
      await fs.writeFile(path.join(prepared.remoteRoot, "prepared.txt"), "one preparation effect\n");
      await expect(saveRemoteWorkspace({ db, storage: failing, workspace: prepared.workspace, runId: ids.run,
        lease: prepared.lease, target: first, boundary, assertOwned: async () => undefined })).rejects.toThrow("boundary storage offline");
    }
    const before = await workspace(reserved.id), authority = readRemoteWorkspaceAuthority(before.metadata)!;
    const [pending] = await db.select().from(executionWorkspaceSnapshots).where(and(
      eq(executionWorkspaceSnapshots.executionWorkspaceId, reserved.id), eq(executionWorkspaceSnapshots.status, "pending")));
    expect(pending).toBeTruthy();
    expect(authority.snapshotId).toBe(pending!.parentSnapshotId);
    await fs.writeFile(path.join(authority.location!.remoteCwd, "after-failed-save.txt"), "newer live files must survive\n");
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, ids.run));
    const saved = await saveRemoteWorkspace({ db, storage, workspace: before, runId: ids.run,
      lease: await lease(), target: first, assertOwned: async () => undefined });
    expect(saved.generation).toBe(pending!.generation + 1);
    const [committed] = await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, saved.snapshotId));
    expect(committed).toMatchObject({ status: "committed", parentSnapshotId: authority.snapshotId });
    expect(readRemoteWorkspaceAuthority((await workspace(reserved.id)).metadata)).toMatchObject({
      dirty: false, writerRunId: null, snapshotId: saved.snapshotId,
    });
    const [retired] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, pending!.sourceOperationId));
    expect(retired).toMatchObject({ status: "failed", metadata: { generation: pending!.generation,
      exportCleanup: { state: "cleaned" } } });
    expect(await fs.readdir(path.join(authority.location!.remoteCwd, ".paperclip-runtime", "workspace-snapshots"))).toEqual([]);
    const upload = vi.spyOn(storage, "putFile"), execute = vi.spyOn((first as Extract<AdapterExecutionTarget, { transport: "sandbox" }>).runner!, "execute");
    try {
      await expect(saveRemoteWorkspace({ db, storage, workspace: before, runId: ids.run,
        lease: await lease(), target: first, boundary, assertOwned: async () => undefined })).rejects.toThrow("remote_workspace_snapshot_retired");
      expect(upload).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    } finally { upload.mockRestore(); execute.mockRestore(); }
    expect(await fs.readdir(path.join(authority.location!.remoteCwd, ".paperclip-runtime", "workspace-snapshots"))).toEqual([]);
    const abandonedUploads = pending!.metadata!.uploads as Array<{ objectKey: string }>;
    expect(abandonedUploads).toHaveLength(1);
    expect((await storage.headObject(ids.company, abandonedUploads[0]!.objectKey)).exists).toBe(true);
    const retention = remoteWorkspaceSnapshotRetentionService(db, { storage,
      now: () => new Date(Date.now() + 8 * 86_400_000) });
    await retention.tick();
    expect((await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, pending!.id)))[0]?.status)
      .toBe("deleted");
    expect((await storage.headObject(ids.company, abandonedUploads[0]!.objectKey)).exists).toBe(false);
    expect((await storage.headObject(ids.company, committed!.objectKey!)).exists).toBe(true);
    const extracted = await createSavedWorkspaceLoader(db, storage)({ companyId: ids.company, workspaceId: reserved.id, snapshotId: saved.snapshotId });
    try {
      expect(await fs.readFile(path.join(extracted.root, "prepared.txt"), "utf8")).toBe("one preparation effect\n");
      expect(await fs.readFile(path.join(extracted.root, "after-failed-save.txt"), "utf8")).toBe("newer live files must survive\n");
    } finally { await extracted.cleanup(); }
  }, 60_000);

  it.each(["journal", "ledger"])("respects historical %s generation reservations without changing the committed parent", async highest => {
    const reserved = await reserve({ kind: "empty" }), first = await target("reserved-generations");
    const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: ids.run, lease: await lease(), target: first });
    const parent = readRemoteWorkspaceAuthority(prepared.workspace.metadata)!.snapshotId;
    // A crash after journaling can leave no ledger row; retention can leave a
    // deleted ledger after the source operation is gone. Both remain reserved.
    await db.insert(workspaceOperations).values({ companyId: ids.company, executionWorkspaceId: reserved.id,
      heartbeatRunId: ids.run, issueId: ids.issue, phase: "remote_workspace_snapshot", status: "running",
      metadata: { boundary: "interrupted-before-ledger", epoch: 0, generation: highest === "journal" ? 5 : 3 } });
    await db.insert(executionWorkspaceSnapshots).values({ companyId: ids.company, executionWorkspaceId: reserved.id,
      sourceOperationId: randomUUID(), sourceRunId: ids.run, parentSnapshotId: null,
      generation: highest === "ledger" ? 5 : 3, epoch: 0, status: "deleted" });
    const saved = await saveRemoteWorkspace({ db, storage, workspace: prepared.workspace, runId: ids.run,
      lease: prepared.lease, target: first, assertOwned: async () => undefined });
    expect(saved.generation).toBe(6);
    expect((await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, saved.snapshotId)))[0])
      .toMatchObject({ status: "committed", parentSnapshotId: parent });
  }, 60_000);

  it("holds an already-poisoned pre-release reservation without rewriting its identity or uploading", async () => {
    const reserved = await reserve({ kind: "empty" }), first = await target("old-poisoned-reservation");
    const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: ids.run, lease: await lease(), target: first });
    const authority = readRemoteWorkspaceAuthority(prepared.workspace.metadata)!;
    await fs.writeFile(path.join(prepared.remoteRoot, "held-work.txt"), "retain exact existing files\n");
    const failing: StorageService = { ...storage, putFile: async () => { throw new Error("old upload failed"); } };
    await expect(saveRemoteWorkspace({ db, storage: failing, workspace: prepared.workspace, runId: ids.run,
      lease: prepared.lease, target: first, boundary: "repository:old", assertOwned: async () => undefined }))
      .rejects.toThrow("old upload failed");
    const [pending] = await db.select().from(executionWorkspaceSnapshots).where(and(
      eq(executionWorkspaceSnapshots.executionWorkspaceId, reserved.id), eq(executionWorkspaceSnapshots.status, "pending")));
    // Old pre-release code could journal a conflicting final operation before
    // beginWorkspaceSnapshot rejected it. Its identity must not be repurposed.
    const [poisoned] = await db.insert(workspaceOperations).values({ companyId: ids.company, executionWorkspaceId: reserved.id,
      heartbeatRunId: ids.run, issueId: ids.issue, phase: "remote_workspace_snapshot", status: "running",
      metadata: { boundary: "final", epoch: authority.epoch, generation: pending!.generation,
        parentSnapshotId: authority.snapshotId, exportCleanup: { ...authority.location, state: "pending" } } }).returning();
    const upload = vi.spyOn(storage, "putFile");
    await expect(saveRemoteWorkspace({ db, storage, workspace: prepared.workspace, runId: ids.run,
      lease: prepared.lease, target: first, assertOwned: async () => undefined }))
      .rejects.toThrow("remote_workspace_snapshot_operation_binding_changed");
    expect(upload).not.toHaveBeenCalled();
    const [held] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, poisoned!.id));
    const { saveWork, ...originalMetadata } = held!.metadata!;
    expect(originalMetadata).toEqual(poisoned!.metadata);
    expect(saveWork).toMatchObject({ activeIds: [], unknown: true, quiescedAt: expect.any(String) });
    expect(Number.isFinite(Date.parse((saveWork as { quiescedAt: string }).quiescedAt))).toBe(true);
    expect(await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.sourceOperationId, poisoned!.id)))
      .toHaveLength(0);
    expect(readRemoteWorkspaceAuthority((await workspace(reserved.id)).metadata)).toMatchObject({
      dirty: true, writerRunId: ids.run, snapshotId: authority.snapshotId,
    });
    expect(await fs.readFile(path.join(prepared.remoteRoot, "held-work.txt"), "utf8")).toBe("retain exact existing files\n");
  }, 60_000);

  it("reserves distinct generations for competing boundaries and fences the losing publication", async () => {
    const reserved = await reserve({ kind: "empty" }), first = await target("competing-boundaries");
    const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: ids.run, lease: await lease(), target: first });
    const parent = readRemoteWorkspaceAuthority(prepared.workspace.metadata)!.snapshotId;
    let arrivals = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const timeout = setTimeout(release, 10_000);
    const competingStorage: StorageService = { ...storage, putFile: async upload => {
      if (++arrivals === 2) release();
      await gate;
      return storage.putFile(upload);
    } };
    const input = { db, storage: competingStorage, workspace: prepared.workspace, runId: ids.run, lease: prepared.lease,
      target: first, assertOwned: async () => undefined };
    const boundaries = ["repository:one", "repository:two"];
    const results = await Promise.allSettled(boundaries.map(boundary => saveRemoteWorkspace({ ...input, boundary })))
      .finally(() => { clearTimeout(timeout); release(); });
    expect(arrivals).toBe(2);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ message: "remote_workspace_publication_fenced" });
    const rows = (await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.executionWorkspaceId, reserved.id)))
      .filter(row => row.id !== parent).sort((a, b) => a.generation - b.generation);
    expect(rows.map(row => row.generation)).toEqual([2, 3]);
    expect(rows.map(row => row.parentSnapshotId)).toEqual([parent, parent]);
    expect(new Set(rows.map(row => row.objectKey)).size).toBe(2);
    const winning = results.findIndex(result => result.status === "fulfilled");
    const upload = vi.spyOn(competingStorage, "putFile");
    const replay = await saveRemoteWorkspace({ ...input, boundary: boundaries[winning]! });
    expect(upload).not.toHaveBeenCalled();
    expect(readRemoteWorkspaceAuthority((await workspace(reserved.id)).metadata)?.snapshotId).toBe(replay.snapshotId);
    await expect(saveRemoteWorkspace({ ...input, boundary: boundaries[1 - winning]! }))
      .rejects.toThrow("remote_workspace_publication_fenced");
    expect(readRemoteWorkspaceAuthority((await workspace(reserved.id)).metadata)?.snapshotId).toBe(replay.snapshotId);
  }, 60_000);

  it.each(["failed", "succeeded"])("protects an active duplicate after its peer %s and cleans it only after the last invocation settles", async peer => {
    const reserved = await reserve({ kind: "empty" }), first = await target("active-duplicate");
    const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: ids.run, lease: await lease(), target: first });
    let release!: () => void, entered!: () => void, releaseOwnership!: () => void, postUpload!: () => void, uploads = 0, checks = 0;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const ownershipGate = new Promise<void>(resolve => { releaseOwnership = resolve; });
    const afterUpload = new Promise<void>(resolve => { postUpload = resolve; });
    const delayed: StorageService = { ...storage, putFile: async upload => {
      if (++uploads === 1) { entered(); await blocked; }
      else if (uploads === 2 && peer === "failed") throw new Error("duplicate upload failed");
      return storage.putFile(upload);
    } };
    const input = { db, storage: delayed, workspace: prepared.workspace, runId: ids.run, lease: prepared.lease,
      target: first, assertOwned: async () => undefined, boundary: "repository:shared" };
    const late = saveRemoteWorkspace({ ...input, assertOwned: async () => {
      if (++checks === 3) { postUpload(); await ownershipGate; }
    } }).then(value => ({ value, error: null }), error => ({ value: null, error }));
    let worker: ReturnType<typeof registerRemoteWorkspaceSnapshotRetentionWork> | undefined;
    let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
    try {
      await Promise.race([started, late.then(result => { throw result.error ?? new Error("Upload did not reach its barrier"); })]);
      if (peer === "failed") await expect(saveRemoteWorkspace(input)).rejects.toThrow("duplicate upload failed");
      else await saveRemoteWorkspace(input);
      const [older] = await db.select().from(executionWorkspaceSnapshots).where(and(
        eq(executionWorkspaceSnapshots.executionWorkspaceId, reserved.id), eq(executionWorkspaceSnapshots.generation, 2)));
      const [olderOperation] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, older!.sourceOperationId));
      await fs.writeFile(path.join(prepared.remoteRoot, "after-duplicate.txt"), "the final save contains newer work\n");
      const final = await saveRemoteWorkspace({ ...input, workspace: await workspace(reserved.id), boundary: "final" });
      expect(final.generation).toBe(3);
      const staging = path.join(prepared.remoteRoot, ".paperclip-runtime", "workspace-snapshots");
      expect(await fs.readdir(staging)).toContain(olderOperation!.id);
      const retention = remoteWorkspaceSnapshotRetentionService(db, { storage,
        now: () => new Date(Date.now() + 8 * 86_400_000) });
      const tick = vi.spyOn(retention, "tick");
      coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
      worker = registerRemoteWorkspaceSnapshotRetentionWork(coordinator, retention, () => {});
      await vi.waitFor(() => expect(tick).toHaveBeenCalled(), { timeout: 4000, interval: 20 });
      await vi.waitFor(async () => expect(await retention.nextDeadlineAt()).toBeNull(), { timeout: 4000, interval: 20 });
      expect((await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, older!.id)))[0]?.status)
        .toBe(peer === "failed" ? "pending" : "superseded");
      expect(await fs.readdir(staging)).toContain(olderOperation!.id);
      const heldTicks = tick.mock.calls.length;
      release();
      await Promise.race([afterUpload, late.then(result => { throw result.error ?? new Error("Upload did not reach ownership check"); })]);
      // Consume the upload's own notification while its invocation still pins
      // the row. Only the last-token settlement can wake the quiet worker next.
      await vi.waitFor(() => expect(tick.mock.calls.length).toBeGreaterThan(heldTicks), { timeout: 4000, interval: 20 });
      await vi.waitFor(async () => expect(await retention.nextDeadlineAt()).toBeNull(), { timeout: 4000, interval: 20 });
      const postUploadTicks = tick.mock.calls.length;
      releaseOwnership();
      expect((await late).error).toMatchObject({ message: "remote_workspace_publication_fenced" });
      await vi.waitFor(async () => expect((await db.select().from(executionWorkspaceSnapshots)
        .where(eq(executionWorkspaceSnapshots.id, older!.id)))[0]?.status).toBe("deleted"), { timeout: 4000, interval: 20 });
      expect(tick.mock.calls.length).toBeGreaterThan(postUploadTicks);
      const [settled] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, olderOperation!.id));
      expect(settled!.status).toBe(peer === "failed" ? "failed" : "succeeded");
      expect(settled!.metadata?.exportCleanup).toMatchObject({ state: "cleaned" });
      expect(await fs.readdir(staging)).toEqual([]);
      const keys = older!.metadata!.uploads as Array<{ objectKey: string }>;
      for (const item of keys) expect((await storage.headObject(ids.company, item.objectKey)).exists).toBe(false);
      expect(readRemoteWorkspaceAuthority((await workspace(reserved.id)).metadata)?.snapshotId).toBe(final.snapshotId);
      const saved = await createSavedWorkspaceLoader(db, storage)({ companyId: ids.company, workspaceId: reserved.id, snapshotId: final.snapshotId });
      try { expect(await fs.readFile(path.join(saved.root, "after-duplicate.txt"), "utf8")).toBe("the final save contains newer work\n"); }
      finally { await saved.cleanup(); }
    } finally { release(); releaseOwnership(); await late; await worker?.stop(); await coordinator?.stop(); }
  }, 60_000);

  it.each(["untracked", "malformed-owner", "malformed-active"])("keeps adopted %s work pinned after a newer final save", async marker => {
    const reserved = await reserve({ kind: "empty" }), first = await target("unknown-save-work");
    const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: ids.run, lease: await lease(), target: first });
    const input = { db, storage, workspace: prepared.workspace, runId: ids.run, lease: prepared.lease,
      target: first, assertOwned: async () => undefined, boundary: "repository:legacy" };
    const failed: StorageService = { ...storage, putFile: async () => { throw new Error("old upload failed"); } };
    await expect(saveRemoteWorkspace({ ...input, storage: failed })).rejects.toThrow("old upload failed");
    const [old] = await db.select().from(executionWorkspaceSnapshots).where(and(
      eq(executionWorkspaceSnapshots.executionWorkspaceId, reserved.id), eq(executionWorkspaceSnapshots.generation, 2)));
    // Older/crashed callers supplied no per-invocation completion evidence.
    await db.update(workspaceOperations).set({ metadata: sql`${workspaceOperations.metadata} - 'saveWork'` })
      .where(eq(workspaceOperations.id, old!.sourceOperationId));
    await saveRemoteWorkspace(input);
    if (marker === "malformed-owner") await db.update(workspaceOperations).set({ metadata: sql`jsonb_set(${workspaceOperations.metadata},
      '{saveWork,unknown}', '"false"'::jsonb)` }).where(eq(workspaceOperations.id, old!.sourceOperationId));
    if (marker === "malformed-active") await db.update(workspaceOperations).set({ metadata: sql`jsonb_set(jsonb_set(${workspaceOperations.metadata},
      '{saveWork,unknown}', 'false'::jsonb), '{saveWork,activeIds}', '{"unfinished":"unknown"}'::jsonb)` })
      .where(eq(workspaceOperations.id, old!.sourceOperationId));
    const final = await saveRemoteWorkspace({ ...input, workspace: await workspace(reserved.id), boundary: "final" });
    const [held] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, old!.sourceOperationId));
    expect(held).toMatchObject({ status: "succeeded", metadata: { exportCleanup: { state: "pending" } } });
    if (marker === "untracked") expect(held!.metadata?.saveWork).toMatchObject({ activeIds: [], unknown: true });
    const retention = remoteWorkspaceSnapshotRetentionService(db, { storage, now: () => new Date(Date.now() + 8 * 86_400_000) });
    await retention.tick();
    expect((await db.select().from(executionWorkspaceSnapshots).where(eq(executionWorkspaceSnapshots.id, old!.id)))[0]?.status).toBe("superseded");
    expect(await fs.readdir(path.join(prepared.remoteRoot, ".paperclip-runtime", "workspace-snapshots"))).toContain(old!.sourceOperationId);
    expect(readRemoteWorkspaceAuthority((await workspace(reserved.id)).metadata)?.snapshotId).toBe(final.snapshotId);
  }, 60_000);

  it.each(["issue_column", "context_only"])("retains pre-native preparation files and the exact repair obligation when the first upload fails: %s", async identity => {
    await db.update(heartbeatRuns).set({ ...legacyControllerClaim("legacy"), runtimeMode: "legacy", nativeIssueId: null,
      issueId: identity === "issue_column" ? ids.issue : null, contextSnapshot: { issueId: ids.issue } })
      .where(eq(heartbeatRuns.id, ids.run));
    const [claimed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ids.run));
    // The production preparer's ownership callback renews on another pool.
    // Bound it so a row-lock inversion fails rather than hanging this test.
    const assertOwned = async () => livenessDb(db).transaction(async tx => {
      await tx.execute(sql`select set_config('statement_timeout', '500ms', true)`);
      if (!await renewLegacyControllerLease(tx as unknown as typeof db, claimed!)) throw new Error("controller lease lost");
    });
    const reserved = await reserve({ kind: "empty" }), first = await target("first-save-outage");
    const failing: StorageService = { ...storage, putFile: async () => { throw new Error("initial storage offline"); } };
    await expect(prepareRemoteWorkspace({ db, storage: failing, workspace: reserved, runId: ids.run,
      lease: await lease(), target: first, assertOwned,
      provisionCommand: "printf 'one remote effect\\n' >> setup-result.txt" })).rejects.toThrow("initial storage offline");
    const [beforeFailure] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ids.run));
    await terminalizeLegacyExecution({ db, run: beforeFailure!, status: "failed", patch: {
      errorCode: "setup_failed", resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    } });
    const [failed] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ids.run));
    expect(failed).toMatchObject({ runtimeMode: "legacy", status: "failed", runnerProfileJson: {
      remoteWorkspace: { state: "prepared", snapshotId: null, workspaceId: reserved.id },
    }, resultJson: { workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: {
      schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [ids.lease],
    } } });
    expect(failed?.runnerProfileJson).not.toHaveProperty("nativeExecutionInput");
    expect(await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, ids.run))).toHaveLength(0);
    const source = await lease();
    expect(await nativeWorkspaceExportPendingForLease(db, source)).toBe(true);
    expect(source).toMatchObject({ status: "pending_cleanup", leasePolicy: "retain_on_failure" });
    const runtime = environmentRuntimeService(db);
    const [environment] = await db.select().from(environments).where(eq(environments.id, ids.environment));
    expect(await runtime.destroyRunLease({ environment: environment! as Environment, lease: source })).toBeNull();
    const retainedAuthority = readRemoteWorkspaceAuthority((await workspace(reserved.id)).metadata)!;
    expect(retainedAuthority).toMatchObject({
      dirty: true, writerRunId: ids.run, snapshotId: null, location: { leaseId: ids.lease },
    });
    expect(await fs.readFile(path.join(retainedAuthority.location!.remoteCwd, "setup-result.txt"), "utf8")).toBe("one remote effect\n");
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, ids.company));
    expect(actions).toHaveLength(1);
    expect(actions[0]?.evidence).toMatchObject({ runId: ids.run, workspaceRestoreRecovery: { leaseIds: [ids.lease] } });
  }, 60_000);

  it("reconstructs a stopped pre-native file obligation only for its exact current authority", async () => {
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", nativeIssueId: null, issueId: null,
      contextSnapshot: { issueId: ids.issue } }).where(eq(heartbeatRuns.id, ids.run));
    const reserved = await reserve({ kind: "empty" }), first = await target("orphan-preparation");
    const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: ids.run,
      lease: await lease(), target: first });
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, ids.run));
    const current = await workspace(reserved.id), authority = readRemoteWorkspaceAuthority(current.metadata)!;
    for (const invalid of [
      { ...authority, epoch: authority.epoch + 1 },
      { ...authority, writerRunId: randomUUID() },
      { ...authority, location: { ...authority.location!, leaseId: randomUUID() } },
      { ...authority, location: { ...authority.location!, environmentId: randomUUID() } },
    ]) {
      await db.update(executionWorkspaces).set({ metadata: { ...current.metadata, remoteWorkspace: invalid } })
        .where(eq(executionWorkspaces.id, reserved.id));
      expect(await nativeWorkspaceExportPendingForLease(db, prepared.lease)).toBe(false);
      expect(await preserveRemoteWorkspacePreparationFailure(db, prepared.lease)).toBeNull();
    }
    await db.update(executionWorkspaces).set({ metadata: current.metadata }).where(eq(executionWorkspaces.id, reserved.id));
    expect(await nativeWorkspaceExportPendingForLease(db, { ...prepared.lease, companyId: randomUUID() })).toBe(false);
    expect(await preserveRemoteWorkspacePreparationFailure(db, { ...prepared.lease, id: randomUUID() })).toBeNull();
    const otherIssueId = randomUUID();
    await db.insert(issues).values({ id: otherIssueId, companyId: ids.company, title: "Unrelated task" });
    await db.update(executionWorkspaces).set({ sourceIssueId: otherIssueId }).where(eq(executionWorkspaces.id, reserved.id));
    expect(await preserveRemoteWorkspacePreparationFailure(db, prepared.lease)).toBeNull();
    await db.update(executionWorkspaces).set({ sourceIssueId: ids.issue }).where(eq(executionWorkspaces.id, reserved.id));
    await db.update(heartbeatRuns).set({ controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(heartbeatRuns.id, ids.run));
    expect(await preserveOrphanedNativeWorkspace(db, prepared.lease)).toBe(false);
    expect(await nativeWorkspaceExportPendingForLease(db, prepared.lease)).toBe(true);
    expect(await preserveRemoteWorkspacePreparationFailure(db, prepared.lease, { assertOwned: async () => {
      await db.update(heartbeatRuns).set({ controllerBootId: randomUUID() }).where(eq(heartbeatRuns.id, ids.run));
    } })).toBeNull();
    await db.update(heartbeatRuns).set({ controllerBootId: null, controllerLeaseExpiresAt: null }).where(eq(heartbeatRuns.id, ids.run));
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, ids.company))).toHaveLength(0);
    expect(await preserveOrphanedNativeWorkspace(db, prepared.lease)).toBe(true);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ids.run)))[0]?.resultJson)
      .toMatchObject({ workspaceRestoreRecovery: { leaseIds: [ids.lease] } });
    expect(await nativeWorkspaceExportPendingForLease(db, prepared.lease)).toBe(true);
    await saveRemoteWorkspace({ db, storage, workspace: await workspace(reserved.id), runId: ids.run,
      lease: await lease(), target: first, assertOwned: async () => undefined });
    expect(await nativeWorkspaceExportPendingForLease(db, prepared.lease)).toBe(false);
    expect(await preserveRemoteWorkspacePreparationFailure(db, prepared.lease)).toBeNull();
  }, 60_000);

  it.each([
    ["a lost reply", "remote_workspace_export_cleanup_failed"],
    ["a timeout", "remote_workspace_operation_timed_out: cleanup (configured timeout 10000ms)"],
    ["an untrusted error", "remote_workspace_export_cleanup_failed"],
  ] as const)("records and retries export cleanup after %s without another upload", async (failure, diagnostic) => {
    const reserved = await reserve({ kind: "empty" }), first = await target("cleanup-sandbox");
    const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: ids.run, lease: await lease(), target: first });
    await fs.writeFile(path.join(prepared.remoteRoot, "saved.txt"), "keep working files\n");
    const sandbox = first as Extract<AdapterExecutionTarget, { transport: "sandbox" }>;
    const execute = sandbox.runner!.execute.bind(sandbox.runner!);
    let lost = false, cleanupAttempts = 0;
    sandbox.runner!.execute = async input => {
      const result = await execute(input);
      if (input.args?.[1]?.includes("remote_workspace_export_cleanup_failed") && result.exitCode === 0) {
        cleanupAttempts++;
        if (lost) return result;
        lost = true;
        if (failure === "a timeout") return { ...result, timedOut: true,
          stdout: "SYNTHETIC_PRIVATE_STDOUT", stderr: "SYNTHETIC_PRIVATE_STDERR" };
        throw new Error(failure === "an untrusted error"
          ? "remote_workspace_operation_timed_out: cleanup (configured timeout 10000ms)\nSYNTHETIC_PRIVATE_STDERR"
          : "lost cleanup reply");
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
    expect(before?.metadata?.exportCleanup).toMatchObject({ state: "pending", lastError: diagnostic });
    expect(cleanupAttempts).toBe(1);
    expect(await saveRemoteWorkspace(input)).toMatchObject({ snapshotId: saved.snapshotId, generation: saved.generation });
    expect(upload).toHaveBeenCalledOnce();
    const [after] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, before!.id));
    expect(after?.metadata?.exportCleanup).toMatchObject({ state: "cleaned", lastError: null });
    expect(cleanupAttempts).toBe(2);
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

  it("keeps enrollment conditional while enrolled authority fails closed when persistence disappears", async () => {
    const candidate = { adapterType: "paperclip_runner", environmentDriver: "sandbox", experimentalEnabled: true };
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "s3");
    expect(shouldUseRemoteWorkspaces(candidate)).toBe(true);
    expect(shouldUseRemoteWorkspaces({ ...candidate, experimentalEnabled: false })).toBe(false);
    expect(shouldUseRemoteWorkspaces({ ...candidate, existingWorkspace: { metadata: {} } })).toBe(false);
    const reserved = await reserve({ kind: "empty" });
    const before = (await workspace(reserved.id)).metadata;
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
    expect(shouldUseRemoteWorkspaces(candidate)).toBe(false);
    expect(shouldUseRemoteWorkspaces({ ...candidate, existingWorkspace: reserved })).toBe(true);
    const localStorage = createStorageService(createLocalDiskStorageProvider(path.join(root, "local-only")));
    await expect(reserveRemoteWorkspace({ db, storage: localStorage, companyId: ids.company,
      issueId: ids.issue, runId: ids.run, agentId: ids.agent, environmentId: ids.environment,
      projectId: null, projectWorkspaceId: null, existingWorkspaceId: reserved.id, source: { kind: "empty" } }))
      .rejects.toMatchObject({ details: { code: "remote_workspace_persistence_unavailable" } });
    expect((await workspace(reserved.id)).metadata).toEqual(before);
    vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "s3");
    vi.stubEnv("DATABASE_URL", "");
    expect(shouldUseRemoteWorkspaces(candidate)).toBe(false);
    expect(shouldUseRemoteWorkspaces({ ...candidate, existingWorkspace: reserved })).toBe(true);
    vi.stubEnv("DATABASE_URL", databaseUrl!);
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", path.join(root, "missing-stable-key"));
    expect(shouldUseRemoteWorkspaces(candidate)).toBe(false);
    expect(shouldUseRemoteWorkspaces({ ...candidate, existingWorkspace: reserved })).toBe(true);
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

  it.each(["saved", "dirty", "unsaved", "foreign_snapshot", "delete_requested", "deletion_race", "controller_claim_race", "stale_epoch", "unconfirmed_stop", "unknown_action"] as const)(
    "checks durable remote work at the native safe-replacement decision (%s)", async scenario => {
      const reserved = await reserve({ kind: "empty" }), first = await target("native-replacement-sandbox");
      const prepared = await prepareRemoteWorkspace({ db, storage, workspace: reserved, runId: ids.run,
        lease: await lease(), target: first, assertOwned: async () => undefined });
      await fs.writeFile(path.join(prepared.remoteRoot, "saved.txt"), "work survives a failed provider session\n");
      if (scenario !== "unsaved") await saveRemoteWorkspace({ db, storage, workspace: prepared.workspace,
        runId: ids.run, lease: prepared.lease, target: first, assertOwned: async () => undefined });
      const current = await workspace(reserved.id), authority = readRemoteWorkspaceAuthority(current.metadata)!;
      if (scenario === "dirty" || scenario === "stale_epoch") await db.update(executionWorkspaces).set({ metadata: {
        ...current.metadata, remoteWorkspace: { ...authority, ...(scenario === "dirty" ? { dirty: true, writerRunId: ids.run }
          : { epoch: authority.epoch + 1 }) },
      } }).where(eq(executionWorkspaces.id, reserved.id));
      if (scenario === "foreign_snapshot") await db.update(executionWorkspaceSnapshots).set({ sourceRunId: randomUUID() })
        .where(eq(executionWorkspaceSnapshots.id, authority.snapshotId!));
      if (scenario === "delete_requested") await db.update(executionWorkspaceSnapshots).set({ status: "delete_requested" })
        .where(eq(executionWorkspaceSnapshots.id, authority.snapshotId!));
      const stopped = (await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success",
        metadata: { ...prepared.lease.metadata, ...(scenario !== "unconfirmed_stop" ? {
          remoteExecutionTermination: remoteTerminationReceipt(prepared.lease, {
            providerLeaseId: prepared.lease.providerLeaseId, state: "destroyed",
          }),
        } : {}) },
      }).where(eq(environmentLeases.id, ids.lease)).returning())[0]! as EnvironmentLease;
      if (scenario === "saved") {
        await db.transaction(tx => clearRemoteWorkspaceLocationForReleasedLease({ db: tx, lease: stopped }));
        await fs.rm(prepared.remoteRoot, { recursive: true, force: true });
        await expect(fs.stat(prepared.remoteRoot)).rejects.toThrow();
      }
      const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ids.run));
      await db.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date(), runnerProfileJson: {
        ...source!.runnerProfileJson, recoveryEventInventoryVersion: 1,
        nativeExecutionInput: { provider: { kind: "codex" }, workspace: { cwd: prepared.remoteRoot } },
      } }).where(eq(heartbeatRuns.id, ids.run));
      await db.insert(nativeRunFinalizations).values({ runId: ids.run, companyId: ids.company, issueId: ids.issue,
        phase: "terminal_failure", attempt: 1, failureCode: "native_provider_terminal_failed",
        failureDetail: { originalFailureCode: "fixture_checkpoint_unusable" } });
      if (scenario === "unknown_action") await appendHeartbeatRunEvent(db, { companyId: ids.company, runId: ids.run,
        agentId: ids.agent, eventType: "tool.execution.started", stream: "system",
        payload: { name: "send_email", executionId: "unconfirmed-external-action", transport: "process" } });
      let replacement;
      if (scenario === "deletion_race" || scenario === "controller_claim_race") {
        let release!: () => void, announce!: () => void;
        let blockingPid = 0;
        const released = new Promise<void>(resolve => { release = resolve; });
        const locked = new Promise<void>(resolve => { announce = resolve; });
        const deletion = db.transaction(async tx => {
          await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, ids.issue)).for("update");
          const [session] = await tx.execute(sql`select pg_backend_pid() as pid`);
          blockingPid = Number(session?.pid);
          announce();
          await released;
          if (scenario === "deletion_race") await tx.update(executionWorkspaceSnapshots).set({ status: "delete_requested" })
            .where(eq(executionWorkspaceSnapshots.id, authority.snapshotId!));
          else await tx.update(nativeRunFinalizations).set({ leaseOwner: "another-controller",
            leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, ids.run));
        });
        await locked;
        const pending = reconcileSafeNativeReplacements(db);
        try {
          const deadline = performance.now() + 5_000;
          let blocked = false;
          while (!blocked && performance.now() < deadline) {
            const waiting = await db.execute(sql`select exists(select 1 from pg_stat_activity
              where datname = current_database() and ${blockingPid} = any(pg_blocking_pids(pid))) as blocked`);
            blocked = waiting[0]?.blocked === true;
            if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
          }
          expect(blocked).toBe(true);
        } finally { release(); await deletion; replacement = await pending; }
      } else replacement = await reconcileSafeNativeReplacements(db);
      expect(replacement).toMatchObject({ scheduled: scenario === "saved" ? 1 : 0 });
      const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, ids.run));
      expect(successors).toHaveLength(scenario === "saved" ? 1 : 0);
      if (scenario === "saved") expect(successors[0]).toMatchObject({ status: "scheduled_retry",
        contextSnapshot: { retryOfRunId: ids.run, forceFreshSession: true } });
      else expect(await fs.readFile(path.join(prepared.remoteRoot, "saved.txt"), "utf8"))
        .toBe("work survives a failed provider session\n");
      if (scenario === "unknown_action") {
        const [decision] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, ids.run));
        expect(decision?.failureDetail?.replacementDenied).toBe("uncertain_provider_action");
      }
    }, 60_000,
  );
});
