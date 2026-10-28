import { prepareHeartbeatWorkspace } from "./heartbeat/workspace-preparation.js";
import { createHeartbeatWorkspaceResolver, resolveExecutionWorkspaceReuseRequestForIssue } from "./heartbeat/workspaces.js";
import { environmentService } from "./environments.js";
import { classifyEnvironmentCapabilities, environmentRuntimeService } from "./environment-runtime.js";
import { environmentRunOrchestrator } from "./environment-run-orchestrator.js";
import { executionWorkspaceService } from "./execution-workspaces.js";
import { workspaceOperationService } from "./workspace-operations.js";
import { instanceSettingsService } from "./instance-settings.js";
import { projectTaskInterruption } from "./task-interruption-presentation.js";
import { readSystemRecovery } from "./system-recovery-state.js";
import { adoptSystemRecovery } from "./system-recovery.js";
import { getStorageService } from "../storage/index.js";
import { attachPreservedWorkspaceSnapshots } from "./workspace-recovery-snapshot.js";
import { adoptHistoricalWorkspaceRecoveries, historicalRecoveryCounts } from "./workspace-recovery-backfill.js";
import { createSystemRecovery, failSystemRecovery, SystemRecoveryFailure } from "./system-recovery-state.js";
import { requestTaskRetry } from "./task-retry.js";
import { readFreshWorkspaceReadiness } from "./fresh-workspace-continuation.js";
import { execFile } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, approvals, budgetPolicies, costEvents, completionContracts, issueApprovals, issueTreeHolds, issueTreeHoldMembers, companies, createDb, applyPendingMigrations, environmentLeases, environments, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations, nativeRunResults, agentWakeupRequests, workspaceOperations } from "@paperclipai/db";
import { resumePreservedResultFinalization } from "./preserved-result-finalization.js";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { EnvironmentLease } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "../__tests__/helpers/external-test-database.js";
import { prepareNativeWorkspaceSync } from "./native-runtime/native-workspace-sync.js";
import { nativeWorkspaceFinalizationLockKey } from "./native-runtime/native-workspace-finalization-ownership.js";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { prepareStoppedSandboxForRecovery } from "./sandbox-stop-and-retain.js";
import { recoverRetainedWorkspace, requestWorkspaceRecovery, scheduleRecoveredWorkspaceCleanup, reconcileRetainedWorkspaces, retainedWorkspaceCandidates } from "./workspace-recovery.js";
import * as activity from "./activity-log.js";
import { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { registerWorkspaceRecoveryWork } from "./workspace-recovery-work.js";
import { heartbeatService } from "./heartbeat.js";
import { hasVerifiedWorkspaceRepair, readWorkspaceRecovery } from "./workspace-recovery-receipt.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import * as workerProof from "./native-runtime/native-workspace-platform-proof.js";
const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

describe("automatic retained workspace recovery", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  const priorHome = process.env.PAPERCLIP_HOME, priorInstance = process.env.PAPERCLIP_INSTANCE_ID;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "workspace-recovery-"));
    process.env.PAPERCLIP_HOME = path.join(root, "home"); process.env.PAPERCLIP_INSTANCE_ID = "recovery";
    const external = resolveExternalTestDatabaseUrl("PAPERCLIP_WORKSPACE_RECOVERY_TEST_DATABASE_URL");
    if (external) {
      await applyPendingMigrations(external);
      temporary = { connectionString: external, cleanup: async () => {} };
    } else temporary = await startEmbeddedPostgresTestDatabase("workspace-recovery-");
    db = createDb(temporary.connectionString);
    if (external) await db.execute(sql`TRUNCATE TABLE companies CASCADE`);
  }, 30_000);
  afterAll(async () => {
    await db?.$client.end(); await temporary?.cleanup(); await rm(root, { recursive: true, force: true });
    if (priorHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = priorHome;
    if (priorInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID; else process.env.PAPERCLIP_INSTANCE_ID = priorInstance;
  });
  async function seed(mode = "native", nativeDescriptor = true, resourceDisposition: "destroy" | "keep_running" = "destroy") {
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
      retryPendingSandboxTeardown: vi.fn(async () => ({ providerLeaseId, state: "stopped" })) };
    const environmentRuntime = environmentRuntimeService(db, { drivers: [{ driver: "sandbox",
      acquireRunLease: vi.fn(), releaseRunLease: vi.fn(), ...runtime,
      resolveCapabilities: async () => classifyEnvironmentCapabilities({ verifiedMethods: [], declared: null, narrowing: null }),
    }] });
    const input = { db, companyId, issueId, runId, actionId, environmentRuntime };
    return { ...input, input, runtime, host, remote, lease, providerLeaseId };
  }
  const action = async (id: string) => (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)))[0]!;
  const run = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;

  it.each(["HTTP Retry", "new comment", "automatic cleanup"] as const)("repairs an unregistered historical deadline failure through %s without admitting work before verified stop", async entry => {
    const f = await seed("native", true, "keep_running");
    const source = await run(f.runId);
    await db.update(heartbeatRuns).set({ resultJson: null, errorCode: "execution_finalization_deadline_exceeded" })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.update(environmentLeases).set({ status: "active", leasePolicy: "reuse_by_environment",
      releasedAt: null, cleanupStatus: null, metadata: f.lease.metadata }).where(eq(environmentLeases.id, f.lease.id));
    await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "blocked",
      cause: "execution_finalization_deadline_exceeded", evidence: { runId: f.runId, providerOwnership: "unverified",
        automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } }).where(eq(issueRecoveryActions.id, f.actionId));
    // Leave admission observable without substituting a fake model turn.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId, status: "running" });
    let releaseStop!: () => void;
    const stopped = new Promise<void>(resolve => { releaseStop = resolve; });
    f.runtime.retryPendingSandboxTeardown.mockImplementation(async () => {
      await stopped;
      return { providerLeaseId: f.providerLeaseId, state: "stopped" };
    });
    const errors = vi.fn(), heartbeat = heartbeatService(db, { environmentRuntime: f.environmentRuntime });
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: errors });
    const worker = registerWorkspaceRecoveryWork(db, coordinator, f.environmentRuntime, heartbeat.resumeRemoteStopComments);
    const successors = () => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    try {
      await worker.ready;
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: "board" }; next(); });
      app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1]));
      app.use(errorHandler);
      let requestId: string | undefined;
      let commentId: string | undefined;
      if (entry === "HTTP Retry") {
        const body = { idempotencyKey: randomUUID(), observedRunId: f.runId };
        const retry = await request(app).post(`/api/issues/${f.issueId}/retry`).send(body).expect(202);
        requestId = retry.body.requestId;
        expect((await request(app).post(`/api/issues/${f.issueId}/retry`).send(body).expect(202)).body.requestId).toBe(requestId);
      } else if (entry === "new comment") {
        const response = await request(app).post(`/api/issues/${f.issueId}/comments`)
          .send({ body: "Is this fixed?" }).expect(201);
        commentId = response.body.id;
        expect(await successors()).toHaveLength(0);
      } else {
        const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
          authorType: "user", authorUserId: "board", body: "Is this fixed?" }).returning();
        commentId = comment.id;
        const wake = { source: "automation" as const, triggerDetail: "system" as const,
          reason: "issue_reopened_via_comment", requestedByActorType: "user" as const, requestedByActorId: "board",
          payload: { issueId: f.issueId, commentId: comment.id, mutation: "comment" },
          contextSnapshot: { source: "issue.comment.reopen", issueId: f.issueId, wakeCommentId: comment.id },
        };
        await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: source.agentId,
          source: wake.source, triggerDetail: wake.triggerDetail, reason: wake.reason,
          requestedByActorType: "user", requestedByActorId: "board", status: "deferred_issue_execution",
          payload: { ...wake.payload, _paperclipWakeContext: { ...wake.contextSnapshot, wakeReason: wake.reason,
            wakeSource: wake.source, wakeTriggerDetail: wake.triggerDetail, wakeCommentIds: [comment.id] } },
        });
        expect(await successors()).toHaveLength(0);
        if (entry === "automatic cleanup") await heartbeat.sweepOrphanedActiveLeases({ backoffMs: 0 });
      }
      await expect.poll(() => f.runtime.retryPendingSandboxTeardown.mock.calls.length, { timeout: 20_000 }).toBe(1);
      if (requestId) await heartbeat.resumeTaskRetry(f.companyId, requestId);
      else await heartbeat.resumeQueuedRuns();
      expect(await successors()).toHaveLength(0);
      expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
      expect((await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id)))[0].metadata)
        .not.toHaveProperty("remoteExecutionTermination");
      await expect(readFile(path.join(f.host, "saved.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      releaseStop();
      await expect.poll(async () => (await successors()).length, { timeout: 20_000 }).toBe(1);
      const [successor] = await successors();
      if (commentId) expect(successor.contextSnapshot?.wakeCommentIds).toContain(commentId);
      expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
      expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
      expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
      if (requestId) expect(await readFreshWorkspaceReadiness(db, successor)).toMatchObject({ mode: "resume_preserved_workspace" });
      else expect(successor.contextSnapshot?.previousRunId).toBe(f.runId);
      await Promise.all([requestId ? heartbeat.resumeTaskRetry(f.companyId, requestId) : heartbeat.resumeQueuedRuns(),
        heartbeat.resumeRemoteStopComments(await run(f.runId))]);
      expect(await successors()).toHaveLength(1);
      expect(f.runtime.resumeRunLease).toHaveBeenCalledOnce();
      expect((await run(f.runId)).status).toBe("failed");
      const reloaded = await request(app).get(`/api/issues/${f.issueId}/recovery-actions`).expect(200);
      expect(reloaded.body.active).toBeNull();
      const records = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
      expect(records.some(record => readSystemRecovery(record.evidence)?.state === "complete")).toBe(true);
      expect(errors).not.toHaveBeenCalled();
    } finally { releaseStop(); await coordinator.stop(); await worker.stop(); }
  }, 40_000);

  it("wakes physical preservation from HTTP Retry before passive history without replaying the provider", async () => {
    for (let index = 0; index < 5; index++) {
      const old = await seed();
      await recoverRetainedWorkspace(old.input);
      await db.update(issueRecoveryActions).set({
        id: `00000000-000${index}-4000-8000-${randomUUID().slice(-12)}`,
      }).where(eq(issueRecoveryActions.id, old.actionId));
    }
    const f = await seed();
    await adoptSystemRecovery(db, f);
    const before = await action(f.actionId);
    const exhausted = failSystemRecovery(readSystemRecovery(before.evidence)!,
      new SystemRecoveryFailure("source_binding_invalid", "service_required"));
    await db.update(issueRecoveryActions).set({ cause: "native_workspace_sync_out_retry_exhausted",
      evidence: { ...before.evidence, systemRecovery: exhausted } })
      .where(eq(issueRecoveryActions.id, f.actionId));
    const errors = vi.fn();
    const competingCleanup = await retainedWorkspaceCandidates(db, undefined, false, true);
    expect(competingCleanup).toHaveLength(5);
    expect(competingCleanup.every(row => row.action.id.startsWith("00000000"))).toBe(true);
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: errors });
    const recovered = vi.fn(async () => {});
    const worker = registerWorkspaceRecoveryWork(db, coordinator, f.environmentRuntime, recovered);
    try {
      await worker.ready;
      await db.update(agents).set({ status: "paused" }).where(eq(agents.companyId, f.companyId));
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: "board" }; next(); });
      app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1]));
      app.use(errorHandler);
      const body = { idempotencyKey: randomUUID(), observedRunId: f.runId };
      const retry = await request(app).post(`/api/issues/${f.issueId}/retry`).send(body).expect(202);
      const repeated = await request(app).post(`/api/issues/${f.issueId}/retry`).send(body).expect(202);
      const coalesced = await request(app).post(`/api/issues/${f.issueId}/retry`)
        .send({ ...body, idempotencyKey: randomUUID() }).expect(202);
      expect(repeated.body.requestId).toBe(retry.body.requestId);
      expect(coalesced.body.requestId).toBe(retry.body.requestId);
      await expect.poll(async () => readSystemRecovery((await action(f.actionId)).evidence)?.state,
        { timeout: 20_000 }).toBe("complete");
      expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
      expect(f.runtime.resumeRunLease.mock.calls.filter(([input]) => input.lease.id === f.lease.id)).toHaveLength(1);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.companyId, f.companyId))).toHaveLength(0);
      const reloaded = await request(app).get(`/api/issues/${f.issueId}/recovery-actions`).expect(200);
      expect(JSON.stringify(reloaded.body)).toContain('"state":"complete"');
      expect(errors).not.toHaveBeenCalled();
    } finally { await coordinator.stop(); await worker.stop(); }
  }, 30_000);

  it("reconstructs a resolved files-only preservation obligation at startup without replay", async () => {
    const f = await seed("legacy");
    await adoptSystemRecovery(db, f);
    const before = await action(f.actionId);
    const automaticRecovery = { policy: "preserve_without_replay_v1", runId: f.runId, replay: "blocked" };
    await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "blocked",
      evidence: { ...before.evidence, automaticRecovery } }).where(eq(issueRecoveryActions.id, f.actionId));
    const errors = vi.fn();
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: errors });
    const worker = registerWorkspaceRecoveryWork(db, coordinator, f.environmentRuntime, async () => {});
    try {
      await worker.ready;
      await expect.poll(async () => readSystemRecovery((await action(f.actionId)).evidence)?.state,
        { timeout: 20_000 }).toBe("complete");
      expect((await action(f.actionId)).evidence.automaticRecovery).toEqual(automaticRecovery);
      expect(f.runtime.resumeRunLease.mock.calls.filter(([input]) => input.lease.id === f.lease.id)).toHaveLength(1);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
      expect(errors).not.toHaveBeenCalled();
    } finally { await coordinator.stop(); await worker.stop(); }
  }, 30_000);

  it("fills a free export slot across the candidate cursor while another export is held and joins both at shutdown", async () => {
    const orderedSeed = async (position: number) => {
      const fixture = await seed();
      const id = `00000002-000${position}-4000-8000-${randomUUID().slice(-12)}` as const;
      await db.update(issueRecoveryActions).set({ id }).where(eq(issueRecoveryActions.id, fixture.actionId));
      fixture.actionId = id; fixture.input.actionId = id;
      return fixture;
    };
    const held = await orderedSeed(2);
    const fixtures = [held];
    const runtimeFor = (runId: string) => fixtures.find(fixture => fixture.runId === runId)!.environmentRuntime;
    const runtime = { ...held.environmentRuntime,
      resumeWorkspaceRecoveryLease: (input: Parameters<typeof held.environmentRuntime.resumeWorkspaceRecoveryLease>[0]) =>
        runtimeFor(input.source.runId).resumeWorkspaceRecoveryLease(input),
      retryPendingSandboxTeardown: (input: Parameters<typeof held.environmentRuntime.retryPendingSandboxTeardown>[0]) =>
        runtimeFor(input.lease.heartbeatRunId!).retryPendingSandboxTeardown(input),
    };
    let active = 0, maximum = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const countExport = (fixture: typeof held, pause = false) => {
      const resume = fixture.runtime.resumeRunLease.getMockImplementation()!;
      fixture.runtime.resumeRunLease.mockImplementation(async input => {
        active += 1; maximum = Math.max(maximum, active);
        try { if (pause) await gate; return await resume(input); } finally { active -= 1; }
      });
    };
    countExport(held, true);
    const errors = vi.fn();
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: errors });
    const worker = registerWorkspaceRecoveryWork(db, coordinator, runtime, async () => {});
    try {
      await expect.poll(() => held.runtime.resumeRunLease.mock.calls.length, { timeout: 20_000 }).toBe(1);
      // Start the middle candidate only after the highest candidate occupies
      // one slot. The next producer then sorts before that saved cursor.
      const fast = await orderedSeed(1); fixtures.push(fast); countExport(fast);
      await requestTaskRetry({ db, companyId: fast.companyId, issueId: fast.issueId, actorId: "board",
        observedRunId: fast.runId, idempotencyKey: randomUUID() });
      await expect.poll(async () => readSystemRecovery((await action(fast.actionId)).evidence)?.state,
        { timeout: 20_000 }).toBe("complete");
      const third = await orderedSeed(0); fixtures.push(third); countExport(third);
      await requestTaskRetry({ db, companyId: third.companyId, issueId: third.issueId, actorId: "board",
        observedRunId: third.runId, idempotencyKey: randomUUID() });
      await expect.poll(async () => readSystemRecovery((await action(third.actionId)).evidence)?.state,
        { timeout: 20_000 }).toBe("complete");
      expect(readSystemRecovery((await action(held.actionId)).evidence)?.state).toBe("running");
      expect(maximum).toBeLessThanOrEqual(2);
      expect(await readFile(path.join(third.host, "saved.txt"), "utf8")).toBe("finished work\n");
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, third.companyId))).toHaveLength(1);
      let stopped = false;
      const stopping = Promise.all([coordinator.stop(), worker.stop()]).then(() => { stopped = true; });
      await Promise.resolve(); expect(stopped).toBe(false);
      release(); await stopping;
      expect(readSystemRecovery((await action(held.actionId)).evidence)?.state).toBe("complete");
      expect(errors).not.toHaveBeenCalled();
    } finally { release(); await coordinator.stop(); await worker.stop(); }
  }, 60_000);

  it("rotates past due sources whose physical locks belong to other workers", async () => {
    const blocked = [await seed(), await seed()], available = await seed();
    for (const [index, fixture] of [...blocked, available].entries()) {
      await adoptSystemRecovery(db, fixture);
      const id = `00000001-000${index}-4000-8000-${randomUUID().slice(-12)}` as const;
      await db.update(issueRecoveryActions).set({ id }).where(eq(issueRecoveryActions.id, fixture.actionId));
      fixture.actionId = id; fixture.input.actionId = id;
    }
    let unlock!: () => void;
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    const held = blocked.map(fixture => {
      let ready!: () => void;
      const acquired = new Promise<void>(resolve => { ready = resolve; });
      const lock = db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${nativeWorkspaceFinalizationLockKey(fixture.companyId, fixture.runId)}, 0))`);
        ready(); await gate;
      });
      return { acquired, lock };
    });
    try {
      await Promise.all(held.map(item => item.acquired));
      await Promise.all(await reconcileRetainedWorkspaces(db, available.environmentRuntime, async () => {}, true) ?? []);
      expect(blocked.every(fixture => fixture.runtime.resumeRunLease.mock.calls.length === 0)).toBe(true);
      await Promise.all(await reconcileRetainedWorkspaces(db, available.environmentRuntime, async () => {}, true) ?? []);
      expect(readSystemRecovery((await action(available.actionId)).evidence)?.state).toBe("complete");
      expect(await readFile(path.join(available.host, "saved.txt"), "utf8")).toBe("finished work\n");
      expect(blocked.every(fixture => fixture.runtime.resumeRunLease.mock.calls.length === 0)).toBe(true);
    } finally { unlock(); await Promise.all(held.map(item => item.lock)); }
  }, 30_000);

  it("coalesces Retry while preservation owns its physical operation", async () => {
    const f = await seed();
    await adoptSystemRecovery(db, f);
    const resume = f.runtime.resumeRunLease.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.runtime.resumeRunLease.mockImplementation(async input => { await gate; return resume(input); });
    const preserving = recoverRetainedWorkspace(f.input);
    let requestId: string | null | undefined;
    try {
      await expect.poll(() => f.runtime.resumeRunLease.mock.calls.length).toBe(1);
      const request = { db, companyId: f.companyId, issueId: f.issueId, actorId: "board",
        idempotencyKey: randomUUID(), observedRunId: f.runId };
      const first = await requestTaskRetry(request);
      requestId = first.requestId;
      const second = await requestTaskRetry({ ...request, idempotencyKey: randomUUID() });
      expect(second.requestId).toBe(first.requestId);
    } finally { release(); await preserving; }
    expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("complete");
    expect(readSystemRecovery((await action(f.actionId)).evidence)?.intentId).toBe(requestId);
    expect(f.runtime.resumeRunLease.mock.calls.filter(([input]) => input.lease.id === f.lease.id)).toHaveLength(1);
    expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
  }, 30_000);

  it("adopts only the exact historical infrastructure notice, preserving prose and user-action notices", async () => {
    const f = await seed("legacy", false);
    const metadata = { version: 1 as const, sourceRunId: f.runId,
      sections: [{ rows: [{ type: "key_value" as const, label: "Recovery action", value: f.actionId }] }] };
    const base = { companyId: f.companyId, issueId: f.issueId, body: "Original technical history",
      authorType: "system" as const, presentation: { kind: "system_notice" as const, tone: "danger" as const,
        title: "Recovery needs attention", detailsDefaultOpen: false }, metadata };
    const comments = await db.insert(issueComments).values([
      base,
      { ...base, authorType: "user", authorUserId: "board" },
      { ...base, metadata: { ...metadata, sourceRunId: randomUUID() } },
      { ...base, metadata: { ...metadata, recoveryResponsibility: "user" as const } },
    ]).returning();
    await adoptSystemRecovery(db, f);
    await adoptSystemRecovery(db, f);
    const rows = await db.select().from(issueComments).where(eq(issueComments.companyId, f.companyId));
    expect(rows.find(row => row.id === comments[0].id)?.metadata?.recoveryResponsibility).toBe("system");
    for (const original of comments.slice(1)) {
      expect(rows.find(row => row.id === original.id)?.metadata).toEqual(original.metadata);
    }
    expect(rows.every(row => row.body === base.body)).toBe(true);
  });

  async function makeRetryDue(actionId: string) {
    const current = await action(actionId);
    const state = readSystemRecovery(current.evidence)!;
    await db.update(issueRecoveryActions).set({ evidence: { ...current.evidence,
      systemRecovery: { ...state, nextAttemptAt: 0 } } }).where(eq(issueRecoveryActions.id, actionId));
  }

  it("re-enters only the existing finalizer for an accepted result, once per intent, preserving failure history", async () => {
    const f = await seed();
    const contractId = randomUUID(), resultId = randomUUID();
    await db.insert(completionContracts).values({ id: contractId, companyId: f.companyId, issueId: f.issueId,
      revision: 1, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
      completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: {}, canonicalSha256: "contract", createdByActorType: "system", createdByActorId: "test" });
    await db.update(heartbeatRuns).set({ completionContractId: contractId }).where(eq(heartbeatRuns.id, f.runId));
    await db.insert(nativeRunResults).values({ id: resultId, companyId: f.companyId, issueId: f.issueId, runId: f.runId,
      completionContractId: contractId, schemaStatus: "accepted", serverFingerprint: "result", canonicalSha256: "result",
      resultJson: { terminal: { runTerminalState: "succeeded" } } });
    await db.update(nativeRunFinalizations).set({ resultId, attempt: 3, failureCode: "native_workspace_sync_out_retry_exhausted" })
      .where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await resumePreservedResultFinalization(db, f.companyId, f.runId)).toBe(false);
    await recoverRetainedWorkspace(f.input);
    const attempts = await Promise.all([resumePreservedResultFinalization(db, f.companyId, f.runId),
      resumePreservedResultFinalization(db, f.companyId, f.runId)]);
    expect(attempts.filter(Boolean)).toHaveLength(1);
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(coordinator).toMatchObject({ phase: "workspace_finalizing", resultId, attempt: 3 });
    expect(coordinator.recoveryHistory).toEqual([expect.objectContaining({
      kind: "preserved_result_finalization", previousFailureCode: "native_workspace_sync_out_retry_exhausted",
    })]);
    expect(await run(f.runId)).toMatchObject({ status: "failed", errorCode: "execution_interrupted" });
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure" }).where(eq(nativeRunFinalizations.runId, f.runId));
    expect(await resumePreservedResultFinalization(db, f.companyId, f.runId)).toBe(false);
    const retry = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "board",
      idempotencyKey: randomUUID(), observedRunId: f.runId });
    expect(await resumePreservedResultFinalization(db, f.companyId, f.runId)).toBe(true);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, retry.requestId!)))[0])
      .toMatchObject({ status: "coalesced", runId: f.runId, payload: { taskRetry: { strategy: "finalize_result" } } });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.companyId, f.companyId))).toHaveLength(1);
  }, 30_000);

  it("preserves a historical legacy source without manufacturing a native descriptor or overwriting current files", async () => {
    const f = await seed("legacy", false);
    await recoverRetainedWorkspace(f.input);
    const operations = await db.select().from(workspaceOperations).where(and(
      eq(workspaceOperations.heartbeatRunId, f.runId), eq(workspaceOperations.phase, "workspace_recovery_snapshot"),
      eq(workspaceOperations.status, "succeeded"),
    ));
    expect(operations).toHaveLength(1);
    expect(operations[0].metadata).toMatchObject({ leaseId: f.lease.id, providerLeaseId: f.providerLeaseId });
    const fresh = path.join(root, randomUUID()); await mkdir(fresh);
    const attached = await attachPreservedWorkspaceSnapshots({ db, companyId: f.companyId, issueId: f.issueId,
      sourceRunIds: [f.runId], cwd: fresh });
    expect(await readFile(path.join(attached[0].path, "files", "saved.txt"), "utf8")).toBe("finished work\n");
    expect(await readFile(path.join(attached[0].path, "provenance.json"), "utf8")).toContain(f.runId);
    expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
    expect((await run(f.runId)).runnerProfileJson?.nativeWorkspaceSync).toBeUndefined();
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    expect((await run(f.runId)).status).toBe("failed");
  }, 30_000);

  it("keeps earlier recovered snapshots readable across repeated fresh retries", async () => {
    const f = await seed("legacy", false);
    await recoverRetainedWorkspace(f.input);
    const source = await run(f.runId);
    const replacementId = randomUUID(), laterId = randomUUID(), intentId = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: replacementId, companyId: f.companyId, agentId: source.agentId,
        status: "failed", contextSnapshot: { issueId: f.issueId } },
      { id: laterId, companyId: f.companyId, agentId: source.agentId,
        status: "failed", retryOfRunId: replacementId, contextSnapshot: { issueId: f.issueId } },
    ]);
    await db.insert(agentWakeupRequests).values({
      id: intentId, companyId: f.companyId, agentId: source.agentId, runId: replacementId,
      source: "on_demand", triggerDetail: "manual", reason: "task_retry", status: "coalesced",
      requestedByActorType: "user", requestedByActorId: "owner-user",
      payload: { issueId: f.issueId, taskRetry: { schema: "paperclip.task-retry.v1",
        generationId: intentId, sourceRunId: f.runId, actorId: "owner-user", strategy: "fresh_isolated_workspace" } },
    });
    const first = path.join(root, randomUUID()), next = path.join(root, randomUUID());
    await mkdir(first); await mkdir(next);
    await attachPreservedWorkspaceSnapshots({ db, companyId: f.companyId, issueId: f.issueId,
      sourceRunIds: [f.runId], cwd: first });
    const attached = await attachPreservedWorkspaceSnapshots({ db, companyId: f.companyId, issueId: f.issueId,
      sourceRunIds: [laterId], cwd: next });
    expect(attached).toHaveLength(1);
    expect(attached[0].sourceRunId).toBe(f.runId);
    expect(await readFile(path.join(attached[0].path, "files", "saved.txt"), "utf8")).toBe("finished work\n");
    expect(await readFile(path.join(attached[0].path, "provenance.json"), "utf8")).toContain(f.runId);
    expect(await attachPreservedWorkspaceSnapshots({ db, companyId: f.companyId, issueId: randomUUID(),
      sourceRunIds: [laterId], cwd: next })).toEqual([]);
  }, 30_000);

  it("reconciles an uploaded snapshot after a lost upload acknowledgement without exporting again", async () => {
    const f = await seed("legacy", false);
    const target = targets.get(f.lease.id)!;
    const exportFiles = vi.spyOn(target.runner!, "syncOut");
    const storage = getStorageService(), put = storage.putFile.bind(storage);
    let uploads = 0;
    const lostReply = vi.spyOn(storage, "putFile").mockImplementation(async input => {
      const receipt = await put(input);
      if (++uploads === 2) throw new Error("Lost upload acknowledgement");
      return receipt;
    });
    try { await recoverRetainedWorkspace(f.input); } finally { lostReply.mockRestore(); }
    const [pending] = await db.select().from(workspaceOperations).where(and(
      eq(workspaceOperations.heartbeatRunId, f.runId), eq(workspaceOperations.phase, "workspace_recovery_snapshot")));
    expect(pending.status).toBe("running");
    expect(uploads).toBe(2);
    await makeRetryDue(f.actionId);
    const restarted = createDb(temporary.connectionString);
    try { await recoverRetainedWorkspace({ ...f.input, db: restarted }); }
    finally { await restarted.$client.end(); }
    const operations = await db.select().from(workspaceOperations).where(and(
      eq(workspaceOperations.heartbeatRunId, f.runId), eq(workspaceOperations.phase, "workspace_recovery_snapshot")));
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ id: pending.id, status: "succeeded", metadata: pending.metadata });
    expect(exportFiles).toHaveBeenCalledTimes(1);
    expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
    expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
    exportFiles.mockRestore();
  }, 30_000);

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
    expect(f.runtime.resumeRunLease.mock.calls.filter(([input]) => input.lease.id === f.lease.id)).toHaveLength(1);
    expect(await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, f.companyId), eq(workspaceOperations.phase, "workspace_recovery")))).toHaveLength(1);
  }, 30_000);

  it("recovers a protected retained source through the assembled environment runtime", async () => {
    const f = await seed();
    await db.update(environmentLeases).set({ metadata: { ...f.lease.metadata,
      workspaceRestoreRecovery: { schema: "paperclip.workspace-restore-recovery.v1", runId: f.runId },
      remoteExecutionTermination: remoteTerminationReceipt(f.lease, { providerLeaseId: f.providerLeaseId, state: "stopped" }),
    } }).where(eq(environmentLeases.id, f.lease.id));
    const runtime = f.input.environmentRuntime;
    const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    const [environment] = await db.select().from(environments).where(eq(environments.id, lease.environmentId!));
    expect(await runtime.resumeRunLease({ environment: environment as never, lease: lease as EnvironmentLease })).toBeNull();
    expect(f.runtime.resumeRunLease).not.toHaveBeenCalled();
    await recoverRetainedWorkspace({ ...f.input, environmentRuntime: runtime });
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)?.status).toBe("recovered");
    expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
    expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
    expect(f.runtime.resumeRunLease.mock.calls.filter(([input]) => input.lease.id === f.lease.id)).toHaveLength(1);
    await recoverRetainedWorkspace({ ...f.input, environmentRuntime: runtime });
    expect(f.runtime.resumeRunLease.mock.calls.filter(([input]) => input.lease.id === f.lease.id)).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
  }, 30_000);

  it.each(["changed_claim", "missing_stop_intent", "wrong_lease", "wrong_environment"])(
    "does not reopen a retained source without exact recovery authority: %s", async kind => {
      const f = await seed();
      const runtime = f.input.environmentRuntime;
      const resume = runtime.resumeWorkspaceRecoveryLease.bind(runtime);
      vi.spyOn(runtime, "resumeWorkspaceRecoveryLease").mockImplementationOnce(async input => {
        if (kind === "changed_claim") await db.update(environmentLeases).set({ metadata: sql`
          ${environmentLeases.metadata} || '{"pendingCleanupAttemptId":"other-owner"}'::jsonb`
        }).where(eq(environmentLeases.id, f.lease.id));
        if (kind === "missing_stop_intent") await db.update(environmentLeases).set({ metadata: sql`
          ${environmentLeases.metadata} - 'sandboxStopAndRetain'`
        }).where(eq(environmentLeases.id, f.lease.id));
        return resume({ ...input,
          ...(kind === "wrong_lease" ? { leaseId: randomUUID() } : {}),
          ...(kind === "wrong_environment" ? { environmentId: randomUUID() } : {}),
        });
      });
      await recoverRetainedWorkspace(f.input);
      expect(readSystemRecovery((await action(f.actionId)).evidence)?.failure?.code).toBe("source_binding_invalid");
      expect(f.runtime.resumeRunLease).not.toHaveBeenCalled();
      expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    }, 30_000);

  it("keeps verified copyback files in the preserved workspace on ordinary Retry", async () => {
    const f = await seed();
    await recoverRetainedWorkspace(f.input);
    const source = await run(f.runId);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId, status: "running" });
    const request = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "local-board", actorSource: "local_implicit",
      observedRunId: source.id, idempotencyKey: randomUUID() });
    await heartbeatService(db).resumeTaskRetry(f.companyId, request.requestId!);
    const [successor] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    expect(successor).toBeDefined();
    const [receipt] = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.heartbeatRunId, f.runId),
      eq(workspaceOperations.phase, "workspace_recovery"), eq(workspaceOperations.status, "succeeded")));
    const readiness = await readFreshWorkspaceReadiness(db, successor);
    expect(readiness).toEqual({ mode: "resume_preserved_workspace", preservationReceiptId: receipt.id });
    const [agent] = await db.select().from(agents).where(eq(agents.id, source.agentId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const localEnvironment = await environmentService(db).ensureLocalEnvironment(f.companyId);
    const prepared = await prepareHeartbeatWorkspace(db, {
      run: successor, agent,
      task: { issueRef: issue, issueId: f.issueId, context: { issueId: f.issueId }, responsibleUserId: "local-board",
        previousSessionParams: null, freshWorkspace: readiness },
      policy: { trustPreset: { kind: "standard", preset: "standard", boundary: null, sourcePresets: {} },
        isolatedWorkspacesEnabled: false, effectiveExecutionWorkspaceMode: "shared_workspace",
        requestedExecutionWorkspaceMode: "shared_workspace", useIsolatedTaskDirectory: false,
        nativeChatWorkspaceScope: null, projectExecutionWorkspacePolicy: null, issueExecutionWorkspaceSettings: null,
        environmentExecutionWorkspaceSettings: null, executionPolicy: { executionMode: "any" } },
      environment: { selectedEnvironmentId: localEnvironment.id, localEnvironment, selectedEnvironmentForConfig: localEnvironment,
        environmentResolution: { environmentId: localEnvironment.id, source: "default" },
        resolvedInstanceSettings: await instanceSettingsService(db).get() },
      config: { mergedConfig: { cwd: f.host }, configSnapshot: null, secretManifest: [] },
      reuse: { requestedShouldReuseExisting: false, existingExecutionWorkspace: null, reusableExistingExecutionWorkspace: null,
        workspaceReuseRequest: resolveExecutionWorkspaceReuseRequestForIssue({ issueExecutionWorkspaceId: null,
          issueExecutionWorkspacePreference: null, existingExecutionWorkspaceStatus: null }),
        nativeRecoveryExecutionWorkspaceId: null, persistedNativeExecutionInput: null, isDotRun: false, runOptions: {} },
      services: { envOrchestrator: environmentRunOrchestrator(db), executionWorkspacesSvc: executionWorkspaceService(db),
        workspaceOperationsSvc: workspaceOperationService(db), ...createHeartbeatWorkspaceResolver(db), appendRunEvent: vi.fn() },
      controllerLease: { assertOwned: vi.fn(async () => {}) }, nativeRunnerPreparationSpans: [],
    });
    expect(prepared.executionWorkspace.cwd).toBe(f.host);
    expect(await readFile(path.join(prepared.executionWorkspace.cwd, "saved.txt"), "utf8")).toBe("finished work\n");
    expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, request.requestId!));
    expect(wake.payload?.taskRetry).toMatchObject({ strategy: "continue" });
  }, 30_000);

  it("projects active preservation without waiting input as working, and stale observations as failed", async () => {
    const f = await seed();
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const state = { ...createSystemRecovery(f.runId), state: "running" as const };
    const recovery = { ...await action(f.actionId), evidence: { systemRecovery: state, systemRecoveryActiveAt: Date.now() } };
    const input = { run: await run(f.runId), action: recovery, paused: false, approval: false };
    expect(projectTaskInterruption(issue, input)).toMatchObject({ state: "working", intentId: null, canRetry: false });
    expect(projectTaskInterruption(issue, input, Date.now() + 60_000)).toMatchObject({ state: "failed", canRetry: true });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
  });

  it.each([["native_provider_model_rejected", "choose_model"], ["native_provider_approval_required", "approval"]] as const)(
    "projects %s as the meaningful user action %s", async (errorCode, userAction) => {
      const f = await seed();
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(projectTaskInterruption(issue, { run: { ...await run(f.runId), errorCode }, paused: false, approval: false }))
        .toMatchObject({ state: "waiting_for_user", responsibility: "user", userAction, canRetry: false });
    });

  it("serializes concurrent repairs through the physical workspace lock", async () => {
    const f = await seed(); let ready!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    f.runtime.resumeRunLease.mockImplementationOnce(async () => { ready(); await gate; return { providerLeaseId: f.providerLeaseId, metadata: { remoteCwd: f.remote } }; });
    const first = recoverRetainedWorkspace(f.input);
    await started;
    try { await recoverRetainedWorkspace(f.input); expect(f.runtime.resumeRunLease.mock.calls.filter(([input]) => input.lease.id === f.lease.id)).toHaveLength(1); }
    finally { release(); await first; }
    expect(readWorkspaceRecovery((await action(f.actionId)).evidence)?.status).toBe("recovered");
  }, 30_000);

  it.each(["missing_stop", "wrong_stop", "another_owner", "active_writer", "invalid_descriptor"])("retains the source and starts no provider for %s", async kind => {
    const f = await seed();
    if (kind === "missing_stop" || kind === "wrong_stop") await db.update(environmentLeases).set({ metadata: { ...f.lease.metadata,
      ...(kind === "wrong_stop" ? { remoteExecutionTermination: remoteTerminationReceipt({ ...f.lease, id: randomUUID() }, { providerLeaseId: f.providerLeaseId, state: "stopped" }) } : {}) } }).where(eq(environmentLeases.id, f.lease.id));
    if (kind === "missing_stop" || kind === "wrong_stop") f.runtime.retryPendingSandboxTeardown.mockResolvedValue({ providerLeaseId: randomUUID(), state: "unknown" });
    if (kind === "another_owner") await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.runId, provider: "daytona", providerLeaseId: f.providerLeaseId });
    if (kind === "active_writer") await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.lease.heartbeatRunId ? (await run(f.runId)).agentId : "", status: "running", nativeIssueId: f.issueId });
    if (kind === "invalid_descriptor") await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: { schema: "corrupt" } } }).where(eq(heartbeatRuns.id, f.runId));
    await recoverRetainedWorkspace(f.input);
    expect(readSystemRecovery((await action(f.actionId)).evidence)).toMatchObject({ state:
      ["missing_stop", "wrong_stop", "active_writer"].includes(kind) ? "awaiting_evidence" : "exhausted" });
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
      systemRecovery: { ...readSystemRecovery(pending.evidence), nextAttemptAt: 0 } } }).where(eq(issueRecoveryActions.id, f.actionId));
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
      systemRecovery: { ...readSystemRecovery(pending.evidence), nextAttemptAt: 0 } } }).where(eq(issueRecoveryActions.id, f.actionId));
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

  it.each([false, true])("adopts exact retained leases without a run descriptor (existing action: %s)", async existingAction => {
    const f = await seed("legacy", false);
    await db.update(heartbeatRuns).set({ resultJson: null }).where(eq(heartbeatRuns.id, f.runId));
    if (existingAction) await db.update(issueRecoveryActions).set({ evidence: { runId: f.runId } })
      .where(eq(issueRecoveryActions.id, f.actionId));
    else await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId));
    await adoptHistoricalWorkspaceRecoveries(db);
    const [adopted] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId));
    expect(adopted.evidence.historicalWorkspaceSource).toMatchObject({ runId: f.runId, leaseIds: [f.lease.id] });
    const generation = readSystemRecovery(adopted.evidence)!.generationId;
    expect(await recoverRetainedWorkspace({ ...f.input, actionId: adopted.id })).toBeUndefined();
    expect(readSystemRecovery((await action(adopted.id)).evidence)?.state).toBe("complete");
    await adoptHistoricalWorkspaceRecoveries(db);
    expect(readSystemRecovery((await action(adopted.id)).evidence)?.generationId).toBe(generation);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
  });

  it.each(["native", "legacy", "native_export", "legacy_snapshot", "native_snapshot"])("delivers only saved user input once through ordinary admission: %s", async mode => {
    const f = await seed(mode.startsWith("legacy") ? "legacy" : "native", !mode.endsWith("_snapshot")), commentId = randomUUID(), queueId = randomUUID();
    if (mode === "native_snapshot") {
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeWorkspaceSync: {
        schema: "paperclip.native-workspace-sync/v3", state: "prepared", descriptorSha256: "a".repeat(64),
        baselineSha256: "b".repeat(64), finalHostSha256: null, workspaceId: f.issueId,
        leaseId: f.lease.id, providerLeaseId: f.providerLeaseId, remoteCwd: f.remote, resourceDisposition: "destroy",
      } } }).where(eq(heartbeatRuns.id, f.runId));
      await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
        kind: "active_run_watchdog", status: "resolved", ownerType: "system", outcome: "blocked",
        cause: "execution_finalization_deadline_exceeded", fingerprint: randomUUID(), nextAction: "Inspect original failure",
        evidence: { runId: f.runId, automaticRecovery: { replay: "blocked" } } });
    }
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
    if (mode.endsWith("_snapshot")) {
      expect(await readFreshWorkspaceReadiness(db, turns[0])).toMatchObject({
        mode: "fresh_isolated_workspace", retryIntentId: queueId, sourceRunId: f.runId, retainedSourceIds: [f.lease.id] });
      const fresh = path.join(root, randomUUID()); await mkdir(fresh);
      const attached = await attachPreservedWorkspaceSnapshots({ db, companyId: f.companyId, issueId: f.issueId,
        sourceRunIds: [turns[0].id], cwd: fresh });
      expect(attached).toHaveLength(1);
      expect(await readFile(path.join(attached[0].path, "files", "saved.txt"), "utf8")).toBe("finished work\n");
      expect(await readFile(path.join(f.host, "newer.txt"), "utf8")).toBe("newer local work\n");
      expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
      if (mode === "native_snapshot") expect((await run(f.runId)).runnerProfileJson?.nativeWorkspaceSync)
        .toMatchObject({ state: "prepared", finalHostSha256: null });
    }
  }, 30_000);

  it.each(["copyback_unknown", "source_unavailable", "executor_unknown"])("ordinary task Retry evaluates fresh isolation independently: %s", async failure => {
    const f = await seed("legacy", false);
    const source = await run(f.runId);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId, status: "running" });
    if (failure === "copyback_unknown") await db.update(heartbeatRuns).set({ runnerProfileJson: {
      ...source.runnerProfileJson, nativeWorkspaceFinalizationOwner: {
        token: randomUUID(), hostname: "previous-controller", pid: 123, processStartedAt: new Date().toISOString(),
      },
    } }).where(eq(heartbeatRuns.id, f.runId));
    else f.runtime.resumeRunLease.mockRejectedValue(new Error("Provider source unavailable"));
    await recoverRetainedWorkspace(f.input);
    if (failure === "executor_unknown") await db.update(environmentLeases).set({
      metadata: sql`${environmentLeases.metadata} - 'remoteExecutionTermination'`,
    }).where(eq(environmentLeases.id, f.lease.id));
    const commentId = randomUUID(), queueId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId: f.companyId, issueId: f.issueId,
      authorType: "user", authorUserId: "local-board", body: "Use the completed result. Do not publish it again." });
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId: f.companyId, agentId: source.agentId,
      source: "on_demand", reason: "issue_commented", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: "local-board",
      payload: { issueId: f.issueId, commentId, _paperclipWakeContext: { issueId: f.issueId,
        wakeReason: "issue_commented", wakeCommentIds: [commentId], wakeCommentId: commentId } } });
    const request = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "local-board",
      actorSource: "local_implicit", observedRunId: f.runId, idempotencyKey: randomUUID() });
    const heartbeat = heartbeatService(db);
    await Promise.all([heartbeat.resumeTaskRetry(f.companyId, request.requestId!), heartbeat.resumeTaskRetry(f.companyId, request.requestId!)]);
    const turns = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
    expect(turns).toHaveLength(failure === "executor_unknown" ? 0 : 1);
    if (turns[0]) {
      expect(turns[0].contextSnapshot?.wakeCommentIds).toEqual([commentId]);
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queueId)))[0])
        .toMatchObject({ runId: turns[0].id, status: "coalesced" });
      expect(await readFreshWorkspaceReadiness(db, turns[0])).toMatchObject({ mode: "fresh_isolated_workspace", retryIntentId: request.requestId });
      // A restarted dispatch worker finds the same run and cannot create another.
      await heartbeatService(db).resumeTaskRetry(f.companyId, request.requestId!);
      expect(await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")))).toHaveLength(1);
    }
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
    expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
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

  it.each(["single", "multiple", "interrupted"])("continues an existing Retry after signed absence evidence for every retained allocation: %s", async mode => {
    const count = mode === "single" ? 1 : 2;
    const f = await seed();
    const leaseIds = [f.lease.id];
    if (count === 2) {
      const [additional] = await db.insert(environmentLeases).values({ ...f.lease, id: randomUUID(),
        providerLeaseId: randomUUID(), status: "pending_cleanup", cleanupStatus: "failed", releasedAt: null }).returning();
      leaseIds.push(additional.id);
      const recovery = { schema: "paperclip.workspace-restore-recovery.v1", leaseIds };
      await db.update(heartbeatRuns).set({ resultJson: sql`${heartbeatRuns.resultJson} || ${JSON.stringify({ workspaceRestoreRecovery: recovery })}::jsonb` })
        .where(eq(heartbeatRuns.id, f.runId));
      await db.update(issueRecoveryActions).set({ evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify({ workspaceRestoreRecovery: recovery })}::jsonb` })
        .where(eq(issueRecoveryActions.id, f.actionId));
    }
    const source = await run(f.runId);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId, status: "running" });
    const [stoppedLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
    expect(await prepareStoppedSandboxForRecovery(db, stoppedLease)).not.toBeNull();
    f.runtime.resumeRunLease.mockRejectedValue(new Error("retained allocation unavailable"));
    f.runtime.retryPendingSandboxTeardown.mockRejectedValue(new Error("retained allocation unavailable"));
    const request = await requestTaskRetry({ db, companyId: f.companyId, issueId: f.issueId, actorId: "local-board",
      actorSource: "local_implicit", observedRunId: f.runId, idempotencyKey: randomUUID() });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    vi.stubEnv("PAPERCLIP_CLOUD_STACK_ID", "fixture-stack");
    vi.stubEnv("PAPERCLIP_CLOUD_API_ORIGIN", "https://cloud.example");
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "fixture-token");
    vi.stubEnv("PAPERCLIP_PRIMARY_HOST", "fixture.paperclip.test");
    vi.stubEnv("PAPERCLIP_AUTH_SECRET", "fixture-auth-secret");
    vi.stubEnv("PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS", JSON.stringify({ keys: [{
      ...publicKey.export({ format: "jwk" }), kid: "absence-test", alg: "EdDSA", use: "sig",
    }] }));
    const originalFetch = globalThis.fetch;
    const observed: string[] = [];
    let interrupted = mode === "interrupted";
    const fetchProof = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (!String(url).endsWith("/v1/tenant/sandbox-absence")) return originalFetch(url, init);
      const binding = JSON.parse(String(init?.body));
      observed.push(binding.leaseId);
      if (mode === "interrupted" && binding.leaseId === f.lease.id && observed.length > 2) return new Response(null, { status: 503 });
      if (interrupted && binding.leaseId !== f.lease.id) return new Response(null, { status: 503 });
      const seconds = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "paperclip-sandbox-absence+jwt", kid: "absence-test" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ v: 1, iss: "paperclip-cloud", aud: "paperclip-sandbox-absence/v1",
        sub: "fixture-stack", ...binding, absent: true, iat: seconds, exp: seconds + 60 })).toString("base64url");
      return Response.json({ receipt: `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString("base64url")}` });
    });
    try {
      await recoverRetainedWorkspace(f.input);
      if (interrupted) {
        expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).not.toBe("exhausted");
        interrupted = false;
        await makeRetryDue(f.actionId);
        await recoverRetainedWorkspace(f.input);
      }
      const leases = await db.select().from(environmentLeases).where(inArray(environmentLeases.id, leaseIds));
      expect(leases).toHaveLength(count);
      expect(observed).toEqual(mode === "interrupted" ? [leaseIds[0], leaseIds[1], leaseIds[1]] : leaseIds);
      for (const lease of leases) expect(lease).toMatchObject({ status: "released", cleanupStatus: "success",
        metadata: { remoteExecutionTermination: { state: "destroyed" } } });
      expect(readSystemRecovery((await action(f.actionId)).evidence)).toMatchObject({
        state: "exhausted", failure: { code: "source_unavailable", retryClass: "use_alternative_strategy" },
      });
      expect(f.runtime.resumeRunLease).not.toHaveBeenCalled();
      expect(f.runtime.retryPendingSandboxTeardown).not.toHaveBeenCalled();
      expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(false);
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.companyId, f.companyId))).toHaveLength(0);
      const heartbeat = heartbeatService(db);
      await Promise.all([heartbeat.resumeTaskRetry(f.companyId, request.requestId!), heartbeat.resumeTaskRetry(f.companyId, request.requestId!)]);
      const turns = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "queued")));
      expect(turns).toHaveLength(1);
      expect(await readFreshWorkspaceReadiness(db, turns[0])).toMatchObject({ mode: "fresh_isolated_workspace", retryIntentId: request.requestId });
      expect((await run(f.runId)).status).toBe("failed");
      expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
    } finally { fetchProof.mockRestore(); vi.unstubAllEnvs(); }
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
      workspaceRecovery: { status: "queued", canRetry: false } });
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
    expect(await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, f.companyId), eq(workspaceOperations.phase, "workspace_recovery")))).toHaveLength(1);
    expect(await readFile(path.join(f.host, "saved.txt"), "utf8")).toBe("finished work\n");
    const pending = await action(f.actionId);
    await db.update(issueRecoveryActions).set({ evidence: { ...pending.evidence, systemRecovery: { ...readSystemRecovery(pending.evidence), nextAttemptAt: 0 } } }).where(eq(issueRecoveryActions.id, f.actionId));
    await recoverRetainedWorkspace(f.input);
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
  }, 30_000);

  it("persists six automatic attempts and admits one new generation per deliberate retry", async () => {
    const f = await seed();
    f.runtime.resumeRunLease.mockRejectedValue(new Error("Temporary provider failure"));
    for (let attempt = 1; attempt <= 6; attempt++) {
      await recoverRetainedWorkspace(f.input);
      expect(readSystemRecovery((await action(f.actionId)).evidence)?.attempts).toBe(attempt);
      if (attempt < 6) await makeRetryDue(f.actionId);
    }
    await recoverRetainedWorkspace(f.input);
    expect(f.runtime.resumeRunLease).toHaveBeenCalledTimes(6);
    expect(readSystemRecovery((await action(f.actionId)).evidence)?.state).toBe("exhausted");
    const before = readSystemRecovery((await action(f.actionId)).evidence)!;
    const request = { ...f.input, idempotencyKey: randomUUID(), actorId: "board" };
    await requestWorkspaceRecovery(request); await requestWorkspaceRecovery(request);
    await recoverRetainedWorkspace(f.input); await recoverRetainedWorkspace(f.input);
    const after = readSystemRecovery((await action(f.actionId)).evidence)!;
    expect(f.runtime.resumeRunLease).toHaveBeenCalledTimes(7);
    expect(after.generationId).not.toBe(before.generationId);
    expect(after.attempts).toBe(1);
    expect(after.revision).toBeGreaterThan(before.revision);
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
    await adoptHistoricalWorkspaceRecoveries(db);
    const plan = await db.execute(sql`explain (analyze, format json) ${retainedWorkspaceCandidates(db)}`);
    expect(JSON.stringify(plan)).toContain("issue_recovery_actions_system_recovery_due_idx");
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
