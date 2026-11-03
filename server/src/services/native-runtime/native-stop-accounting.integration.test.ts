import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authUsers, companyMemberships, agents, companies, completionContracts, costEvents, createDb, budgetReservations, activityLog, environments, environmentLeases, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { executeNativeSession as executeActualNativeSession, type ControlPlanePort, type NativeExecutionInputV1, type PrpEvent } from "@paperclipai/paperclip-runner";
import { createIsolatedTestHome } from "../../__tests__/helpers/isolated-test-home.js";
import { registerNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";
import { DurablePrpControlPlane } from "../../vendor/paperclip-runner/index.js";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async importOriginal => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()), executeNativeSession: provider.execute,
}));
import { createPostgresRunDispatchAdapter } from "../../modules/run-dispatch/adapters/postgres.js";
import * as githubLaunchers from "../heartbeat-github-launchers.js";
import * as executionTargets from "../environment-execution-target.js";
import * as attachmentStaging from "./native-runner-file-handoff.js";
import * as workspaceSync from "./native-workspace-sync.js";
import { environmentRuntimeService, classifyEnvironmentCapabilities } from "../environment-runtime.js";
import { remoteTerminationReceipt } from "../remote-execution-termination.js";
import { heartbeatService } from "../heartbeat.js";
import { reserveRunBudget } from "../budget-reservations.js";
import { requestedRunCancellation } from "../run-cancellation.js";
import { readClaimedNativeStopRecovery } from "./native-cancellation-request.js";
import { currentNativeControllerIdentity } from "./native-restart-recovery.js";
import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { createRunUsageRecorder } from "../usage-receipts.js";
import { createCostAccountingReconciler } from "../run-cost-accounting.js";
import { registerCostAccountingWork } from "../budget-enforcement-worker.js";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";

describe("native Stop accounting after the last usage receipt", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: ReturnType<typeof createIsolatedTestHome>;
  beforeAll(async () => {
    home = createIsolatedTestHome();
    vi.stubEnv("PAPERCLIP_HOME", home.home);
    temporary = await startEmbeddedPostgresTestDatabase("native-stop-accounting-");
    db = createDb(temporary.connectionString);
    await db.insert(authUsers).values({ id: "test-board", name: "Test Board", email: "board@example.test", emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  }, 60_000);
  afterAll(async () => { await temporary?.cleanup(); home?.cleanup(); vi.unstubAllEnvs(); });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stopped accounting", issuePrefix: randomUUID().slice(0, 8) });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "test-board", status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Stopped worker", status: "active", adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "test-model", cwd: home.home } });
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Resume after Stop", responsibleUserId: "test-board", status: "in_progress", assigneeAgentId: agentId }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native",
      nativeIssueId: issueId, issueId, scopeKind: "issue", contextSnapshot: { issueId }, invocationSource: "on_demand", costAccountingPending: true }).returning();
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1", binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: { kind: "codex", model: "test-model" },
      task: { identifier: issueId, title: issue.title, description: null, prompt: "Keep the task context.", workMode: "standard" },
      workspace: { cwd: home.home, repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
        contract: buildNativeCompletionContract(issue, { revision: contract.revision }) },
      interactionResponses: [], credentialBindings: [],
    };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, runId));
    return { companyId, agentId, issueId, runId, native, execution };
  }

  it.each([true, false])("wakes settlement after Stop closure while preserving incomplete receipt debt (complete=%s)", async complete => {
    const { companyId, agentId, issueId, runId, native, execution } = await fixture();
    const usage = await createRunUsageRecorder(db, { companyId, runId, adapterType: "paperclip_runner" });
    const reconcile = vi.fn(createCostAccountingReconciler(db));
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => { throw error; } });
    const worker = registerCostAccountingWork(db, coordinator, reconcile);
    const readRun = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then(rows => rows[0]);
    await worker.ready;
    const event = (eventType: string, sourceSeq: number, payload: Record<string, unknown>): PrpEvent => ({
      schema: "paperclip.prp.event.v1", runId, normalizedSessionId: native.normalizedSessionId, turnId: native.turnId,
      sourceInstanceId: native.runnerInstanceId, sourceEventId: `stop-accounting-${sourceSeq}`, sourceSeq,
      sourceKind: "runner", eventType, schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(), payload,
    } as PrpEvent);
    provider.execute.mockReset().mockImplementationOnce(async (options: { controlPlane: ControlPlanePort }) => {
      await options.controlPlane.openRun({ identity: { companyId, issueId, runId, agentId, sessionId: native.normalizedSessionId },
        backendKind: "mock", sourceInstanceId: native.runnerInstanceId });
      await options.controlPlane.appendEvent(event("turn.started", 1, {}));
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), resultJson: {
        cancelledByActorType: "user", cancelledByUserId: "local-board", nativeCancellation: {
          schema: "paperclip.native-cancellation.v1", companyId, issueId, runId, scope: "run", reasonCode: "cancellation_run_only",
          dispatched: true, dispatchState: "acknowledged", intentAuditId: randomUUID(), acknowledgementAuditId: randomUUID(),
        },
      } }).where(eq(heartbeatRuns.id, runId));
      const beforeReceipt = reconcile.mock.calls.length;
      await options.controlPlane.appendEvent(event("item.completed", 2, { kind: "usage", usage: {
        runDelta: { inputTokens: 120, outputTokens: 10, providerCostUsd: 0.25 }, runDeltaComplete: complete,
      } }));
      await options.controlPlane.appendEvent(event("turn.interrupted", 3, { status: "interrupted" }));
      await expect.poll(() => reconcile.mock.calls.length).toBeGreaterThan(beforeReceipt);
      expect((await readRun()).usageJson?.accountingReceiptReady).toBe(complete);
      expect((await readRun()).costAccountingPending).toBe(true);
      expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId))).toHaveLength(0);
      beforeClosure = reconcile.mock.calls.length;
      throw new Error("native_finalization_missing: session returned no semantic result");
    });
    const unexpected = async () => { throw new Error("Unexpected real provider access"); };
    let beforeClosure = 0;
    try {
      await expect(executePaperclipNativeSession({ db, execution, runnerInstanceId: native.runnerInstanceId,
        backend: { descriptor: unexpected, openSession: unexpected }, onUsage: receipt => usage.capture(receipt).then(() => undefined) }))
        .rejects.toThrow("native_cancellation_pending_recovery");
      expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0])
        .toMatchObject({ phase: "terminal_failure", failureCode: "native_retry_cancelled" });
      await expect.poll(() => reconcile.mock.calls.length).toBeGreaterThan(beforeClosure);
      if (!complete) {
        expect((await readRun()).costAccountingPending).toBe(true);
        expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId))).toHaveLength(0);
        expect(coordinator.nextWakeAt()).toBeNull();
        await usage.capture({ complete: true, provider: "openai", model: "test-model", billingType: "metered_api",
          usageBasis: "per_run", usage: { inputTokens: 120, outputTokens: 10 }, costUsd: 0.25 });
      }
      await expect.poll(async () => (await readRun()).costAccountingPending, { timeout: 1500 }).toBe(false);
      await reconcile();
      await reconcile();
      expect((await readRun()).status).toBe("cancelled");
      const charges = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId));
      expect(charges).toHaveLength(1);
      expect(charges[0].costCents).toBe(25);
      expect(provider.execute).toHaveBeenCalledOnce();
      expect(coordinator.nextWakeAt()).toBeNull();
    } finally { worker.stop(); await coordinator.stop(); }
  }, 30_000);
  it.each([{ actorType: "user", entry: "dispatch" }, { actorType: "system", entry: "dispatch" }, { actorType: "user", entry: "heartbeat" }] as const)("recovers the combined Stop fence through existing-session cleanup without new paid work ($actorType/$entry)", async ({ actorType, entry }) => {
    const { companyId, agentId, issueId, runId, native, execution } = await fixture();
    const hold = await reserveRunBudget(db, companyId, runId, null);
    const controller = await currentNativeControllerIdentity(), owner = `cleanup:${randomUUID()}`;
    const intentAuditId = randomUUID(), requestedAt = new Date().toISOString();
    await db.insert(activityLog).values({ id: intentAuditId, companyId, actorType: "user", actorId: "test-board",
      action: "native.cancellation_intent_recorded", entityType: "heartbeat_run", entityId: runId, runId, agentId });
    await db.update(nativeRunFinalizations).set({ controllerBootId: controller.bootId, controllerPid: controller.pid,
      controllerGeneration: 2, attempt: 1, leaseOwner: owner, leaseExpiresAt: new Date(Date.now() + 60_000),
      recoveryState: "awaiting_runner_reattach", recoveryHistory: [{ disposition: "reattach_remote_runner", controllerGeneration: 2, providerAttempt: 1 }] })
      .where(eq(nativeRunFinalizations.runId, runId));
    if (entry === "heartbeat") {
      const [environment] = await db.insert(environments).values({ name: `Stop sandbox ${runId}`, driver: "sandbox", config: { provider: "daytona" } }).returning();
      await db.update(agents).set({ defaultEnvironmentId: environment.id }).where(eq(agents.id, agentId));
      await db.insert(environmentLeases).values({ id: native.environmentLeaseId, environmentId: environment.id, companyId,
        issueId, heartbeatRunId: runId, status: "active", leasePolicy: "ephemeral", provider: "daytona", providerLeaseId: "existing-sandbox",
        metadata: { driver: "sandbox", agentId, remoteCwd: "/workspace" } });
      const authority = new DurablePrpControlPlane({ stateDirectory: resolve(home.home, runId, "control-plane"),
        identity: { runnerInstanceId: native.runnerInstanceId, environmentLeaseId: native.environmentLeaseId,
          runId, normalizedSessionId: native.normalizedSessionId, turnId: native.turnId, itemId: native.itemId },
        expectedRunnerVersion: "stop-recovery-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
      try { await registerNativeRunnerCheckpoint({ db, binding: { companyId, issueId, runId }, bootId: controller.bootId, authority }); }
      finally { await authority.stop(); }
      await db.update(heartbeatRuns).set({ runnerProfileJson: sql`${heartbeatRuns.runnerProfileJson} || ${JSON.stringify({
        nativeWorkspaceSync: { schema: "paperclip.native-workspace-sync/v1", state: "prepared", descriptorSha256: "a".repeat(64),
          baselineSha256: "b".repeat(64), workspaceId: runId, leaseId: native.environmentLeaseId,
          providerLeaseId: "existing-sandbox", remoteCwd: "/workspace" },
        sessionCheckpoint: { backendKind: "mock", sessionId: native.normalizedSessionId,
          identity: { companyId, agentId, issueId, runId, sessionId: native.normalizedSessionId },
          providerSessionId: "surviving-provider", workingDirectory: home.home, cursor: null, activeTurnId: native.turnId,
          semanticResult: null, terminal: null, terminalTurns: [], pendingRuntimeRequests: [], lineage: [] },
      })}::jsonb` }).where(eq(heartbeatRuns.id, runId));
    }
    await db.update(heartbeatRuns).set({ resultJson: {
      cancelledByActorType: actorType, ...(actorType === "user" ? { cancelledByUserId: "test-board" } : {}),
      cancellation: requestedRunCancellation({ cancelledByActorType: actorType }, "Operator requested Stop"),
      startupCancellation: { beforeNativeSelection: false, errorCode: "cancelled", requestedAt },
      executionCancellation: { state: "requested", requestedAt },
      nativeCancellation: { schema: "paperclip.native-cancellation.v1", companyId, issueId, runId, scope: "run",
        reasonCode: "cancellation_run_only", intentId: `native-cancellation:${randomUUID()}`, intentAuditId, dispatchState: "pending", dispatched: false,
        effects: ["release_run_resources"] },
    }, usageJson: { accountingReceiptReady: false, accountingReceiptSequence: 0 } }).where(eq(heartbeatRuns.id, runId));
    await db.update(companies).set({ status: "paused", pauseReason: "budget" }).where(eq(companies.id, companyId));
    if (entry === "heartbeat") {
      await db.update(heartbeatRuns).set({ status: "interrupted", finishedAt: new Date(), errorCode: "lease_released_before_terminal" }).where(eq(heartbeatRuns.id, runId));
      await db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, issueId));
      await db.update(nativeRunFinalizations).set({ controllerBootId: randomUUID(), leaseExpiresAt: new Date(Date.now() - 1) })
        .where(eq(nativeRunFinalizations.runId, runId));
    }
    const reservation = entry === "dispatch" ? await reserveRunBudget(db, companyId, runId, null, {}, owner) : hold;
    if (entry === "dispatch") expect(reservation).toMatchObject({ id: hold.id, reused: true });
    const usage = await createRunUsageRecorder(db, { companyId, runId, adapterType: "paperclip_runner" });
    let completeCleanup!: () => void;
    const cleanup = new Promise<void>(resolve => { completeCleanup = resolve; });
    const startTurn = vi.fn(() => { throw new Error("Stop cleanup must not start a provider turn"); }), cancel = vi.fn(() => ({ cleanup }));
    const identity = { companyId, agentId, issueId, runId, sessionId: native.normalizedSessionId };
    const backend = { descriptor: async () => ({ kind: "mock" as const, name: "existing-session", version: "1",
      capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true } }),
      openSession: vi.fn(async () => ({ identity: () => identity, cancel, startTurn, close: async () => undefined,
        snapshot: async () => ({ identity, sessionId: identity.sessionId, backendKind: "mock" as const }) })) };
    Object.assign(backend, { recoverSession: async () => ({ recovered: true, session: await backend.openSession() }) });
    provider.execute.mockReset().mockImplementationOnce(executeActualNativeSession);
    const dispatch = vi.fn(() => executePaperclipNativeSession({ db, execution, runnerInstanceId: native.runnerInstanceId,
      backend: backend as never, leaseOwner: owner, restartRecovery: { kind: "reattach_remote_runner", runId, leaseOwner: owner,
        controllerGeneration: 2, providerAttempt: 1, restartKind: "hard", recoveryRequestId: null,
        remote: { providerLeaseId: "existing-sandbox", remoteCwd: "/workspace" } },
      onUsage: receipt => usage.capture(receipt).then(() => undefined) }));
    if (entry === "heartbeat") {
      let reachedSelection = false;
      const factory = vi.fn(() => backend as never);
      const launchers = vi.spyOn(githubLaunchers, "prepareHeartbeatGitHubLaunchers").mockResolvedValue({ env: {}, cleanupLocation: null });
      const transport = vi.spyOn(executionTargets, "resolveEnvironmentExecutionTransport").mockResolvedValue(null);
      const remoteIdentity = { runId, normalizedSessionId: native.normalizedSessionId, runnerInstanceId: native.runnerInstanceId,
        environmentLeaseId: native.environmentLeaseId, turnId: native.turnId, itemId: native.itemId };
      const target = vi.spyOn(executionTargets, "resolveEnvironmentExecutionTarget").mockResolvedValue({
        kind: "remote", transport: "sandbox", providerKey: "daytona", remoteCwd: "/workspace", leaseId: native.environmentLeaseId,
        sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId: "existing-sandbox" }, runner: { execute: async request => ({
          exitCode: 0, signal: null, pid: 123, startedAt: new Date().toISOString(), timedOut: false, stderr: "", stdout: request.args?.includes("paperclip-git-context")
            ? "\0PAPERCLIP_GIT_CONTEXT_V1\0\0PAPERCLIP_GIT_CONTEXT_END\0"
            : request.args?.[1]?.includes("base64") ? Buffer.from(JSON.stringify({ ...remoteIdentity, lifecycle: "running" })).toString("base64")
            : request.args?.[1]?.includes("cat --") ? `nonce\n123\n2026-09-19T10:00:00.000Z\n${native.runnerInstanceId}\nlinux:abcd-1234:100\n` : "",
        }) },
      });
      const localCwd = vi.spyOn(workspaceSync, "readNativeWorkspaceSyncLocalCwd").mockResolvedValue(home.home);
      const sync = vi.spyOn(workspaceSync, "prepareNativeWorkspaceSync").mockResolvedValue(null);
      const stage = vi.spyOn(attachmentStaging, "stageNativeRunnerWakeAttachments").mockRejectedValue(new Error("Stop cleanup must not stage attachments"));
      const acquire = vi.fn(async () => { throw new Error("Stop cleanup cannot acquire a new sandbox"); });
      const runtime = environmentRuntimeService(db, { drivers: [{ driver: "sandbox", acquireRunLease: acquire,
        resolveCapabilities: async () => classifyEnvironmentCapabilities({}),
        realizeWorkspace: async () => ({ cwd: home.home }),
        retryPendingSandboxTeardown: async ({ lease }) => {
          await cleanup;
          expect(cancel).toHaveBeenCalledOnce();
          return { providerLeaseId: lease.providerLeaseId, state: "stopped" };
        },
        releaseRunLease: async ({ lease }) => {
          expect(cancel).toHaveBeenCalledOnce();
          const [released] = await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success",
            metadata: { ...lease.metadata, remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "stopped" }) },
          }).where(eq(environmentLeases.id, lease.id)).returning();
          return { ...released, status: "released", leasePolicy: "ephemeral", cleanupStatus: "success" };
        } }] });
      const heartbeat = heartbeatService(db, { nativeSessionBackendFactory: factory, environmentRuntime: runtime,
        beforeNativeRuntimeSelection: async () => {
          const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
          const [owner] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
          const holds = await db.select().from(budgetReservations).where(eq(budgetReservations.runId, runId));
          expect(await readClaimedNativeStopRecovery(db, current, owner.leaseOwner ?? undefined)).toBe(true);
          expect(holds).toMatchObject([{ id: hold.id, state: "held" }]);
          reachedSelection = true;
        } });
      try {
        const recovery = await heartbeat.recoverNativeRunsAfterRestart(new Date(), [runId]);
        expect(recovery.claims).toMatchObject([{ kind: "reattach_remote_runner", runId, providerAttempt: 1 }]);
        await expect.poll(() => reachedSelection, { timeout: 5_000 }).toBe(true);
        await expect.poll(() => cancel.mock.calls.length, { timeout: 5_000 }).toBe(1);
        expect(factory).toHaveBeenCalledOnce();
        expect(factory).toHaveBeenCalledWith(expect.objectContaining({ binding: expect.objectContaining({ runId }) }), { recoveryPurpose: "stop_cleanup" });
        expect(stage).not.toHaveBeenCalled();
        expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].executionRunId).toBeNull();
        expect((await heartbeat.recoverNativeRunsAfterRestart(new Date(), [runId])).claims).toHaveLength(0);
      } finally {
        completeCleanup();
        await heartbeat.drainActiveRunExecutions();
        transport.mockRestore(); target.mockRestore(); localCwd.mockRestore(); sync.mockRestore(); stage.mockRestore(); launchers.mockRestore();
      }
      expect(acquire).not.toHaveBeenCalled();
      expect((await heartbeat.getRun(runId))?.status).toBe("cancelled");
    } else {
      const gate = await createPostgresRunDispatchAdapter(db).dispatchResolvedInteractionIfCurrent({ companyId, runId,
        reservationId: reservation.id, recoveryLeaseOwner: owner, expectedStatus: "running", now: new Date(), dispatch });
      expect(gate.dispatched).toBe(true);
      if (!gate.dispatched) throw new Error("Existing Stop cleanup was not admitted");
      try {
        await expect.poll(() => cancel.mock.calls.length).toBe(1);
        const duplicate = await createPostgresRunDispatchAdapter(db).dispatchResolvedInteractionIfCurrent({ companyId, runId,
          reservationId: reservation.id, recoveryLeaseOwner: owner, expectedStatus: "running", now: new Date(), dispatch });
        expect(duplicate.dispatched).toBe(false);
        expect(dispatch).toHaveBeenCalledOnce();
        const [pending] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        expect(pending.resultJson?.nativeCancellation).toMatchObject({ dispatchState: "pending", dispatched: false });
        expect(pending.costAccountingPending).toBe(true);
        expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0].phase).toBe("observed");
      } finally { completeCleanup(); }
      await expect(gate.resultPromise).rejects.toThrow("native_cancellation_pending_recovery");
    }
    expect(cancel).toHaveBeenCalledOnce();
    expect(startTurn).not.toHaveBeenCalled();
    const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(stopped.resultJson?.nativeCancellation).toMatchObject({ dispatchState: "acknowledged", dispatched: true });
    expect(stopped.resultJson?.nativeCancellation).toHaveProperty("acknowledgementAuditId", expect.any(String));
    expect(stopped.costAccountingPending).toBe(true);
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId))).toHaveLength(0);
    expect(await db.select().from(budgetReservations).where(eq(budgetReservations.runId, runId))).toMatchObject([{ id: hold.id, state: "held" }]);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0])
      .toMatchObject({ phase: "terminal_failure", failureCode: "native_retry_cancelled", leaseOwner: null });
    const cancelled = await heartbeatService(db).cancelRun(runId, "Recovered durable native run cancellation");
    expect(cancelled?.status).toBe("cancelled");
    const reconcile = createCostAccountingReconciler(db);
    await reconcile();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0].costAccountingPending).toBe(true);
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId))).toHaveLength(0);
    const finalUsage = entry === "heartbeat" ? await createRunUsageRecorder(db, { companyId, runId, adapterType: "paperclip_runner" }) : usage;
    await finalUsage.capture({ complete: true, provider: "openai", model: "test-model", billingType: "metered_api",
      usageBasis: "per_run", usage: { inputTokens: 120, outputTokens: 10 }, costUsd: 0.25 });
    await reconcile();
    await reconcile();
    const [settled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(settled).toMatchObject({ status: "cancelled", costAccountingPending: false });
    expect(settled.costAccountedAt).toBeInstanceOf(Date);
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId))).toMatchObject([{ costCents: 25 }]);
    expect(await db.select().from(budgetReservations).where(eq(budgetReservations.runId, runId))).toMatchObject([{ id: hold.id, state: "settled" }]);
    expect((await db.select().from(companies).where(eq(companies.id, companyId)))[0]).toMatchObject({ status: "paused", pauseReason: "budget" });
  }, 30_000);

});
