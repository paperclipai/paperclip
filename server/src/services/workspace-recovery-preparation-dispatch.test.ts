import { nextWorkspaceRecoveryAt } from "./system-recovery.js";
import { notifyDeferredExecutionEligibility } from "./deferred-execution-notifications.js";
import { isPreDispatchExecutionWaitVerified } from "./pre-dispatch-execution-wait.js";
import { heartbeatRunEvents, companyObservability, executionWorkspaceRepositories, issueWorkProducts, authUsers, companyMemberships, agents, createDb, environments, heartbeatRuns, issueRecoveryActions, issues, nativeRunResults, executionWorkspaces } from "@paperclipai/db";
import { settleInterruptedNativeBootstrap } from "./legacy-execution-recovery.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "./delivery-work-notifications.js";
import { environmentService } from "./environments.js";
import * as agentStarts from "./agent-start-lock.js";
import { taskRepositoryRelativePath } from "./execution-workspace-repositories.js";
import { classifyEnvironmentCapabilities, environmentRuntimeService } from "./environment-runtime.js";
import { instanceSettingsService } from "./instance-settings.js";
import * as storageBackend from "../storage/index.js";
import { getStorageService } from "../storage/index.js";
import { readFreshWorkspaceReadiness } from "./fresh-workspace-continuation.js";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../vendor/paperclip-runner/testing.js";
import type { NativeExecutionInput, NativeSession, NativeSessionBackend, PrpEvent } from "../vendor/paperclip-runner/index.js";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { remoteTerminationReceipt } from "./remote-execution-termination.js";
import { recoverRetainedWorkspace, reconcileRetainedWorkspaces, retainedWorkspaceCandidates } from "./workspace-recovery.js";
import { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { registerWorkspaceRecoveryWork } from "./workspace-recovery-work.js";
import { heartbeatService } from "./heartbeat.js";
import { hasVerifiedWorkspaceRepair } from "./workspace-recovery-receipt.js";
import { createSavedWorkspaceLoader } from "./remote-workspaces.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { useWorkspaceRecoveryFixture, action, boardRecoveryApp, connectionString, db, failedRemotePreparation, interruptedRemotePreparation, root, run, stoppedWorkspaceWorker, withheldPreparationRetry } from "./__tests__/workspace-recovery-fixture.js";
const targets = vi.hoisted(() => new Map<string, AdapterSandboxExecutionTarget>());
vi.mock("./environment-execution-target.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./environment-execution-target.js")>();
  return { ...actual, resolveEnvironmentExecutionTarget: async (input: Parameters<typeof actual.resolveEnvironmentExecutionTarget>[0]) =>
    (input.leaseId ? targets.get(input.leaseId) : undefined) ?? actual.resolveEnvironmentExecutionTarget(input) };
});

describe("automatic retained workspace recovery", () => {
  useWorkspaceRecoveryFixture(targets);

  it.each(["complete", "stopped_worker", "automatic_lost", "catalog", "catalog_warning", "catalog_unknown_warning", "catalog_provider_warning", "invalid_published_root"] as const)(
    "dispatches the recovered failed-preparation Retry once through the native provider boundary (%s)", async mode => {
    const unavailableCatalog = mode !== "complete" && mode !== "stopped_worker" && mode !== "automatic_lost" && mode !== "invalid_published_root", withWarning = mode.includes("warning");
    const localStorage = getStorageService();
    const databaseUrl = process.env.DATABASE_URL, masterKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    const experimental = await instanceSettingsService(db).getExperimental();
    let stoppedWorker: Awaited<ReturnType<typeof stoppedWorkspaceWorker>> | undefined;
    let storage: { mockRestore(): void } | undefined;
    const starts = vi.spyOn(agentStarts, "withAgentStartLock");
    const retryResumes: Promise<void>[] = [];
    let resumeSpy: { mockRestore(): void } | undefined;
    let ownedHeartbeat: ReturnType<typeof heartbeatService> | undefined;
    let releaseStart: (() => void) | undefined;
    let heldStart: Promise<void> | undefined;
    let explicitResume: Promise<void> | undefined;
    let recoveryCoordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
    let recoveryWorker: ReturnType<typeof registerWorkspaceRecoveryWork> | undefined;
    try {
      storage = vi.spyOn(storageBackend, "getStorageService").mockReturnValue({ ...localStorage, provider: "s3" });
      process.env.DATABASE_URL = connectionString; process.env.PAPERCLIP_SECRETS_MASTER_KEY = "63".repeat(32);
      await instanceSettingsService(db).updateExperimental({ enableNativeRunner: true, enableIsolatedWorkspaces: true });
      const f = mode === "automatic_lost" ? await interruptedRemotePreparation("process_lost", "published")
        : await failedRemotePreparation(mode === "invalid_published_root" ? "raw" : "published");
      if (mode === "automatic_lost") {
        await db.update(heartbeatRuns).set({ responsibleUserId: "local-board" }).where(eq(heartbeatRuns.id, f.runId));
        await withheldPreparationRetry(f);
      }
      if (mode === "complete") await db.update(heartbeatRuns).set({ sessionIdBefore: randomUUID() }).where(eq(heartbeatRuns.id, f.runId));
      if (mode === "stopped_worker") stoppedWorker = await stoppedWorkspaceWorker(f);
      await recoverRetainedWorkspace(f.input);
      if (stoppedWorker) {
        expect((await run(f.runId)).runnerProfileJson?.nativeWorkspaceOwnerStopProof).toEqual(stoppedWorker.stopProof);
        expect((await run(f.runId)).runnerProfileJson?.nativeWorkspaceFinalizationOwner).toBeUndefined();
      }
      const source = await run(f.runId), nextDirectory = path.join(root, randomUUID(), "next");
      await mkdir(nextDirectory, { recursive: true });
      const nextRemote = await realpath(nextDirectory);
      await db.insert(authUsers).values({ id: "local-board", name: "Local operator", email: "local-board@example.invalid",
        createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
      await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: "local-board", membershipRole: "owner" });
      await db.update(agents).set({ defaultEnvironmentId: f.lease.environmentId,
        adapterConfig: withWarning ? { provider: "acpx", acpxAgent: "pi", model: "openrouter/deepseek/deepseek-v4.1-flash-1017" }
          : { provider: "codex", model: "gpt-6.1-sol" } }).where(eq(agents.id, source.agentId));
      if (withWarning) await db.insert(companyObservability).values({ companyId: f.companyId, revision: randomUUID(), enabled: true,
        destination: { provider: "otlp", endpointBaseUrl: "https://collector.example.invalid/otel" },
        capture: { userPrompts: false, assistantResponses: false, toolDetails: false, toolContent: false } });
      await db.update(environments).set({ config: { provider: "fake", image: "fake:test" } }).where(eq(environments.id, f.lease.environmentId!));
      const environment = environmentService(db), oldTarget = targets.get(f.lease.id)!;
      oldTarget.runner!.syncIn = async operations => {
        for (const operation of operations) for (const file of operation.files) {
          await mkdir(path.dirname(file.targetPath), { recursive: true });
          await cp(file.sourcePath, file.targetPath, { recursive: true, dereference: false });
        }
        return { filesTransferred: operations.reduce((count, operation) => count + operation.files.length, 0), bytesTransferred: 0, operations: [] };
      };
      const filesystemExecute = oldTarget.runner!.execute;
      const fixtureCodex = "/opt/paperclip-fixture/bin/codex";
      const executeCommand: typeof filesystemExecute = async input => {
        if (input.command === "sh" && input.args?.some(arg => arg.includes("command -v codex"))) {
          return { exitCode: 0, signal: null, timedOut: false, pid: null, startedAt: new Date().toISOString(), stdout: `${fixtureCodex}\n`, stderr: "" };
        }
        if (input.command === fixtureCodex && input.args?.[0] === "--version") {
          return { exitCode: 0, signal: null, timedOut: false, pid: null, startedAt: new Date().toISOString(), stdout: "codex-cli 0.160.0\n", stderr: "" };
        }
        return filesystemExecute(input);
      };
      const runtime = environmentRuntimeService(db, { drivers: [{ driver: "sandbox",
        acquireRunLease: async input => {
          const lease = await environment.acquireLease({ companyId: input.companyId, environmentId: input.environment.id,
            issueId: input.issueId, heartbeatRunId: input.heartbeatRunId, executionWorkspaceId: input.executionWorkspaceId,
            provider: "fake", providerLeaseId: randomUUID(), leasePolicy: "retain_on_failure",
            metadata: { driver: "sandbox", remoteCwd: nextRemote, agentId: input.agentId } });
          targets.set(lease.id, { ...oldTarget, leaseId: lease.id, remoteCwd: nextRemote,
            runner: { ...oldTarget.runner!, execute: executeCommand },
            sandboxLeaseAcquisition: { outcome: "created", providerLeaseId: lease.providerLeaseId! } });
          return lease;
        },
        releaseRunLease: async input => environment.releaseLease(input.lease.id, input.status, { cleanupStatus: "success",
          remoteExecutionTermination: remoteTerminationReceipt(input.lease, { providerLeaseId: input.lease.providerLeaseId, state: "stopped" }) }),
        resumeRunLease: async ({ lease }) => ({ providerLeaseId: lease.providerLeaseId!, metadata: { remoteCwd: lease.metadata?.remoteCwd } }),
        retryPendingSandboxTeardown: async ({ lease }) => ({ providerLeaseId: lease.providerLeaseId, state: "stopped" }),
        realizeWorkspace: async () => ({ cwd: nextRemote, metadata: { remoteCwd: nextRemote } }),
        execute: async input => executeCommand({ command: input.command, args: input.args, cwd: input.cwd,
          env: input.env, stdin: input.stdin, timeoutMs: input.timeoutMs }),
        resolveCapabilities: async () => classifyEnvironmentCapabilities({ verifiedMethods: [], declared: null, narrowing: null }),
      }] });
      const workProductId = randomUUID(), evidenceRef = `work_product:${workProductId}`;
      await db.insert(issueWorkProducts).values({ id: workProductId, companyId: f.companyId, issueId: f.issueId,
        type: "artifact", provider: "paperclip", title: "Continued saved work", status: "ready_for_review", reviewState: "approved" });
      const inputs: NativeExecutionInput[] = [], startTurn = vi.fn();
      const backendFactory = (execution: NativeExecutionInput): NativeSessionBackend => {
        inputs.push(execution);
        const identity = { companyId: f.companyId, agentId: source.agentId, issueId: f.issueId,
          runId: execution.binding.runId, sessionId: execution.session.normalizedSessionId! };
        const turnId = `turn-${identity.runId}`, result = structuredClone(CONTROL_PLANE_CONFORMANCE_RESULT);
        result.completionClaim.contractRevision = execution.completionContract.contract.revision;
        result.completionClaim.criteria = execution.completionContract.contract.criteria.map(criterion => ({
          ...result.completionClaim.criteria[0]!, criterionId: criterion.id, evidenceRefs: [evidenceRef] }));
        result.evidence = [{ kind: "work_product", ref: evidenceRef }]; result.verification[0]!.artifactRef = evidenceRef;
        let started!: () => void;
        const turnStarted = new Promise<void>(resolve => { started = resolve; });
        const session: NativeSession = {
          identity: () => identity,
          async capabilities() { return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true }; },
          async *events() {
            await turnStarted;
            const current = await run(identity.runId);
            yield { schema: "paperclip.prp.event.v1", sourceEventId: `${identity.runId}:terminal`, sourceSeq: 1,
              sourceInstanceId: current.runnerInstanceId!, sourceKind: "runner", runId: identity.runId,
              normalizedSessionId: identity.sessionId, turnId, eventType: "turn.completed", schemaVersion: 1,
              priority: 0, emittedAt: new Date().toISOString(), payload: {} } satisfies PrpEvent;
          },
          async startTurn(input) {
            expect(execution.provider).toMatchObject({ kind: "codex", model: "gpt-6.1-sol" });
            expect(await readFile(path.join(execution.workspace.cwd!, "saved.txt"), "utf8")).toBe("finished work\n");
            await writeFile(path.join(execution.workspace.cwd!, "continued.txt"), "continued from preserved work\n");
            startTurn(input); started(); return { turnId };
          },
          async result() { await turnStarted; return { result, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, turnId }; },
          async snapshot() { return { backendKind: "mock", sessionId: "recovered-preparation", identity,
            providerSessionId: "recovered-preparation", activeTurnId: null, pendingRuntimeRequests: [], lineage: [], cursor: "1" }; },
          async close() {},
        };
        return { async descriptor() { return { kind: "mock", name: "recovered-preparation", version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
          runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } }; },
        async openSession() { return session; } };
      };
      const heartbeat = heartbeatService(db, { environmentRuntime: runtime, nativeSessionBackendFactory: backendFactory });
      ownedHeartbeat = heartbeat;
      const resumeTaskRetry = heartbeat.resumeTaskRetry;
      resumeSpy = vi.spyOn(heartbeat, "resumeTaskRetry").mockImplementation((...args) => {
        const pending = resumeTaskRetry(...args);
        retryResumes.push(pending);
        return pending;
      });
      const app = boardRecoveryApp(undefined, heartbeat);
      const gate = new Promise<void>(resolve => { releaseStart = resolve; });
      heldStart = agentStarts.withAgentStartLock(source.agentId, () => gate);
      const receipt = mode === "automatic_lost" ? null : (await request(app).post(`/api/issues/${f.issueId}/retry`)
        .send({ observedRunId: f.runId, idempotencyKey: randomUUID() }).expect(202)).body;
      if (mode === "automatic_lost") {
        await Promise.all([heartbeat.resumeRemoteStopComments(await run(f.runId)),
          heartbeat.resumeRemoteStopComments(await run(f.runId))]);
        explicitResume = heartbeat.promoteDueScheduledRetries(new Date(Date.now() + 300_000)).then(() => undefined);
      } else {
        await expect.poll(() => starts.mock.calls.filter(([agentId]) => agentId === source.agentId).length, { timeout: 10_000 }).toBe(2);
        explicitResume = heartbeat.resumeTaskRetry(f.companyId, receipt.requestId);
      }
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        mode === "automatic_lost" ? eq(heartbeatRuns.scheduledRetryReason, "interrupted_preparation")
          : sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${receipt.requestId}`));
      expect(successors).toHaveLength(1);
      if (unavailableCatalog) {
        const repoUrl = "https://github.com/example/revoked.git";
        await db.insert(executionWorkspaceRepositories).values({ companyId: f.companyId, executionWorkspaceId: f.workspaceId,
          requestedByIssueId: f.issueId, repositoryIdentity: repoUrl, repoUrl, catalogRepositoryId: "revoked-before-dispatch",
          relativePath: taskRepositoryRelativePath(repoUrl), requestKey: randomUUID(), state: "ready", pinnedCommit: f.commit });
      }
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(and(
        eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.status, "running")));
      releaseStart!(); await Promise.all([heldStart, explicitResume]);
      await heartbeat.resumeQueuedRuns(); await heartbeat.drainActiveRunExecutions();
      const completed = await run(successors[0].id);
      if (mode === "invalid_published_root") {
        expect(completed).toMatchObject({ status: "failed", runtimeMode: "legacy", errorCode: "setup_failed",
          error: "remote_workspace_published_path_invalid" });
        expect(inputs).toHaveLength(0); expect(startTurn).not.toHaveBeenCalled();
        expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, completed.id))).toHaveLength(0);
        expect(await readFile(path.join(f.remote, "saved.txt"), "utf8")).toBe("finished work\n");
        expect((await run(f.runId)).error).toBe(source.error);
        return;
      }
      if (unavailableCatalog) {
        expect(completed).toMatchObject({ status: "failed", errorCode: "setup_failed",
          error: "Repository access is no longer available; refresh the repository catalog" });
        expect(inputs).toHaveLength(0); expect(startTurn).not.toHaveBeenCalled();
        const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
        expect(await readFile(path.join(workspace.cwd!, "saved.txt"), "utf8")).toBe("finished work\n");
        expect((await run(f.runId)).error).toBe(source.error);
        expect(completed).toMatchObject({ runtimeMode: "legacy", runtimeModeResolvedAt: null, executionStage: "preparing",
          nativeIssueId: null, nativeSessionId: null, usageJson: { ledgerScope: expect.any(Object) },
          resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
        expect(completed.usageJson).toEqual({ ledgerScope: { issueId: f.issueId, projectId: null, billingCode: null } });
        if (withWarning) {
          const [warning] = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, completed.id), eq(heartbeatRunEvents.seq, 1)));
          expect(warning).toMatchObject({ eventType: "agent_observability.unavailable", stream: "system", level: "warn",
            payload: { reason: "unsupported_harness", revision: expect.any(String) }, sourceEventId: null, sourceInstanceId: null });
          if (mode === "catalog_unknown_warning") await db.update(heartbeatRunEvents).set({ payload: { ...warning.payload, reason: "unknown" } }).where(eq(heartbeatRunEvents.id, warning.id));
          if (mode === "catalog_provider_warning") await db.update(heartbeatRunEvents).set({ sourceEventId: randomUUID() }).where(eq(heartbeatRunEvents.id, warning.id));
        }
        await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: source.agentId, status: "running" });
        const errors = vi.fn();
        recoveryCoordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: errors });
        recoveryWorker = registerWorkspaceRecoveryWork(db, recoveryCoordinator, runtime, heartbeat.resumeRemoteStopComments);
        await recoveryWorker.ready;
        const retryIntent = { observedRunId: completed.id, idempotencyKey: randomUUID() };
        const retry = (await request(app).post(`/api/issues/${f.issueId}/retry`).send(retryIntent).expect(202)).body;
        const resumed = () => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
          sql`${heartbeatRuns.contextSnapshot}->>'taskRetryRequestId' = ${retry.requestId}`));
        await expect.poll(async () => await hasVerifiedWorkspaceRepair(db, await run(completed.id)), { timeout: 20_000 }).toBe(true);
        if (mode === "catalog_unknown_warning" || mode === "catalog_provider_warning") {
          await heartbeat.resumeTaskRetry(f.companyId, retry.requestId);
          expect(await resumed()).toHaveLength(0); expect(startTurn).not.toHaveBeenCalled();
          return;
        }
        await expect.poll(async () => (await resumed()).length, { timeout: 20_000 }).toBe(1);
        const [continuation] = await resumed();
        expect(continuation).toMatchObject({ status: "queued", contextSnapshot: { previousRunId: completed.id,
          taskRetryRequestId: retry.requestId } });
        expect(await readFreshWorkspaceReadiness(db, continuation)).toMatchObject({ mode: "resume_preserved_workspace" });
        expect((await request(app).post(`/api/issues/${f.issueId}/retry`).send(retryIntent).expect(202)).body.requestId).toBe(retry.requestId);
        expect(await resumed()).toHaveLength(1); expect(startTurn).not.toHaveBeenCalled();
        expect(errors).not.toHaveBeenCalled();
        return;
      }
      expect({ status: completed.status, error: completed.error, runtimeMode: completed.runtimeMode })
        .toEqual({ status: "succeeded", error: null, runtimeMode: "native" });
      expect(inputs).toHaveLength(1); expect(startTurn).toHaveBeenCalledOnce();
      expect(path.basename(path.dirname(inputs[0].workspace.cwd!))).toBe(".paperclip-workspaces");
      expect(completed.runnerProfileJson?.nativeExecutionInput).toMatchObject({ provider: { kind: "codex", model: "gpt-6.1-sol" } });
      expect(await readFile(path.join(inputs[0].workspace.cwd!, "continued.txt"), "utf8")).toBe("continued from preserved work\n");
      expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, completed.id)))
        .toEqual([expect.objectContaining({ schemaStatus: "accepted" })]);
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("done");
      expect((await request(app).get(`/api/issues/${f.issueId}/queued-comments`).expect(200)).body.entries).toEqual([]);
      expect((await request(app).get(`/api/issues/${f.issueId}`).expect(200)).body.interruption)
        .toMatchObject({ state: "resolved", canRetry: false });
      if (mode === "automatic_lost") await heartbeat.resumeRemoteStopComments(await run(f.runId));
      else await heartbeat.resumeTaskRetry(f.companyId, receipt.requestId);
      expect(startTurn).toHaveBeenCalledOnce();
      expect((await run(f.runId)).error).toBe(source.error);
    } finally {
      try {
        releaseStart?.(); await Promise.allSettled([heldStart, explicitResume, ...retryResumes]);
        await recoveryCoordinator?.stop(); await recoveryWorker?.stop();
        await ownedHeartbeat?.drainActiveRunExecutions();
      } finally {
        resumeSpy?.mockRestore(); starts.mockRestore();
        stoppedWorker?.proof.mockRestore();
        storage?.mockRestore();
        if (databaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = databaseUrl;
        if (masterKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY; else process.env.PAPERCLIP_SECRETS_MASTER_KEY = masterKey;
        await instanceSettingsService(db).updateExperimental(experimental);
      }
    }
  }, 40_000);

  it.each(["shutdown", "lease"] as const)("admits HTTP Retry once after an interrupted Runner preparation recovers its remote workspace (%s)", async interruption => {
    const f = await interruptedRemotePreparation(interruption);
    await recoverRetainedWorkspace(f.input);
    expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
    const intent = { observedRunId: f.runId, idempotencyKey: randomUUID() };
    const app = boardRecoveryApp();
    const receipt = (await request(app).post(`/api/issues/${f.issueId}/retry`).send(intent).expect(202)).body;
    const heartbeat = heartbeatService(db);
    await Promise.all([heartbeat.resumeTaskRetry(f.companyId, receipt.requestId),
      heartbeat.resumeTaskRetry(f.companyId, receipt.requestId)]);
    expect((await request(app).post(`/api/issues/${f.issueId}/retry`).send(intent).expect(202)).body.requestId).toBe(receipt.requestId);
    const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
      eq(heartbeatRuns.status, "queued")));
    expect(successors).toHaveLength(1);
    expect(successors[0].contextSnapshot).toMatchObject({ previousRunId: f.runId });
    expect(await readFreshWorkspaceReadiness(db, successors[0])).toMatchObject({ mode: "resume_preserved_workspace" });
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    expect((await run(f.runId)).status).toBe("interrupted");
    const remote = (await run(f.runId)).runnerProfileJson!.remoteWorkspace as { snapshotId: string };
    const saved = await createSavedWorkspaceLoader(db)({ companyId: f.companyId, workspaceId: f.workspaceId,
      snapshotId: remote.snapshotId });
    try { expect(await readFile(path.join(saved.root, "saved.txt"), "utf8")).toBe("finished work\n"); }
    finally { await saved.cleanup(); }
  }, 30_000);

  it.each([false, true].flatMap(alreadyRecovered => (["shutdown", "lease"] as const).map(interruption => ({ alreadyRecovered, interruption }))))(
    "automatically retries interrupted preparation after preservation ($interruption, startup=$alreadyRecovered)", async ({ alreadyRecovered, interruption }) => {
    const f = await interruptedRemotePreparation(interruption);
    if (alreadyRecovered) await recoverRetainedWorkspace(f.input);
    const restarted = createDb(connectionString);
    try {
      const heartbeat = heartbeatService(restarted);
      await Promise.all(await reconcileRetainedWorkspaces(restarted, f.environmentRuntime,
        heartbeat.resumeRemoteStopComments, true) ?? []);
      await Promise.all([heartbeat.resumeRemoteStopComments(await run(f.runId)),
        heartbeat.resumeRemoteStopComments(await run(f.runId))]);
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        eq(heartbeatRuns.retryOfRunId, f.runId)));
      expect(successors).toHaveLength(1);
      expect(successors[0]).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 1 });
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("in_progress");
      expect((await run(f.runId)).status).toBe("interrupted");
      expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
    } finally { await restarted.$client.end(); }
  }, 30_000);

  it.each([false, true])("continues recovered lost preparation once after its first retry was withheld (startup=%s)", async alreadyRecovered => {
    const f = await interruptedRemotePreparation("process_lost");
    const withheld = await withheldPreparationRetry(f);
    expect(await isPreDispatchExecutionWaitVerified(db, withheld)).toBe(true);
    if (alreadyRecovered) await recoverRetainedWorkspace(f.input);
    const restarted = createDb(connectionString);
    try {
      const heartbeat = heartbeatService(restarted);
      await Promise.all(await reconcileRetainedWorkspaces(restarted, f.environmentRuntime,
        heartbeat.resumeRemoteStopComments, true) ?? []);
      await Promise.all([heartbeat.resumeRemoteStopComments(await run(f.runId)),
        heartbeat.resumeRemoteStopComments(await run(f.runId))]);
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        eq(heartbeatRuns.status, "scheduled_retry")));
      expect(successors).toHaveLength(1);
      expect(successors[0]).toMatchObject({ retryOfRunId: withheld.id, scheduledRetryAttempt: 2,
        scheduledRetryReason: "interrupted_preparation", contextSnapshot: { executionRetryAccounting: { failureRetries: 2 } } });
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
      expect((await run(f.runId)).status).toBe("failed");
      expect(await run(withheld.id)).toMatchObject({ status: "cancelled", startedAt: null });
      expect(await hasVerifiedWorkspaceRepair(db, await run(f.runId))).toBe(true);
    } finally { await restarted.$client.end(); }
  }, 30_000);

  it.each(["withheld_first", "successor_first"] as const)("reuses the newest retry child without replacing a withheld sibling (%s)", async order => {
    const f = await interruptedRemotePreparation("process_lost");
    const source = await run(f.runId);
    const now = Date.now();
    const addSuccessor = async () => (await db.insert(heartbeatRuns).values({
      companyId: f.companyId, agentId: source.agentId, issueId: f.issueId, retryOfRunId: source.id,
      status: "failed", runtimeMode: "native", nativeIssueId: f.issueId,
      startedAt: new Date(now - 1000), finishedAt: new Date(now), createdAt: new Date(now - 1000),
      errorCode: "native_provider_terminal_failed", contextSnapshot: { issueId: f.issueId },
      scheduledRetryAttempt: 2, scheduledRetryReason: "transient_failure",
    }).returning())[0];
    const addWithheld = async () => {
      const child = await withheldPreparationRetry(f);
      await db.update(heartbeatRuns).set({ createdAt: new Date(now - 2000) }).where(eq(heartbeatRuns.id, child.id));
      return child;
    };
    let successor: typeof heartbeatRuns.$inferSelect;
    let withheld: typeof heartbeatRuns.$inferSelect;
    if (order === "withheld_first") { withheld = await addWithheld(); successor = await addSuccessor(); }
    else { successor = await addSuccessor(); withheld = await addWithheld(); }
    await recoverRetainedWorkspace(f.input);
    const heartbeat = heartbeatService(db);
    await Promise.all([heartbeat.resumeRemoteStopComments(await run(f.runId)),
      heartbeat.resumeRemoteStopComments(await run(f.runId))]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, withheld.id))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.id))).toHaveLength(2);
    expect(await run(successor!.id)).toEqual(successor!);
    expect((await action(f.actionId)).evidence).toMatchObject({ bootstrapPreparationContinuation: "delivered",
      bootstrapPreparationContinuationRunId: successor!.id });
    expect(await nextWorkspaceRecoveryAt(db)).toBeNull();
  }, 30_000);

  it.each([false, true])("continues a recovered lost preparation without an earlier retry (startup=%s)", async alreadyRecovered => {
    const f = await interruptedRemotePreparation("process_lost");
    if (alreadyRecovered) await recoverRetainedWorkspace(f.input);
    const restarted = createDb(connectionString);
    try {
      const heartbeat = heartbeatService(restarted);
      await Promise.all(await reconcileRetainedWorkspaces(restarted, f.environmentRuntime,
        heartbeat.resumeRemoteStopComments, true) ?? []);
      await Promise.all([heartbeat.resumeRemoteStopComments(await run(f.runId)),
        heartbeat.resumeRemoteStopComments(await run(f.runId))]);
      const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, f.runId));
      expect(successors).toHaveLength(1);
      expect(successors[0]).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 1 });
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
      expect(await nextWorkspaceRecoveryAt(restarted)).toBeNull();
    } finally { await restarted.$client.end(); }
  }, 30_000);

  it.each(["restart", "pause", "claimed", "duplicate"] as const)("retains preparation continuation after settlement before enqueue (%s)", async mode => {
    const f = await interruptedRemotePreparation("process_lost"), withheld = await withheldPreparationRetry(f);
    await recoverRetainedWorkspace(f.input);
    const source = await run(f.runId);
    expect(await settleInterruptedNativeBootstrap(db, { run: source, providerDispatchStarted: false })).not.toBeNull();
    expect((await action(f.actionId)).evidence.automaticRecovery).toMatchObject({ replay: "allowed" });
    expect(await nextWorkspaceRecoveryAt(db)).not.toBeNull();
    const duplicateId = mode === "duplicate" ? randomUUID() : null;
    if (duplicateId) {
      const prior = await action(f.actionId);
      await db.insert(issueRecoveryActions).values({ ...prior, id: duplicateId });
    }
    if (mode === "claimed") {
      const first = await heartbeatService(db).scheduleBoundedRetry(f.runId);
      expect(first.outcome).toBe("scheduled");
      expect((await action(f.actionId)).evidence.bootstrapPreparationContinuation).toBe("pending");
    }
    if (mode === "pause") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, source.agentId));
    const restarted = createDb(connectionString);
    try {
      const heartbeat = heartbeatService(restarted);
      await Promise.all(await reconcileRetainedWorkspaces(restarted, f.environmentRuntime,
        heartbeat.resumeRemoteStopComments, true) ?? []);
      if (mode === "pause") {
        expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, withheld.id))).toHaveLength(0);
        expect(await nextWorkspaceRecoveryAt(restarted)).toBeNull();
        expect((await action(f.actionId)).evidence.bootstrapPreparationContinuation).toBe("deferred");
        const wake = vi.fn(), unsubscribe = subscribeDeliveryWork(restarted, DELIVERY_QUEUES.workspaceRecovery, wake);
        try {
          const rollback = new Error("rollback eligibility change");
          await expect(restarted.transaction(async tx => {
            await notifyDeferredExecutionEligibility(tx, { companyId: f.companyId });
            await tx.update(agents).set({ status: "idle" }).where(eq(agents.id, source.agentId));
            throw rollback;
          })).rejects.toBe(rollback);
          expect((await db.select().from(agents).where(eq(agents.id, source.agentId)))[0].status).toBe("paused");
          await Promise.all(await reconcileRetainedWorkspaces(restarted, f.environmentRuntime,
            heartbeat.resumeRemoteStopComments, true) ?? []);
          expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, withheld.id))).toHaveLength(0);
          expect(await nextWorkspaceRecoveryAt(restarted)).toBeNull();
          wake.mockClear();
          await restarted.transaction(async tx => {
            await notifyDeferredExecutionEligibility(tx, { companyId: f.companyId });
            await tx.update(agents).set({ status: "idle" }).where(eq(agents.id, source.agentId));
          });
          expect(wake).toHaveBeenCalled();
        } finally { unsubscribe(); }
        await Promise.all(await reconcileRetainedWorkspaces(restarted, f.environmentRuntime,
          heartbeat.resumeRemoteStopComments, true) ?? []);
      }
      const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, withheld.id));
      expect(successors).toHaveLength(1);
      expect(successors[0]).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: 2 });
      expect((await action(f.actionId)).evidence).toMatchObject({ bootstrapPreparationContinuation: "delivered",
        bootstrapPreparationContinuationRunId: successors[0].id });
      expect(await nextWorkspaceRecoveryAt(restarted)).toBeNull();
      if (duplicateId) expect((await action(duplicateId)).evidence.bootstrapPreparationContinuation).toBe("delivered");
      expect(await retainedWorkspaceCandidates(restarted, undefined, false, true)).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ run: expect.objectContaining({ id: f.runId }) })]));
    } finally { await restarted.$client.end(); }
  }, 30_000);

  it("revisits a pending continuation after enqueue fails before a new notification", async () => {
    const f = await interruptedRemotePreparation("process_lost"), withheld = await withheldPreparationRetry(f);
    await recoverRetainedWorkspace(f.input);
    expect(await settleInterruptedNativeBootstrap(db, { run: await run(f.runId), providerDispatchStarted: false })).not.toBeNull();
    const heartbeat = heartbeatService(db), passiveSweep = {};
    let attempts = 0;
    const onRecovered = async (source: Awaited<ReturnType<typeof run>>) => {
      if (source.id !== f.runId) return;
      if (++attempts === 1) throw new Error("database read unavailable before enqueue notification");
      await heartbeat.resumeRemoteStopComments(source);
    };
    await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, onRecovered, true, undefined, passiveSweep) ?? []);
    expect(attempts).toBe(1);
    expect(await nextWorkspaceRecoveryAt(db)).not.toBeNull();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, withheld.id))).toHaveLength(0);
    await Promise.all(await reconcileRetainedWorkspaces(db, f.environmentRuntime, onRecovered, true, undefined, passiveSweep) ?? []);
    expect(attempts).toBe(2);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, withheld.id)))
      .toEqual([expect.objectContaining({ status: "scheduled_retry", scheduledRetryAttempt: 2 })]);
    expect(await nextWorkspaceRecoveryAt(db)).toBeNull();
  }, 30_000);

});
