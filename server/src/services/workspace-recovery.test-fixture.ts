// Shared setup for the automatic retained workspace recovery suites
// (workspace-recovery-retry-copyback, -preparation*, -warm-handoff and -admission),
// which were split from one file by feature area so CI can run them in parallel.
// Each suite calls useWorkspaceRecoveryFixture() inside its top-level describe, so
// it gets its own database, temporary root and the same per-test cleanup. `db`,
// `root` and `connectionString` are live bindings: the helpers and the importing
// suite see the values that beforeAll (or replaceFixtureState) assigns.
//
// vi.mock() only applies to the file that declares it, so each suite keeps its
// own environment-execution-target mock and passes its `targets` map in.
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { recordRequiredWorkspaceRestoreFailure, terminalizeLegacyExecution } from "./legacy-execution-recovery.js";
import { resolveExternalTestDatabaseUrl } from "../__tests__/helpers/external-test-database.js";
import { environmentService } from "./environments.js";
import { classifyEnvironmentCapabilities, environmentRuntimeService } from "./environment-runtime.js";
import { readSystemRecovery, createSystemRecovery, failSystemRecovery, reserveSystemRecoveryAttempt, SystemRecoveryFailure } from "./system-recovery-state.js";
import { adoptSystemRecovery } from "./system-recovery.js";
import { requestTaskRetry } from "./task-retry.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, vi } from "vitest";
import { agents, completionContracts, companies, createDb, applyPendingMigrations, environmentLeases, environments, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, agentWakeupRequests, executionWorkspaces } from "@paperclipai/db";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../vendor/paperclip-runner/testing.js";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { EnvironmentLease } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { prepareNativeWorkspaceSync, resumeNativeWorkspaceSync } from "./native-runtime/native-workspace-sync.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { prepareSandboxStopAndRetain, settleStopOnlyCleanup, readStopOnlyCleanup } from "./sandbox-stop-and-retain.js";
import * as heartbeatServices from "./heartbeat.js";
import { heartbeatService } from "./heartbeat.js";
import { prepareRemoteWorkspace, reserveRemoteWorkspace } from "./remote-workspaces.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import * as workerProof from "./native-runtime/native-workspace-platform-proof.js";

export let db: ReturnType<typeof createDb>;
export let root: string;
export let connectionString: string;
export const fixtureCompanyIds = new Set<string>();
let targets: Map<string, AdapterSandboxExecutionTarget>;

/** Swaps the connection the shared helpers use; a suite restores the previous one itself. */
export function replaceFixtureState(next: { db: typeof db; root?: string; connectionString?: string }) {
  db = next.db;
  if (next.root !== undefined) root = next.root;
  if (next.connectionString !== undefined) connectionString = next.connectionString;
}

export function useWorkspaceRecoveryFixture(executionTargets: Map<string, AdapterSandboxExecutionTarget>) {
  targets = executionTargets;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  const priorHome = process.env.PAPERCLIP_HOME, priorInstance = process.env.PAPERCLIP_INSTANCE_ID;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "workspace-recovery-"));
    process.env.PAPERCLIP_HOME = path.join(root, "home"); process.env.PAPERCLIP_INSTANCE_ID = "recovery";
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_WORKSPACE_RECOVERY_TEST_DATABASE_URL");
    if (external) {
      await applyPendingMigrations(external);
      temporary = { connectionString: external, cleanup: async () => {} };
    } else temporary = await startEmbeddedPostgresTestDatabase("workspace-recovery-");
    connectionString = temporary.connectionString;
    db = createDb(connectionString);
    if (external) await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  }, 30_000);
  afterAll(async () => {
    await db?.$client.end(); await temporary?.cleanup();
    const makeWritable = async (directory: string): Promise<void> => {
      const entry = await lstat(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink()) return;
      await chmod(directory, 0o700);
      for (const child of await readdir(directory, { withFileTypes: true })) {
        if (child.isDirectory()) await makeWritable(path.join(directory, child.name));
      }
    };
    await makeWritable(root); await rm(root, { recursive: true, force: true });
    if (priorHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = priorHome;
    if (priorInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID; else process.env.PAPERCLIP_INSTANCE_ID = priorInstance;
  });
  afterEach(async () => {
    // Discovery is intentionally global and bounded. An unresolved source from
    // an earlier test must not consume the current fixture's recovery page.
    // Keep all history within each test until its assertions have completed.
    const companyIds = [...fixtureCompanyIds]; fixtureCompanyIds.clear();
    if (!companyIds.length) return;
    // Stop global queue sweeps from revisiting deferred input after this
    // fixture's recovery actions and lease bindings are removed below.
    await db.update(agents).set({ status: "paused" }).where(inArray(agents.companyId, companyIds));
    await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() }).where(and(
      inArray(agentWakeupRequests.companyId, companyIds),
      inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"])));
    await heartbeatService(db).drainActiveRunExecutions();
    // Admission tests leave synthetic queue blockers. Retire them only after
    // assertions so they cannot trip the next test's instance-wide drain fence.
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(
      inArray(heartbeatRuns.companyId, companyIds), inArray(heartbeatRuns.status, ["queued", "running"])));
    const leases = await db.select({ id: environmentLeases.id }).from(environmentLeases)
      .where(inArray(environmentLeases.companyId, companyIds));
    for (const lease of leases) targets.delete(lease.id);
    await db.delete(environmentLeases).where(inArray(environmentLeases.companyId, companyIds));
    // Historical adoption can reconstruct an action from either the lease or
    // the run descriptor, so retire both fixture inputs before deleting it.
    await db.update(heartbeatRuns).set({ resultJson: sql`${heartbeatRuns.resultJson} - 'workspaceRestoreRecovery' - 'workspaceRestoreFailure'` })
      .where(inArray(heartbeatRuns.companyId, companyIds));
    await db.delete(issueRecoveryActions).where(inArray(issueRecoveryActions.companyId, companyIds));
  });
}

export async function seed(mode = "native", nativeDescriptor = true, resourceDisposition: "destroy" | "keep_running" = "destroy", reusable = false, ephemeral = false) {
  const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), actionId: string = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Workspace recovery", defaultResponsibleUserId: "board", issuePrefix: `R${companyId.slice(0, 6)}` });
  fixtureCompanyIds.add(companyId);
  await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
  await db.insert(issues).values({ id: issueId, companyId, assigneeAgentId: agentId, status: "blocked", title: "Recover existing work" });
  await db.insert(heartbeatRuns).values({ id: runId, companyId, issueId, nativeIssueId: mode === "native" ? issueId : null,
    agentId, runtimeMode: mode, status: "failed", finishedAt: new Date(), errorCode: "execution_interrupted", contextSnapshot: { issueId } });
  if (mode === "legacy") await db.update(heartbeatRuns).set({ runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } } }).where(eq(heartbeatRuns.id, runId));
  if (mode === "native") await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "terminal_failure" });
  const [environment] = await db.insert(environments).values({ name: runId, driver: "sandbox" }).returning();
  const providerLeaseId: string = randomUUID(), remote = path.join(root, runId, "remote"), host = path.join(root, runId, "host");
  await mkdir(host, { recursive: true }); await writeFile(path.join(host, "existing.txt"), "base\n");
  const leaseValues = { companyId, issueId, heartbeatRunId: runId,
    environmentId: environment.id, provider: "daytona", providerLeaseId,
    metadata: { remoteCwd: remote, driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true, ...(reusable ? { agentId } : {}) } };
  const acquired = reusable ? await environmentService(db).acquireLease({ ...leaseValues, leasePolicy: "reuse_by_environment" }) : null;
  const [lease] = acquired ? await db.select().from(environmentLeases).where(eq(environmentLeases.id, acquired.id))
    : await db.insert(environmentLeases).values({ ...leaseValues, leasePolicy: ephemeral ? "ephemeral" : "retain_on_failure", status: "released",
      cleanupStatus: "success", releasedAt: new Date() }).returning();
  const target: AdapterSandboxExecutionTarget = { kind: "remote", transport: "sandbox", providerKey: "test", leaseId: lease.id,
    remoteCwd: remote, timeoutMs: 30_000, sandboxLeaseAcquisition: { outcome: "created", providerLeaseId },
    runner: { execute: input => new Promise((resolve, reject) => {
      const startedAt = new Date().toISOString();
      const child = execFile(input.command, input.args ?? [], { cwd: input.cwd, env: { ...process.env, ...input.env }, timeout: input.timeoutMs, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => resolve({ exitCode: error ? typeof error.code === "number" ? error.code : 1 : 0,
          signal: error?.signal ?? null, timedOut: error?.killed ?? false, stdout, stderr, pid: child.pid ?? null, startedAt }));
      child.stdin?.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") reject(error); });
      child.stdin?.end(input.stdin ?? "");
    }) } };
  targets.set(lease.id, target);
  if (nativeDescriptor) {
    const prepared = await prepareNativeWorkspaceSync({ db, companyId, workspaceId: issueId, workspaceLocalDir: host,
      runId, lease: lease as EnvironmentLease, target, resourceDisposition });
    expect(prepared).not.toBeNull();
  } else {
    // Provider boundary only: real temporary files, no native baseline. The
    // production provider's syncOut contract validates its archive itself.
    target.runner!.syncIn = async () => ({ filesTransferred: 0, bytesTransferred: 0, operations: [] });
    target.runner!.syncOut = async operations => {
      for (const operation of operations) for (const file of operation.files)
        await cp(file.sourcePath, file.targetPath, { recursive: true, dereference: false });
      return { filesTransferred: 2, bytesTransferred: 0, operations: [] };
    };
    await mkdir(remote, { recursive: true });
    await writeFile(path.join(remote, "existing.txt"), "base\n");
  }
  await writeFile(path.join(remote, "saved.txt"), "finished work\n");
  await writeFile(path.join(host, "newer.txt"), "newer local work\n");
  const recovery = { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [lease.id] };
  await db.update(heartbeatRuns).set({ resultJson: { workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: recovery,
    conversationContinuation: "continue_conversation_v1" } }).where(eq(heartbeatRuns.id, runId));
  await db.update(environmentLeases).set({ metadata: { ...lease.metadata,
    remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId, state: "stopped" }) } }).where(eq(environmentLeases.id, lease.id));
  await db.insert(issueRecoveryActions).values({ id: actionId, companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
    ownerType: "board", cause: mode === "native" ? "native_continuation_requires_reconciliation" : "legacy_execution_requires_reconciliation",
    fingerprint: runId, nextAction: "Manual repair required", evidence: { runId, workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: recovery } });
  const runtime = { resumeRunLease: vi.fn(async (_input: { lease: EnvironmentLease }) => ({ providerLeaseId, metadata: { remoteCwd: remote } })),
    retryPendingSandboxTeardown: vi.fn(async (_input: { lease: EnvironmentLease }) => ({ providerLeaseId, state: "stopped" })) };
  const environmentRuntime = environmentRuntimeService(db, { drivers: [{ driver: "sandbox",
    acquireRunLease: vi.fn(), releaseRunLease: vi.fn(), ...runtime,
    resolveCapabilities: async () => classifyEnvironmentCapabilities({ verifiedMethods: [], declared: null, narrowing: null }),
  }] });
  const input = { db, companyId, issueId, runId, actionId, environmentRuntime };
  return { ...input, input, runtime, host, remote, lease, providerLeaseId };
}

export const action = async (id: string) => (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)))[0]!;

export const run = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;

export async function failedWarmSource(exportOnly = false, hops = 0) {
  const f = hops ? await warmHandoffSource(hops) : await seed("native", true, "keep_running");
  if (hops) await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, f.runId));
  await db.update(environmentLeases).set({ leasePolicy: "reuse_by_environment" }).where(eq(environmentLeases.id, f.lease.id));
  const retry = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "board",
    actorSource: "local_implicit", idempotencyKey: randomUUID(), observedRunId: f.runId });
  const failed = failSystemRecovery(reserveSystemRecoveryAttempt(createSystemRecovery(f.runId, retry.requestId!))!,
    new SystemRecoveryFailure("source_binding_invalid", "service_required"), { now: Date.now() - 86_400_000 });
  await db.update(issueRecoveryActions).set({ evidence: { ...(await action(f.actionId)).evidence, systemRecovery: failed,
    workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: f.runId, status: "blocked", stage: "verifying_stop",
      attempt: 1, attemptLimit: 6, requestIds: [retry.requestId!] } } }).where(eq(issueRecoveryActions.id, f.actionId));
  if (exportOnly) {
    const contractId = randomUUID(), resultId = randomUUID();
    await db.insert(completionContracts).values({ id: contractId, companyId: f.companyId, issueId: f.issueId,
      revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: {},
      canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
    await db.update(heartbeatRuns).set({ completionContractId: contractId, resultJson: {} }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(nativeRunResults).values({ id: resultId, companyId: f.companyId, issueId: f.issueId, runId: f.runId,
      completionContractId: contractId, schemaStatus: "accepted", serverFingerprint: resultId, canonicalSha256: resultId,
      resultJson: { terminal: { runTerminalState: "succeeded" } } });
    await db.update(nativeRunFinalizations).set({ resultId }).where(eq(nativeRunFinalizations.runId, f.runId));
    const evidence = { ...(await action(f.actionId)).evidence };
    delete evidence.workspaceRestoreFailure; delete evidence.workspaceRestoreRecovery;
    await db.update(issueRecoveryActions).set({ cause: "native_workspace_sync_out_retry_exhausted", evidence }).where(eq(issueRecoveryActions.id, f.actionId));
  }
  return { ...f, retry, failed };
}

export function boardRecoveryApp(actor: { userId: string; source: "local_implicit" | "session"; companyIds?: string[] } = { userId: "local-board", source: "local_implicit" },
  heartbeat?: ReturnType<typeof heartbeatService>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.actor = { type: "board", ...actor }; next(); });
  const factory = heartbeat ? vi.spyOn(heartbeatServices, "heartbeatService").mockReturnValue(heartbeat) : undefined;
  try { app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1])); }
  finally { factory?.mockRestore(); }
  app.use(errorHandler);
  return app;
}

export function receiptOnlyRecoveryApp(actor?: Parameters<typeof boardRecoveryApp>[0]) {
  const routeHeartbeat = heartbeatService(db);
  vi.spyOn(routeHeartbeat, "resumeTaskRetry").mockImplementation(async () => undefined as never);
  return boardRecoveryApp(actor, routeHeartbeat);
}

export type RecoverySourceLayout = "retained" | "published" | "raw";

export async function acceptedRemoteExport(sourceLayout: RecoverySourceLayout = "retained") {
  const f = await seed("native", false);
  const source = await run(f.runId);
  let workspaceId: string = randomUUID(), remoteCwd = await realpath(f.remote);
  let preparedReference: Awaited<ReturnType<typeof prepareRemoteWorkspace>>["reference"] | undefined;
  if (sourceLayout === "published") {
    // Fresh modern sources retain the actual publisher's path and authority.
    // The explicit raw fixture remains available for refusal coverage.
    targets.get(f.lease.id)!.remoteCwd = remoteCwd;
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    await db.update(issues).set({ status: "in_progress", executionRunId: f.runId, executionLockedAt: new Date() })
      .where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null, error: null, errorCode: null })
      .where(eq(heartbeatRuns.id, f.runId));
    const leaseMetadata = { ...f.lease.metadata };
    delete leaseMetadata.remoteExecutionTermination;
    const [activeLease] = await db.update(environmentLeases).set({ status: "active", releasedAt: null,
      cleanupStatus: null, metadata: leaseMetadata }).where(eq(environmentLeases.id, f.lease.id)).returning();
    const reserved = await reserveRemoteWorkspace({ db, companyId: f.companyId, issueId: f.issueId,
      runId: f.runId, agentId: source.agentId, environmentId: activeLease.environmentId!,
      projectId: null, projectWorkspaceId: null, existingWorkspaceId: null, source: { kind: "empty" } });
    const prepared = await prepareRemoteWorkspace({ db, workspace: reserved, runId: f.runId,
      lease: activeLease as EnvironmentLease, target: targets.get(f.lease.id)! });
    workspaceId = prepared.workspace.id; remoteCwd = prepared.remoteRoot; preparedReference = prepared.reference;
    for (const name of ["existing.txt", "saved.txt"]) await cp(path.join(f.remote, name), path.join(remoteCwd, name));
    await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date(),
      metadata: { ...prepared.lease.metadata,
        remoteExecutionTermination: remoteTerminationReceipt(prepared.lease, { providerLeaseId: f.providerLeaseId, state: "stopped" }) },
    }).where(eq(environmentLeases.id, f.lease.id));
    await db.update(heartbeatRuns).set({ status: source.status, finishedAt: source.finishedAt,
      error: source.error, errorCode: source.errorCode }).where(eq(heartbeatRuns.id, f.runId));
    await db.update(issues).set({ status: issue.status, executionRunId: issue.executionRunId,
      executionLockedAt: issue.executionLockedAt }).where(eq(issues.id, f.issueId));
  } else if (sourceLayout === "retained") {
    const publishedRoot = path.join(path.dirname(f.remote), ".paperclip-workspaces", workspaceId);
    await mkdir(path.dirname(publishedRoot), { recursive: true });
    await rename(f.remote, publishedRoot);
    f.remote = publishedRoot;
    remoteCwd = await realpath(f.remote);
  }
  const git = (args: string[], cwd = remoteCwd) => new Promise<string>((resolve, reject) =>
    execFile("git", args, { cwd }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
  await git(["init"]);
  await git(["add", "."]);
  await git(["-c", "user.name=Recovery fixture", "-c", "user.email=recovery@example.invalid", "commit", "-m", "Completed work"]);
  const commit = await git(["rev-parse", "HEAD"]);
  targets.get(f.lease.id)!.remoteCwd = remoteCwd;
  f.runtime.resumeRunLease.mockImplementation(async () => ({ providerLeaseId: f.providerLeaseId, metadata: { remoteCwd } }));
  const authority = { schema: "paperclip.remote-workspace.v1", epoch: 1, snapshotId: null,
    source: { kind: "empty" }, writerRunId: f.runId, dirty: true,
    location: { environmentId: f.lease.environmentId!, leaseId: f.lease.id, providerLeaseId: f.providerLeaseId, remoteCwd } };
  if (sourceLayout !== "published") await db.insert(executionWorkspaces).values({ id: workspaceId, companyId: f.companyId, sourceIssueId: f.issueId,
    name: "Completed remote work", cwd: remoteCwd, providerType: "cloud_sandbox", mode: "isolated_workspace",
    strategyType: "project_primary", status: "active", metadata: { remoteWorkspace: authority } });
  await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, f.issueId));
  const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
  await db.update(environmentLeases).set({ executionWorkspaceId: workspaceId, leasePolicy: "reuse_by_environment",
    metadata: { ...lease.metadata, remoteCwd, agentId: source.agentId } }).where(eq(environmentLeases.id, lease.id));
  const contractId = randomUUID(), resultId = randomUUID();
  await db.insert(completionContracts).values({ id: contractId, companyId: f.companyId, issueId: f.issueId,
    revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "low",
    completionAuthority: "agent_claim_policy", incompleteCriteriaPolicy: "preserve_non_terminal",
    contractJson: { revision: CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim.contractRevision,
      objective: "Complete the work", criteria: [{ id: "objective", requirement: "Complete the task" }] },
    canonicalSha256: "contract", createdByActorType: "system", createdByActorId: "test" });
  await db.update(heartbeatRuns).set({ completionContractId: contractId, resultJson: {}, runnerProfileJson: {
    adapterDispatch: { adapterType: "paperclip_runner" },
    remoteWorkspace: preparedReference ?? { schema: "paperclip.remote-workspace-run.v1", workspaceId, leaseId: lease.id,
      providerLeaseId: f.providerLeaseId, remoteCwd, epoch: 1, state: "prepared", snapshotId: null },
  } }).where(eq(heartbeatRuns.id, f.runId));
  await db.insert(nativeRunResults).values({ id: resultId, companyId: f.companyId, issueId: f.issueId, runId: f.runId,
    completionContractId: contractId, schemaStatus: "accepted", serverFingerprint: "result", canonicalSha256: "result",
    resultJson: { terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, result: CONTROL_PLANE_CONFORMANCE_RESULT } });
  await db.update(nativeRunFinalizations).set({ resultId, failureCode: "native_workspace_sync_out_retry_exhausted" })
    .where(eq(nativeRunFinalizations.runId, f.runId));
  await db.update(issueRecoveryActions).set({ cause: "native_workspace_sync_out_retry_exhausted", evidence: { runId: f.runId } })
    .where(eq(issueRecoveryActions.id, f.actionId));
  await adoptSystemRecovery(db, f);
  return { ...f, ...(sourceLayout === "published" ? { remote: remoteCwd } : {}), source, workspaceId, resultId, git, commit };
}

export async function interruptedRemotePreparation(interruption: "shutdown" | "lease" | "process_lost" = "shutdown", sourceLayout: RecoverySourceLayout = "retained") {
  const f = await acceptedRemoteExport(sourceLayout);
  await db.delete(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
  await db.delete(nativeRunResults).where(eq(nativeRunResults.runId, f.runId));
  const recovery = { schema: "paperclip.workspace-restore-recovery.v1", leaseIds: [f.lease.id] };
  await db.update(heartbeatRuns).set({ runtimeMode: "legacy", nativeIssueId: null, completionContractId: null,
    status: interruption === "process_lost" ? "failed" : "interrupted", executionStage: "preparing",
    errorCode: interruption === "process_lost" ? "process_lost" : interruption === "lease" ? "lease_released_before_terminal" : "server_shutdown_interrupted",
    controllerBootId: randomUUID(),
    error: interruption === "process_lost" ? "Process lost -- server may have restarted; retrying once"
      : interruption === "lease" ? "Environment lease released before preparation settled" : "Interrupted by graceful server shutdown (SIGTERM)",
    resultJson: { workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: recovery,
      ...(interruption === "process_lost" ? { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        processLossDiagnostic: { localCheck: "no_identifiers", pidRecorded: false, groupRecorded: false, retryEligible: true, runPredatesObserver: true } } : {}),
      ...(interruption === "lease" ? { cancellation: { source: "unknown", expected: false,
        initiator: { type: "system" }, reason: "Environment lease released before preparation settled",
        recordedAt: new Date().toISOString() } } : {}) },
  }).where(eq(heartbeatRuns.id, f.runId));
  await db.update(issues).set({ statusVersion: 2 }).where(eq(issues.id, f.issueId));
  await db.update(issueRecoveryActions).set({ cause: "legacy_execution_requires_reconciliation",
    fingerprint: `legacy-execution:${f.runId}`, status: "resolved", outcome: "blocked",
    evidence: { runId: f.runId, workspaceRestoreFailure: "restore_failed", workspaceRestoreRecovery: recovery,
      automaticRecovery: { policy: "preserve_without_replay_v1", runId: f.runId, replay: "blocked", actionOutcome: "unknown" },
      nativeBootstrapFailureBlock: { runId: f.runId, previousStatus: "in_progress", statusVersion: 2 } },
  }).where(eq(issueRecoveryActions.id, f.actionId));
  await adoptSystemRecovery(db, f);
  await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.source.agentId, status: "running" });
  return f;
}

export async function withheldPreparationRetry(f: { companyId: string; issueId: string; runId: string; actionId: string }) {
  const source = await run(f.runId);
  const [withheld] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId,
    responsibleUserId: source.responsibleUserId, scopeKind: "issue", issueId: f.issueId, runtimeMode: "legacy", status: "cancelled", finishedAt: new Date(),
    retryOfRunId: f.runId, scheduledRetryAttempt: 1, scheduledRetryReason: "transient_failure",
    errorCode: "execution_reconciliation_required", contextSnapshot: { issueId: f.issueId },
    resultJson: { stopReason: "execution_reconciliation_required", timeoutSource: "stale_queued_run_gate",
      executionWait: { issueId: f.issueId, recoveryActionId: f.actionId } },
  }).returning();
  return withheld;
}

export async function failedRemotePreparation(sourceLayout: RecoverySourceLayout = "retained", startedMarker = false, warning = false) {
  const f = await interruptedRemotePreparation("shutdown", sourceLayout);
  const source = await run(f.runId);
  const error = "Repository access is no longer available; refresh the repository catalog";
  await terminalizeLegacyExecution({ db, run: source, status: "failed", reconcileIfNeeded: false,
    patch: { errorCode: "setup_failed", error, executionStage: "preparing",
      startedAt: new Date(Date.now() - 1000), contextSnapshot: { ...source.contextSnapshot, source: "native_status_decision" },
      resultJson: { ...source.resultJson, stopReason: "adapter_failed",
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } } });
  if (warning) await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId, agentId: source.agentId,
    eventType: "agent_observability.unavailable", stream: "system", level: "warn",
    payload: { reason: "unsupported_harness", revision: randomUUID() } });
  if (startedMarker) await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId, agentId: source.agentId,
    eventType: "lifecycle", stream: "system", level: "info", message: "run started" });
  await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId, agentId: source.agentId,
    eventType: "error", stream: "system", level: "error", message: error });
  await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId, agentId: source.agentId,
    eventType: "lifecycle", stream: "system", level: "info", message: "task.run.measured",
    payload: { phase: "task.run.measured", outcome: "failed", durationMs: 1000, durableSettlement: true } });
  return f;
}

export async function stoppedWorkspaceWorker(f: { runId: string }) {
  const source = await run(f.runId);
  const deploymentWorker = { provider: "railway" as const, projectId: randomUUID(), environmentId: randomUUID(), serviceId: randomUUID(), deploymentId: randomUUID() };
  const owner = { token: randomUUID(), hostname: "previous-controller", pid: 123,
    processStartedAt: new Date().toISOString(), worker: deploymentWorker };
  const stopProof = { v: 1 as const, iss: "paperclip-cloud" as const, aud: "paperclip-workspace-worker-stop/v1" as const,
    sub: "test-stack", stopped: true as const, iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 30, runId: f.runId, ownerToken: owner.token, worker: deploymentWorker };
  const proof = vi.spyOn(workerProof, "requestWorkspaceWorkerStopProof").mockResolvedValue({ status: "verified", proof: stopProof });
  await db.update(heartbeatRuns).set({ runnerProfileJson: {
    ...source.runnerProfileJson, nativeWorkspaceFinalizationOwner: owner,
  } }).where(eq(heartbeatRuns.id, f.runId));
  return { proof, stopProof, owner, deploymentWorker };
}

export async function warmHandoffSource(hops = 1, beforeStop?: (lease: typeof environmentLeases.$inferSelect) => Promise<void>) {
  const prior = await seed("native", true, "keep_running", true), source = await run(prior.runId);
  let previousTarget = targets.get(prior.lease.id)!, previousLeaseId = prior.lease.id;
  let previousRunId: string = prior.runId;
  let lease = prior.lease, current = source;
  const leaseIds = [previousLeaseId];
  for (let hop = 0; hop < hops; hop++) {
    expect(await resumeNativeWorkspaceSync({ db, runId: previousRunId, target: previousTarget })).toBe(true);
    await db.update(heartbeatRuns).set({ status: "succeeded", errorCode: null, resultJson: null }).where(eq(heartbeatRuns.id, previousRunId));
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, previousRunId));
    await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.id, prior.actionId));
    await environmentService(db).releaseLease(previousLeaseId, "released", { cleanupStatus: "success" });
    const [released] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, previousLeaseId));
    [current] = await db.insert(heartbeatRuns).values({ companyId: prior.companyId, agentId: source.agentId,
      issueId: prior.issueId, nativeIssueId: prior.issueId, runtimeMode: "native", status: "cancelled", finishedAt: new Date(),
      contextSnapshot: { issueId: prior.issueId } }).returning();
    await db.insert(nativeRunFinalizations).values({ companyId: prior.companyId, issueId: prior.issueId, runId: current.id, phase: "terminal_failure" });
    const acquired = await environmentService(db).acquireLease({ companyId: prior.companyId, environmentId: prior.lease.environmentId!,
      issueId: prior.issueId, heartbeatRunId: current.id, provider: "daytona", providerLeaseId: prior.providerLeaseId,
      leasePolicy: "reuse_by_environment", replacesReusableLeaseId: previousLeaseId,
      metadata: { ...released.metadata, sandboxLeaseAcquisition: { outcome: "resumed" } } });
    [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, acquired.id));
    const target = { ...previousTarget, leaseId: lease.id, sandboxLeaseAcquisition: { outcome: "resumed" as const, providerLeaseId: prior.providerLeaseId } };
    targets.set(lease.id, target);
    expect(await prepareNativeWorkspaceSync({ db, companyId: prior.companyId, workspaceId: prior.issueId,
      workspaceLocalDir: prior.host, runId: current.id, lease: lease as EnvironmentLease, target, resourceDisposition: "keep_running" })).not.toBeNull();
    leaseIds.push(lease.id); previousRunId = current.id; previousLeaseId = lease.id; previousTarget = target;
  }
  [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
  await beforeStop?.(lease);
  await writeFile(path.join(prior.remote, "after-warm-stop.txt"), "stopped turn work\n");
  await recordRequiredWorkspaceRestoreFailure(db, await run(current.id), { workspaceRestoreFailure: "restore_failed" }, lease);
  const [action] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, prior.companyId),
    eq(issueRecoveryActions.fingerprint, `native-workspace:${current.id}`)));
  const [retained] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, lease.id));
  const stopping = readStopOnlyCleanup(retained) ? retained : await prepareSandboxStopAndRetain(db, retained);
  expect(stopping).not.toBeNull();
  expect(await settleStopOnlyCleanup(db, stopping!, { attemptId: String(stopping!.metadata!.pendingCleanupAttemptId),
    receipt: { providerLeaseId: prior.providerLeaseId, state: "stopped" } })).not.toBeNull();
  return { ...prior, priorRunId: prior.runId, priorLeaseId: prior.lease.id, leaseIds, runId: current.id, lease, actionId: action.id,
    input: { ...prior.input, runId: current.id, actionId: action.id } };
}

export async function makeRetryDue(actionId: string) {
  const current = await action(actionId);
  const state = readSystemRecovery(current.evidence)!;
  await db.update(issueRecoveryActions).set({ evidence: { ...current.evidence,
    systemRecovery: { ...state, nextAttemptAt: 0 } } }).where(eq(issueRecoveryActions.id, actionId));
}
