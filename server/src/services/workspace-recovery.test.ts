import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, approvals, budgetPolicies, costEvents, issueApprovals, issueTreeHolds, issueTreeHoldMembers, companies, createDb, environmentLeases, environments, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, agentWakeupRequests, workspaceOperations } from "@paperclipai/db";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { EnvironmentLease } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { prepareNativeWorkspaceSync } from "./native-runtime/native-workspace-sync.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { recoverRetainedWorkspace, requestWorkspaceRecovery, scheduleRecoveredWorkspaceCleanup, reconcileRetainedWorkspaces, retainedWorkspaceCandidates } from "./workspace-recovery.js";
import * as activity from "./activity-log.js";
import { heartbeatService } from "./heartbeat.js";
import { hasVerifiedWorkspaceRepair, readWorkspaceRecovery } from "./workspace-recovery-receipt.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import * as workerProof from "./native-runtime/native-workspace-platform-proof.js";
const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", () => ({ resolveEnvironmentExecutionTarget: async (input: { leaseId: string }) => targets.get(input.leaseId) }));

describe("automatic retained workspace recovery", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  const priorHome = process.env.PAPERCLIP_HOME, priorInstance = process.env.PAPERCLIP_INSTANCE_ID;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "workspace-recovery-"));
    process.env.PAPERCLIP_HOME = path.join(root, "home"); process.env.PAPERCLIP_INSTANCE_ID = "recovery";
    temporary = await startEmbeddedPostgresTestDatabase("workspace-recovery-"); db = createDb(temporary.connectionString);
  }, 30_000);
  afterAll(async () => {
    await db?.$client.end(); await temporary?.cleanup(); await rm(root, { recursive: true, force: true });
    if (priorHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = priorHome;
    if (priorInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID; else process.env.PAPERCLIP_INSTANCE_ID = priorInstance;
  });
  async function seed(mode = "native") {
    const companyId = randomUUID(), issueId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), actionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Workspace recovery", defaultResponsibleUserId: "board", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", adapterType: "paperclip_runner", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, assigneeAgentId: agentId, status: "blocked", title: "Recover existing work" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, issueId, nativeIssueId: mode === "native" ? issueId : null,
      agentId, runtimeMode: mode, status: "failed", finishedAt: new Date(), errorCode: "execution_interrupted", contextSnapshot: { issueId } });
    if (mode === "legacy") await db.update(heartbeatRuns).set({ runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } } }).where(eq(heartbeatRuns.id, runId));
    if (mode === "native") await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "terminal_failure" });
    const [environment] = await db.insert(environments).values({ name: runId, driver: "sandbox" }).returning();
    const providerLeaseId = randomUUID(), remote = path.join(root, runId, "remote"), host = path.join(root, runId, "host");
    await mkdir(host, { recursive: true }); await writeFile(path.join(host, "existing.txt"), "base\n");
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId,
      environmentId: environment.id, provider: "daytona", providerLeaseId, leasePolicy: "retain_on_failure", status: "released",
      cleanupStatus: "success", releasedAt: new Date(), metadata: { remoteCwd: remote, driver: "sandbox", pluginId: randomUUID(), sandboxProviderPlugin: true },
    }).returning();
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
    const prepared = await prepareNativeWorkspaceSync({ db, companyId, workspaceId: issueId, workspaceLocalDir: host,
      runId, lease: lease as EnvironmentLease, target, resourceDisposition: "destroy" });
    expect(prepared).not.toBeNull();
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
      retryPendingSandboxTeardown: vi.fn(async () => ({ providerLeaseId, state: "stopped" })) };
    const input = { db, companyId, issueId, runId, actionId, environmentRuntime: runtime as never };
    return { ...input, input, runtime, host, remote, lease, providerLeaseId };
  }
  const action = async (id: string) => (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)))[0]!;
  const run = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;

  it.each(["native", "legacy"])("recovers real files without an accepted result or another turn: %s", async mode => {
    const f = await seed(mode);
    await recoverRetainedWorkspace(f.input);
    expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
    expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)).toMatchObject({ status: "recovered", attempt: 1 });
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ workspaceRepairRequired: false });
    expect((await run(f.runId)).status).toBe("failed");
    expect((await action(f.actionId)).evidence.executionReconciliation).toBeUndefined();
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("blocked");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    await recoverRetainedWorkspace(f.input);
    expect(f.runtime.resumeRunLease).toHaveBeenCalledOnce();
    expect(await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, f.companyId), eq(workspaceOperations.phase, "workspace_recovery")))).toHaveLength(1);
  }, 30_000);

  it("serializes concurrent repairs through the physical workspace lock", async () => {
    const f = await seed(); let ready!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    f.runtime.resumeRunLease.mockImplementationOnce(async () => { ready(); await gate; return { providerLeaseId: f.providerLeaseId, metadata: { remoteCwd: f.remote } }; });
    const first = recoverRetainedWorkspace(f.input);
    await started;
    try { await recoverRetainedWorkspace(f.input); expect(f.runtime.resumeRunLease).toHaveBeenCalledOnce(); }
    finally { release(); await first; }
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)?.status).toBe("recovered");
  }, 30_000);

  it.each(["missing_stop", "wrong_stop", "another_owner", "active_writer", "missing_descriptor"])("retains the source and starts no provider for %s", async kind => {
    const f = await seed();
    if (kind === "missing_stop" || kind === "wrong_stop") await db.update(environmentLeases).set({ metadata: { ...f.lease.metadata,
      ...(kind === "wrong_stop" ? { remoteExecutionTermination: remoteTerminationReceipt({ ...f.lease, id: randomUUID() }, { providerLeaseId: f.providerLeaseId, state: "stopped" }) } : {}) } }).where(eq(environmentLeases.id, f.lease.id));
    if (kind === "another_owner") await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.runId, provider: "daytona", providerLeaseId: f.providerLeaseId });
    if (kind === "active_writer") await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.lease.heartbeatRunId ? (await run(f.runId)).agentId : "", status: "running", nativeIssueId: f.issueId });
    if (kind === "missing_descriptor") await db.update(heartbeatRuns).set({ runnerProfileJson: {} }).where(eq(heartbeatRuns.id, f.runId));
    await recoverRetainedWorkspace(f.input);
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)).toMatchObject({ status: "blocked", retryable: false });
    expect(f.runtime.resumeRunLease).not.toHaveBeenCalled();
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
    expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
  }, 30_000);

  it("resumes a copied workspace after a lost stop reply without overwriting later files", async () => {
    const f = await seed();
    f.runtime.retryPendingSandboxTeardown.mockRejectedValueOnce(new Error("stop reply lost"));
    await recoverRetainedWorkspace(f.input);
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)).toMatchObject({ status: "queued", attempt: 1 });
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
    await writeFile(path.join(f.host, "saved.txt"), "later user edit\n");
    const pending = await action(f.actionId);
    await db.update(issueRecoveryActions).set({ evidence: { ...pending.evidence,
      workspaceRecovery: { ...readWorkspaceRecovery(pending.evidence), retryAt: 0 } } }).where(eq(issueRecoveryActions.id, f.actionId));
    const request = { ...f.input, idempotencyKey: randomUUID(), actorId: "user" };
    await requestWorkspaceRecovery(request); await requestWorkspaceRecovery(request);
    await recoverRetainedWorkspace(f.input);
    expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("later user edit\n");
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)).toMatchObject({ status: "recovered", attempt: 2, requestIds: [request.idempotencyKey] });
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
  }, 30_000);

  it("resumes an interrupted file export from persisted state with a new database connection", async () => {
    const f = await seed(), target = targets.get(f.lease.id)!;
    const execute = target.runner!.execute;
    let interrupted = false, interruptExports = true;
    target.runner!.execute = async input => {
      const output = await execute(input);
      if (interruptExports && input.args?.some(arg => arg.includes("tar -cf"))) {
        interrupted = true;
        throw new Error("File export transport interrupted after archive creation");
      }
      return output;
    };
    await recoverRetainedWorkspace(f.input);
    expect(interrupted).toBe(true);
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)).toMatchObject({ status: "queued", stage: "restoring_files", attempt: 1 });
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
    expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
    interruptExports = false;
    await writeFile(path.join(f.host, "later.txt"), "work saved during the interruption\n");
    const pending = await action(f.actionId);
    await db.update(issueRecoveryActions).set({ evidence: { ...pending.evidence,
      workspaceRecovery: { ...readWorkspaceRecovery(pending.evidence), retryAt: 0 } } }).where(eq(issueRecoveryActions.id, f.actionId));
    const restarted = createDb(temporary.connectionString);
    try {
      await recoverRetainedWorkspace({ ...f.input, db: restarted });
      expect(await hasVerifiedWorkspaceRepair(restarted, await run(f.runId))).toBe(true);
      expect(readWorkspaceRecovery((await action(f.actionId)).evidence)).toMatchObject({ status: "recovered", attempt: 2 });
      expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
      expect(await readFile(path.join(f.host, "later.txt"), "utf8")).toBe("work saved during the interruption\n");
    } finally { await restarted.$client.end(); target.runner!.execute = execute; }
  }, 30_000);

  it("rejects a recovery request outside the task company", async () => {
    const f = await seed();
    await expect(requestWorkspaceRecovery({ ...f.input, companyId: randomUUID(), actorId: "user", idempotencyKey: randomUUID() })).rejects.toThrow("changed");
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)).toBeNull();
  });

  it.each(["native", "legacy", "native_export"])("delivers only saved user input once through ordinary admission: %s", async mode => {
    const f = await seed(mode === "legacy" ? "legacy" : "native"), commentId = randomUUID(), queueId = randomUUID();
    if (mode === "native_export") {
      await db.update(issueRecoveryActions).set({ cause: "native_workspace_sync_out_retry_exhausted", evidence: { runId: f.runId } }).where(eq(issueRecoveryActions.id, f.actionId));
      await db.update(heartbeatRuns).set({ resultJson: {} }).where(eq(heartbeatRuns.id, f.runId));
    }
    const source = await run(f.runId);
    // Occupy the agent, not this workspace. This keeps the admitted turn queued
    // so this test does not substitute a model mock for recovery evidence.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId, status: "running" });
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "board", body: "Confirm the existing publication. Do not publish it again." });
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: source.agentId,
      source: "automation", reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId: f.issueId, commentId, _paperclipWakeContext: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentIds: [commentId], wakeCommentId: commentId } } });
    await recoverRetainedWorkspace(f.input);
    const service = heartbeatService(db);
    await Promise.all([service.resumeRemoteStopComments(await run(f.runId)), service.resumeRemoteStopComments(await run(f.runId))]);
    const turns = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    expect(turns).toHaveLength(1);
    expect(turns[0].contextSnapshot).toMatchObject({ forceFreshSession: true, previousRunId: f.runId, wakeCommentIds: [commentId] });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queueId)))[0]).toMatchObject({ status: "coalesced", runId: turns[0].id });
    expect((await run(f.runId)).status).toBe("failed");
  }, 30_000);

  it("queues cleanup only after verified persistence and keeps it separate from recovery", async () => {
    const f = await seed();
    await scheduleRecoveredWorkspaceCleanup(db, await run(f.runId));
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0].status).toBe("released");
    await recoverRetainedWorkspace(f.input);
    await scheduleRecoveredWorkspaceCleanup(db, await run(f.runId));
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0]).toMatchObject({
      status: "pending_cleanup", leasePolicy: "ephemeral", metadata: { workspaceRecoveryCleanup: { runId: f.runId } } });
    expect(f.runtime.retryPendingSandboxTeardown).toHaveBeenCalledOnce();
    expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
  }, 30_000);

  it.each(["pause", "cancelled", "approval", "budget", "reassigned"])("keeps the %s gate after files recover", async gate => {
    const f = await seed(), commentId = randomUUID(), queueId = randomUUID();
    const source = await run(f.runId);
    const [occupied] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId, status: "running" }).returning();
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "board", body: "Confirm the existing publication. Do not publish it again." });
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: source.agentId,
      source: "automation", reason: "issue_commented", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId: f.issueId, commentId, _paperclipWakeContext: { issueId: f.issueId, wakeReason: "issue_commented", wakeCommentIds: [commentId], wakeCommentId: commentId } } });
    await recoverRetainedWorkspace(f.input);
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
    if (gate === "pause") {
      const holdId = randomUUID();
      await db.insert(issueTreeHolds).values({ id: holdId, companyId: f.companyId, rootIssueId: f.issueId, mode: "pause", status: "active" });
      await db.insert(issueTreeHoldMembers).values({ companyId: f.companyId, holdId, issueId: f.issueId, depth: 0, issueTitle: "Recover existing work", issueStatus: "blocked" });
    }
    if (gate === "cancelled") await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
    if (gate === "approval") {
      const approvalId = randomUUID();
      await db.insert(approvals).values({ id: approvalId, companyId: f.companyId, type: "hire_agent", status: "pending", payload: {} });
      await db.insert(issueApprovals).values({ companyId: f.companyId, issueId: f.issueId, approvalId });
    }
    if (gate === "budget") {
      await db.insert(budgetPolicies).values({ companyId: f.companyId, scopeType: "agent", scopeId: source.agentId,
        windowKind: "calendar_month_utc", amount: 100, hardStopEnabled: true });
      await db.insert(costEvents).values({ companyId: f.companyId, agentId: source.agentId,
        provider: "test", model: "test", costCents: 100, occurredAt: new Date(), billingType: "metered_api" });
    }
    if (gate === "reassigned") await db.update(issues).set({ assigneeAgentId: null, assigneeUserId: "board" }).where(eq(issues.id, f.issueId));
    const admission = heartbeatService(db).resumeRemoteStopComments(await run(f.runId));
    if (gate === "budget") await expect(admission).rejects.toThrow("budget hard-stop");
    else await admission;
    expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      sql`${heartbeatRuns.id} not in (${f.runId}::uuid, ${occupied.id}::uuid)`, inArray(heartbeatRuns.status, ["queued", "running"])))).toHaveLength(0);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queueId)))[0].runId).toBeNull();
    expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
  }, 30_000);

  it("keeps an unverified old copyback owner fenced without exposing a certification form", async () => {
    const f = await seed();
    const prior = { token: randomUUID(), hostname: "previous-controller", pid: 123, processStartedAt: new Date().toISOString() };
    const source = await run(f.runId);
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...source.runnerProfileJson, nativeWorkspaceFinalizationOwner: prior } }).where(eq(heartbeatRuns.id, f.runId));
    await recoverRetainedWorkspace(f.input);
    expect(f.runtime.resumeRunLease).not.toHaveBeenCalled();
    expect((await run(f.runId)).runnerProfileJson?.nativeWorkspaceFinalizationOwner).toEqual(prior);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ workspaceRepairRequired: true,
      workspaceRecovery: { status: "blocked", canRetry: false, message: expect.stringContaining("previous session stopped") } });
  }, 30_000);

  it("binds the first automatic repair to authoritative old-controller stop proof without an accepted result", async () => {
    const f = await seed("legacy");
    const worker = { provider: "railway" as const, projectId: randomUUID(), environmentId: randomUUID(), serviceId: randomUUID(), deploymentId: randomUUID() };
    const prior = { token: randomUUID(), hostname: "previous-controller", pid: 123, processStartedAt: new Date().toISOString(), worker };
    const source = await run(f.runId);
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...source.runnerProfileJson, nativeWorkspaceFinalizationOwner: prior } }).where(eq(heartbeatRuns.id, f.runId));
    // This is the verified platform boundary. Signature and identity validation
    // have independent coverage in native-workspace-platform-proof.test.ts.
    const proof = vi.spyOn(workerProof, "requestWorkspaceWorkerStopProof").mockResolvedValue({
      v: 1, iss: "paperclip-cloud", aud: "paperclip-workspace-worker-stop/v1", sub: "test-stack", stopped: true,
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 30,
      runId: f.runId, ownerToken: prior.token, worker,
    });
    try {
      await recoverRetainedWorkspace(f.input);
      expect(proof).toHaveBeenCalledWith({ runId: f.runId, ownerToken: prior.token, worker });
      expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
      expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.companyId, f.companyId))).toHaveLength(0);
    } finally { proof.mockRestore(); }
  }, 30_000);

  it("retries persistence after rollback without repeating or discarding the copied work", async () => {
    const f = await seed();
    const failCommit = vi.spyOn(activity, "persistActivity").mockRejectedValueOnce(new Error("Interrupted receipt transaction"));
    try { await recoverRetainedWorkspace(f.input); } finally { failCommit.mockRestore(); }
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
    expect(await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, f.companyId), eq(workspaceOperations.phase, "workspace_recovery")))).toHaveLength(0);
    expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
    const pending = await action(f.actionId);
    await db.update(issueRecoveryActions).set({ evidence: { ...pending.evidence, workspaceRecovery: { ...readWorkspaceRecovery(pending.evidence), retryAt: 0 } } }).where(eq(issueRecoveryActions.id, f.actionId));
    await recoverRetainedWorkspace(f.input);
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
  }, 30_000);

  it("keeps retry budgets durable and gives an idempotent user retry only one extra attempt", async () => {
    const f = await seed();
    f.runtime.resumeRunLease.mockRejectedValue(new Error("Temporary provider failure"));
    for (let attempt = 1; attempt <= 3; attempt++) {
      await recoverRetainedWorkspace(f.input);
      const current = await action(f.actionId);
      expect(readWorkspaceRecovery(current.evidence)?.attempt).toBe(attempt);
      await db.update(issueRecoveryActions).set({ evidence: { ...current.evidence, workspaceRecovery: { ...readWorkspaceRecovery(current.evidence), retryAt: 0 } } }).where(eq(issueRecoveryActions.id, f.actionId));
    }
    await recoverRetainedWorkspace(f.input);
    expect(f.runtime.resumeRunLease).toHaveBeenCalledTimes(3);
    const request = { ...f.input, idempotencyKey: randomUUID(), actorId: "board" };
    await requestWorkspaceRecovery(request); await requestWorkspaceRecovery(request);
    await recoverRetainedWorkspace(f.input); await recoverRetainedWorkspace(f.input);
    expect(f.runtime.resumeRunLease).toHaveBeenCalledTimes(4);
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)).toMatchObject({ status: "blocked", attempt: 4, attemptLimit: 4 });
  }, 30_000);

  it("discovers historical sources in the periodic sweep without creating a user request", async () => {
    const f = await seed("legacy"), onRecovered = vi.fn(async () => {});
    await expect.poll(async () => {
      await reconcileRetainedWorkspaces(db, f.input.environmentRuntime, onRecovered);
      return readWorkspaceRecovery((await action(f.actionId)).evidence)?.status;
    }, { timeout: 20_000 }).toBe("recovered");
    await expect.poll(() => onRecovered.mock.calls.length).toBeGreaterThan(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
  }, 30_000);

  it("uses the retained-source index rather than scanning unrelated recovery history", async () => {
    const f = await seed();
    await db.insert(issueRecoveryActions).values(Array.from({ length: 3000 }, (_, i) => ({
      companyId: f.companyId, sourceIssueId: f.issueId, status: "resolved", kind: "active_run_watchdog",
      cause: "unrelated_history", fingerprint: `history-${i}`, nextAction: "", evidence: {},
    })));
    await db.execute(sql`analyze ${issueRecoveryActions}`);
    const plan = await db.execute(sql`explain (analyze, format json) ${retainedWorkspaceCandidates(db)}`);
    expect(JSON.stringify(plan)).toContain("issue_recovery_actions_retained_workspace_recovery_idx");
    expect((await retainedWorkspaceCandidates(db)).length).toBeLessThanOrEqual(5);
  }, 30_000);

  it.each([false, true])("discovers a committed repair with unscheduled destruction without waiting input (reconciled: %s)", async reconciled => {
    const f = await seed();
    await recoverRetainedWorkspace(f.input);
    if (reconciled) {
      const current = await action(f.actionId);
      await db.update(issueRecoveryActions).set({ evidence: { ...current.evidence, executionReconciliation: { runId: f.runId } } }).where(eq(issueRecoveryActions.id, f.actionId));
    }
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0].status).toBe("released");
    const restarted = createDb(temporary.connectionString), onRecovered = vi.fn(async (_source: { id: string }) => {});
    try {
      await expect.poll(async () => {
        await reconcileRetainedWorkspaces(restarted, f.input.environmentRuntime, onRecovered);
        return (await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0].status;
      }, { timeout: 20_000 }).toBe("pending_cleanup");
      await expect.poll(() => onRecovered.mock.calls.filter(([source]) => source.id === f.runId).length).toBe(1);
      expect(await retainedWorkspaceCandidates(restarted)).not.toEqual(expect.arrayContaining([expect.objectContaining({ action: expect.objectContaining({ id: f.actionId }) })]));
      expect(f.runtime.resumeRunLease.mock.calls.filter(([input]) => input.lease.id === f.lease.id)).toHaveLength(1);
      expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
    } finally {
      await restarted.$client.end();
    }
  }, 30_000);
});
