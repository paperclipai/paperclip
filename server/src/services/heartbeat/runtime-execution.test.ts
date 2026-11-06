import { registerRunObserverScheduler } from "../run-observer-delivery.js";
import { createWorkScheduler } from "../work-scheduler.js";
import * as nativeStopRecovery from "../native-runtime/native-cancellation-request.js";
import { chmod, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { NativeControllerRecoveryWaitingError } from "../native-runtime/native-controller-recovery.js";

import { createNativeUsageDelivery } from "../native-runtime/native-usage-delivery.js";
import { flushBudgetEvaluationWork } from "../budgets.js";
import type { PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agents, budgetPolicies, companies, completionContracts, nativeRunResults, costEvents, agentWakeupRequests, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issues, executionWorkspaces, nativeRunFinalizations, runUsageReceipts, workspaceOperations, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { createRunPreparationTiming, measureRunPhase, measureWorkspaceSyncPhase, withRunExecutionTiming } from "../execution-preparation-timing.js";
import { recoveryPostgresSupport as support, startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import * as pluginWorkspaces from "../plugin-workspaces.js";
import * as legacyRecovery from "../legacy-execution-recovery.js";
import { createAgentIdentityRedactor } from "../agent-identity-redaction.js";
import { createAdapterExecutionControl } from "../adapter-execution-control.js";
import { executionWorkspaceService } from "../execution-workspaces.js";
import { workspaceOperationService } from "../workspace-operations.js";
import { instanceSettingsService } from "../instance-settings.js";
import { executePaperclipNativeSession, NativeCancellationPendingRecoveryError, NativeControllerDetachedForRestartError, nativeSessionFailureSourceCode, nativeSessionFailureDisposition } from "../native-runtime/native-session-executor.js";
import { NativeRunnerOwnershipUnverifiedError } from "../native-runtime/native-runner-ownership.js";
import { NativeWorkspaceFinalizationBusyError, NativeWorkspaceFinalizationOwnershipLostError } from "../native-runtime/native-workspace-finalization-ownership.js";
import { resolveHeartbeatNativeRuntimeMode } from "../native-runtime/runtime-mode.js";
import { buildNativeExecutionInput } from "../native-runtime/native-execution-input.js";
import { nativeRuntimeContextFixture } from "../native-runtime/runtime-context.test-fixture.js";
import { createHeartbeatRunState } from "./run-state.js";
import { buildEffectiveRunSessionConfigMetadata } from "./workspaces.js";
import { revokeHeartbeatRunGatewayTokens } from "./run-preparation.js";
import { executeHeartbeatRuntime, type HeartbeatRuntimeExecutionInput } from "./runtime-execution.js";

import { prepareNativeHeartbeatRun } from "../native-runtime/prepare-native-run.js";
import { buildNativeCompletionContract } from "../native-runtime/completion-contracts.js";
import { currentNativeControllerIdentity } from "../native-runtime/native-restart-recovery.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT } from "../../vendor/paperclip-runner/testing.js";
import type { ControlPlanePort, NativeExecutionInputV1 } from "@paperclipai/paperclip-runner";
const postResultProvider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async original => ({
  ...await original<typeof import("../../vendor/paperclip-runner/index.js")>(), executeNativeSession: postResultProvider.execute,
}));

// Keep real accounting, workspace barriers, and task-session persistence. Providers
// and gateway delivery are external boundaries; browser acceptance covers their wiring.
vi.mock("../native-runtime/native-session-executor.js", async original => ({
  ...await original<typeof import("../native-runtime/native-session-executor.js")>(),
  executePaperclipNativeSession: vi.fn(),
}));
vi.mock("./run-preparation.js", async original => ({
  ...await original<typeof import("./run-preparation.js")>(),
  buildPaperclipRuntimeMcpServers: vi.fn(async () => []),
  createAdapterRuntimeToolAccess: vi.fn(() => null),
  createManagedMcpRunConfig: vi.fn(async () => null),
  revokeHeartbeatRunGatewayTokens: vi.fn(async () => {}),
}));

describe.skipIf(!support.supported)("heartbeat runtime execution boundary", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: Db;
  let home: string;
  const observerScheduler = createWorkScheduler();
  let unregisterObserver: (() => void) | undefined;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "paperclip-runtime-execution-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    database = await startRecoveryPostgres("paperclip-runtime-execution");
    db = createDb(database.connectionString);
    unregisterObserver = registerRunObserverScheduler(db, { scheduleActiveDeadline: observerScheduler.schedule,
      cancelActiveDeadline: observerScheduler.cancel });
    await db.execute(sql`set client_min_messages = warning`);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { unregisterObserver?.(); observerScheduler.stop(); await db?.$client.end(); await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });
  beforeEach(async () => {
    await db.execute(sql`truncate table companies restart identity cascade`);
    vi.clearAllMocks();
    vi.mocked(executePaperclipNativeSession).mockResolvedValue({ exitCode: 0, signal: null, timedOut: false });
  });

  async function fixture(native = false, provider: "codex" | "grok_bot" | "openai_dot" = "codex") {
    const [company] = await db.insert(companies).values({ name: "Runtime execution", issuePrefix: "EXE" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Executing agent", status: "running", adapterType: native ? "paperclip_runner" : "process", adapterConfig: provider === "codex" ? { provider } : { provider, lifecycleMode: "per_turn", allowUnmeteredProvider: true, [provider === "grok_bot" ? "externalBindingId" : "dotBindingId"]: randomUUID() } }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Complete this task", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, issueId: issue.id, scopeKind: "issue", status: "running", runtimeMode: native ? "native" : "legacy" }).returning();
    const state = createHeartbeatRunState(db);
    const executionControl = createAdapterExecutionControl();
    const adapter = { type: "process", label: "Test process", testEnvironment: vi.fn(), execute: vi.fn<HeartbeatRuntimeExecutionInput["runtime"]["adapter"]["execute"]>(async () => ({ exitCode: 0, signal: null, timedOut: false })) };
    let instructionSave: Record<string, unknown> | null = null;
    const nativeExecution = native ? buildNativeExecutionInput({
      companyId: company.id, agentId: agent.id, runId: run.id, issue,
      taskPrompt: issue.title, workspace: { id: run.id, cwd: home, repoUrl: null, repoRef: null, branchName: null },
      normalizedSessionId: null, provider, runtimeContext: nativeRuntimeContextFixture(),
      dotBinding: { bindingId: randomUUID(), bindingGeneration: 1, companyId: company.id, agentId: agent.id, acceptByUnixMs: Date.now() + 60_000, expiresAtUnixMs: Date.now() + 120_000 },
      completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: issue.title, criteria: [{ id: "output", requirement: issue.title }] } },
    }) : null;
    const input: HeartbeatRuntimeExecutionInput = {
      run, agent, options: {},
      task: { issueRef: issue, issueContext: null, context: {}, issueId: issue.id, taskKey: issue.id, executionContinuation: null },
      runtime: { nativeExecution, nativeRunnerInstanceId: native ? randomUUID() : null, getNativeFreshSessionHandoff: undefined,
        nativeRuntimeResolution: resolveHeartbeatNativeRuntimeMode({ persisted: run, enabled: native, grokEnabled: true, dotEnabled: true, runtimeConfig: {}, adapterConfig: agent.adapterConfig, agent, issue, target: null, workspaceId: null }),
        adapter, runtimeForAdapter: { taskKey: issue.id, sessionId: null, sessionParams: null, sessionDisplayId: null }, getFreshSessionHandoff: undefined, runOptions: {},
      },
      workspace: { persistedExecutionWorkspace: null, executionWorkspace: { baseCwd: home, cwd: home, source: "agent_home", projectId: null, workspaceId: null, repoUrl: null, repoRef: null, strategy: "project_primary", branchName: null, worktreePath: null, warnings: [], created: false, branchCreatedByRuntime: false },
        executionTarget: null, nativeWorkspaceSync: null, workspaceRestoreSource: undefined, remoteExecution: null,
        workspaceOperationRecorder: workspaceOperationService(db).createRecorder({ companyId: company.id, heartbeatRunId: run.id, issueId: issue.id }),
      },
      config: { runtimeConfig: {}, resolvedConfig: {}, managedAiRuntime: undefined,
        resolvedInstanceSettings: { experimental: { enableWorkspaceBranchReconcileForward: false, enableWorkspaceDirtyQuarantineRepair: false } },
        configuredTaskEnvironment: {}, adapterEnv: {}, agentIdentity: undefined, runtimeEnv: {}, useHostGitHub: false, githubSelection: { configured: false },
      },
      session: { runtimeSessionParamsForAdapter: null, configuredModel: null,
        sessionConfigMetadata: await buildEffectiveRunSessionConfigMetadata({ adapterType: agent.adapterType, effectiveAdapterConfig: {}, agentRuntimeConfig: {}, issueOverrides: null, workspaceConfig: null, environment: null, environmentEnv: null, projectEnv: null, routineEnv: null, runtimeSkills: [] }), goalCheckpointSession: { current: null },
      },
      instructions: { instructionCopy: null, getInstructionSave: () => instructionSave, nativeInstructionWorkingCopy: () => undefined,
        collectStoppedInstructions: async () => { instructionSave = { state: "saved", revisionId: "during-execution" }; },
        nativeInstructionReservation: null, releaseInstructionCopy: vi.fn(async () => {}),
      },
      trace: { providerTraceCapture: null, nativeRunnerPreparationSpans: [], attestedQuestionResponseAtMs: null, attemptStartedAtMs: Date.now(), environmentAcquireStartedAtMs: Date.now(), environmentRealizeEndedAtMs: Date.now() },
      control: { executionControl, executionPhaseContext: { onExecutionPhase: executionControl.phases.enter },
        dispatchResolvedInteractionContinuationWithAtomicGate: async dispatch => ({ dispatched: true, resultPromise: dispatch(vi.fn()) }),
      },
      output: { identityRedactor: createAgentIdentityRedactor(), appendIdentityRedactedLog: vi.fn(async () => {}), onLog: vi.fn(async () => {}), onAdapterEvent: vi.fn(async () => {}), onAdapterMeta: vi.fn(async () => {}) },
      services: { ...state, executionWorkspacesSvc: executionWorkspaceService(db), instanceSettings: instanceSettingsService(db),
        envOrchestrator: { releaseForRun: vi.fn() }, cancelRunInternal: vi.fn(), enqueueWakeup: vi.fn(),
        persistRunProcessMetadata: vi.fn(), recordCurrentHeartbeatRunRuntimeProgress: vi.fn(), dispatchPendingNativeStatusWakeups: vi.fn(),
      },
      effects: { onUsageCaptureReady: vi.fn(), onNativeDispatchStarted: vi.fn(), onLegacyAdapterEntered: vi.fn(), onWorkspaceRestoreFailure: vi.fn(), onProviderResourceDisposition: vi.fn(), onNativeWorkspaceFinalizeScheduled: vi.fn(), onNativeSessionResumeScheduled: vi.fn(), onNativeOwnershipHeld: vi.fn() },
    };
    return { input, adapter, run };
  }
  it.each(["current", "expired", "replaced-owner", "generation", "attempt", "boot", "pid", "process-start", "stopped", "unknown-code", "permission", "io", "diagnostic-sink-failed", "diagnostic-lock-busy"] as const)(
    "preserves post-result diagnostics without changing recovery authority (%s)", async scenario => {
      const { input } = await fixture(true);
      const issue = input.task.issueRef!;
      const [run] = await db.update(heartbeatRuns).set({ nativeIssueId: issue.id, contextSnapshot: { issueId: issue.id }, costAccountingPending: true }).where(eq(heartbeatRuns.id, input.run.id)).returning();
      input.run = run;
      const prepared = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
      const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issue.id));
      const completion = buildNativeCompletionContract(issue, { revision: contract.revision });
      await db.insert(nativeRunFinalizations).values({ runId: run.id, companyId: run.companyId, issueId: issue.id, phase: "observed" });
      const execution: NativeExecutionInputV1 = {
        schema: "paperclip.native-execution-input.v1", interactionResponses: [], credentialBindings: [], binding: { companyId: run.companyId, agentId: run.agentId, issueId: issue.id, runId: run.id, executionWorkspaceId: run.id },
        completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1", contract: completion },
        provider: { kind: "codex", model: "test-model" },
        task: { identifier: issue.id, title: issue.title, description: null, prompt: "Local post-result fault", workMode: "standard" },
        workspace: { cwd: home, repoUrl: null, repoRef: null, branchName: null },
        session: { normalizedSessionId: prepared.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      };
      input.runtime.nativeExecution = execution;
      input.runtime.nativeRunnerInstanceId = prepared.runnerInstanceId;
      input.workspace.nativeWorkspaceSync = { mode: "host_current", reference: {
        schema: "paperclip.native-workspace-sync/v3", state: "prepared", descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
        workspaceId: run.id, leaseId: randomUUID(), providerLeaseId: "controlled-local", remoteCwd: home, resourceDisposition: null },
        restoreWorkspace: vi.fn(async () => {}), cleanup: vi.fn(async () => {}) };
      const diagnosticExpected = ["current", "stopped", "unknown-code", "permission", "io", "diagnostic-sink-failed"].includes(scenario);
      let faultInjected = false, lockHeld = false, settledWhileLocked = false;
      let releaseLock: () => void = () => {};
      let lockTask: Promise<unknown> | undefined;
      let diagnosticLockError: { code?: string; message?: string } | undefined;
      if (scenario === "diagnostic-lock-busy") {
        const transaction = db.transaction.bind(db);
        let armed = false;
        const transactionSpy = vi.spyOn(db, "transaction").mockImplementation(async (body, config) => {
          const result = await transaction(async tx => {
            // Observe real query errors; the executor still executes its actual
            // diagnostic SELECT against PostgreSQL and the competing row lock.
            if (faultInjected) {
              const select = tx.select.bind(tx);
              vi.spyOn(tx, "select").mockImplementation(fields => {
                const selection = fields === undefined ? select() : select(fields);
                const from = selection.from.bind(selection);
                selection.from = ((table: Parameters<typeof selection.from>[0]) => {
                  const query = from(table);
                  if (table === nativeRunFinalizations && fields?.runId === nativeRunFinalizations.runId) {
                    const lock = query.for.bind(query);
                    query.for = ((...args: Parameters<typeof query.for>) => lock(...args).catch(error => {
                      diagnosticLockError = error.cause ?? error;
                      throw error;
                    })) as typeof query.for;
                  }
                  return query;
                }) as typeof selection.from;
                return selection as ReturnType<typeof select>;
              });
            }
            return body(tx);
          }, config);
          // The first transaction after the injected I/O failure publishes the
          // control deadline. Hold the row only after that transaction commits.
          if (faultInjected && !armed) {
            armed = true;
            let ready!: () => void;
            const acquired = new Promise<void>(resolve => { ready = resolve; });
            const release = new Promise<void>(resolve => { releaseLock = resolve; });
            lockTask = transaction(async locker => {
              await locker.select({ runId: nativeRunFinalizations.runId }).from(nativeRunFinalizations)
                .where(eq(nativeRunFinalizations.runId, run.id)).for("update");
              lockHeld = true;
              ready();
              await release;
              lockHeld = false;
            });
            await acquired;
          }
          return result;
        });
        onTestFinished(async () => { releaseLock(); await lockTask; transactionSpy.mockRestore(); });
      }
      postResultProvider.execute.mockReset().mockImplementationOnce(async (options: { controlPlane: ControlPlanePort }) => {
        await options.controlPlane.openRun({ identity: { companyId: run.companyId, issueId: issue.id, runId: run.id, agentId: run.agentId, sessionId: prepared.normalizedSessionId }, backendKind: "mock", sourceInstanceId: prepared.runnerInstanceId });
        await options.controlPlane.completeRun({ result: { ...CONTROL_PLANE_CONFORMANCE_RESULT, completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, contractRevision: completion.revision } },
          terminal: { schema: "paperclip.prp.terminal.v1", turnTerminalState: "completed", runTerminalState: "succeeded", reportedWorkDisposition: "done" }, turnId: prepared.turnId });
        const [owner] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id));
        const controller = await currentNativeControllerIdentity();
        expect(owner).toMatchObject({ phase: "workspace_finalizing", attempt: 1, controllerGeneration: 1, controllerBootId: controller.bootId, controllerPid: controller.pid, controllerProcessStartedAt: controller.processStartedAt });
        expect(owner.leaseOwner).toBeTruthy();
        expect(owner.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
        const changed = scenario === "expired" ? { leaseExpiresAt: new Date(0) }
          : scenario === "replaced-owner" ? { leaseOwner: "replacement-owner" }
          : scenario === "generation" ? { controllerGeneration: owner.controllerGeneration + 1 }
          : scenario === "attempt" ? { attempt: owner.attempt + 1 }
          : scenario === "boot" ? { controllerBootId: randomUUID() }
          : scenario === "pid" ? { controllerPid: controller.pid + 1 }
          : scenario === "process-start" ? { controllerProcessStartedAt: new Date(controller.processStartedAt.getTime() - 1000) } : null;
        if (changed) await db.update(nativeRunFinalizations).set(changed).where(eq(nativeRunFinalizations.runId, run.id));
        if (scenario === "stopped") await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
        try { await readFile(join(home, `missing-${run.id}`, "harmless-checkpoint")); }
        catch (error) {
          faultInjected = true;
          if (scenario === "unknown-code") (error as NodeJS.ErrnoException).code = "private-unrecognized-code";
          if (scenario === "permission") (error as NodeJS.ErrnoException).code = "EACCES";
          if (scenario === "io") (error as NodeJS.ErrnoException).code = "EIO";
          throw error;
        }
        throw new Error("fixture must fail with ENOENT");
      });
      const events: unknown[] = [];
      let controlError: unknown;
      const actual = await vi.importActual<typeof import("../native-runtime/native-session-executor.js")>("../native-runtime/native-session-executor.js");
      vi.mocked(executePaperclipNativeSession).mockImplementationOnce(async options => {
        try { return await actual.executePaperclipNativeSession({ ...options, useRunnerd: false,
          backend: { descriptor: async () => { throw new Error("Unexpected provider call"); }, openSession: async () => { throw new Error("Unexpected provider call"); } },
          onEvent: async event => {
            events.push(event);
            if (event.eventType === "native.post_result_failure" && scenario === "diagnostic-sink-failed") throw new Error("private sink failure");
            await options.onEvent?.(event);
          } }); }
        catch (error) {
          controlError = error;
          settledWhileLocked = lockHeld;
          releaseLock();
          await lockTask;
          throw error;
        }
      });
      await expect(executeHeartbeatRuntime(db, input)).rejects.toMatchObject({ name: "NativeWorkspaceFinalizeScheduledError", reasonCode: "workspace_sync_out_failed", terminalFailure: false });
      expect((controlError as Error).message).toBe("native_session_lease_lost");
      if (scenario === "diagnostic-lock-busy") {
        expect(settledWhileLocked).toBe(true);
        expect(diagnosticLockError?.code).toBe("55P03");
        expect(diagnosticLockError?.message).toContain("could not obtain lock");
      }
      const source = nativeSessionFailureSourceCode(controlError);
      expect(source).toBe(nativeSessionFailureSourceCode(new Error("native_session_lease_lost")));
      expect(nativeSessionFailureDisposition(1, new Date(0), source)).toEqual(nativeSessionFailureDisposition(1, new Date(0), nativeSessionFailureSourceCode(new Error("native_session_lease_lost"))));
      expect((controlError as { diagnostic?: unknown }).diagnostic).toEqual(diagnosticExpected
        ? { stage: "post_result_execution", category: scenario === "unknown-code" ? "execution_failure" : scenario === "permission" ? "io_permission_denied" : scenario === "io" ? "io_failure" : "io_not_found", resultAlreadyAccepted: true }
        : undefined);
      const diagnostics = events.filter(event => (event as { eventType: string }).eventType === "native.post_result_failure") as Array<{ payload: unknown }>;
      expect(diagnostics).toHaveLength(diagnosticExpected ? 1 : 0);
      if (diagnosticExpected) expect(diagnostics[0].payload).toEqual({ stage: "post_result_execution", category: scenario === "unknown-code" ? "execution_failure" : scenario === "permission" ? "io_permission_denied" : scenario === "io" ? "io_failure" : "io_not_found", resultAlreadyAccepted: true });
      expect(JSON.stringify(diagnostics)).not.toContain(home);
      expect(JSON.stringify(diagnostics)).not.toContain("private-");
      const [after] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id));
      const results = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, run.id));
      expect(results).toHaveLength(1);
      expect(after.resultId).toBe(results[0].id);
      expect(after.phase).toBe("retryable_failure");
      expect(after.failureCode).toBe("native_workspace_sync_out_failed");
      expect(after.nextAttemptAt).toBeInstanceOf(Date);
      const saved = await read(run.id);
      expect(saved.costAccountingPending).toBe(true);
      expect(saved.costAccountedAt).toBeNull();
      expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, run.id))).toHaveLength(0);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, run.companyId))).toHaveLength(0);
      if (scenario === "stopped") expect(saved.status).toBe("cancelled");
      expect(postResultProvider.execute).toHaveBeenCalledOnce();
      expect(input.effects.onNativeWorkspaceFinalizeScheduled).toHaveBeenCalledOnce();
      expect(input.services.enqueueWakeup).not.toHaveBeenCalled();
      expect(input.workspace.nativeWorkspaceSync.restoreWorkspace).not.toHaveBeenCalled();
    },
  );

  const read = (id: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then(rows => rows[0]!);
  const finalizations = () => db.select().from(workspaceOperations).where(eq(workspaceOperations.phase, "workspace_finalize"));
  function expectCleanup(input: HeartbeatRuntimeExecutionInput) {
    expect(revokeHeartbeatRunGatewayTokens).toHaveBeenCalledWith({ db, companyId: input.agent.companyId, runId: input.run.id });
    expect(input.instructions.releaseInstructionCopy).toHaveBeenCalledOnce();
  }

  it("issues the matching observer to a private sink before adapter dispatch", async () => {
    const { input, adapter, run } = await fixture();
    const dir = await realpath(home), socketPath = join(dir, "observer.sock");
    const received: Array<{ runId: string; token: string }> = [];
    const sink = createServer(socket => { let data = ""; socket.on("data", chunk => {
      data += chunk.toString(); if (data.includes("\n")) { received.push(JSON.parse(data)); socket.end("ok\n"); }
    }); });
    await new Promise<void>((resolve, reject) => sink.once("error", reject).listen(socketPath, resolve));
    await chmod(socketPath, 0o600);
    const keys = ["PAPERCLIP_OBSERVER_SINK_SOCKET", "PAPERCLIP_OBSERVER_SINK_COMPANY_ID", "PAPERCLIP_OBSERVER_SINK_AGENT_ID", "PAPERCLIP_AGENT_JWT_SECRET"] as const;
    const saved = keys.map(key => process.env[key]);
    process.env.PAPERCLIP_OBSERVER_SINK_SOCKET = socketPath;
    process.env.PAPERCLIP_OBSERVER_SINK_COMPANY_ID = run.companyId;
    process.env.PAPERCLIP_OBSERVER_SINK_AGENT_ID = run.agentId;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "fictional-signing-secret";
    try {
      adapter.execute.mockImplementationOnce(async () => {
        expect(received).toHaveLength(1);
        expect(received[0]?.runId).toBe(run.id);
        const claims = JSON.parse(Buffer.from(received[0]!.token.split(".")[1]!, "base64url").toString());
        expect(claims.key_scope).toEqual({ kind: "run_status_observer" });
        expect(claims.run_id).toBe(run.id);
        return { exitCode: 0, signal: null, timedOut: false };
      });
      expect(await executeHeartbeatRuntime(db, input)).toMatchObject({ dispatched: true });
      expect(adapter.execute).toHaveBeenCalledOnce();
    } finally {
      keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
      await new Promise<void>(resolve => sink.close(() => resolve()));
    }
  });

  it("does not dispatch the adapter when its configured observer sink is unavailable", async () => {
    const { input, adapter, run } = await fixture();
    const keys = ["PAPERCLIP_OBSERVER_SINK_SOCKET", "PAPERCLIP_OBSERVER_SINK_COMPANY_ID", "PAPERCLIP_OBSERVER_SINK_AGENT_ID", "PAPERCLIP_AGENT_JWT_SECRET"] as const;
    const saved = keys.map(key => process.env[key]);
    process.env.PAPERCLIP_OBSERVER_SINK_SOCKET = join(await realpath(home), "missing-observer.sock");
    process.env.PAPERCLIP_OBSERVER_SINK_COMPANY_ID = run.companyId;
    process.env.PAPERCLIP_OBSERVER_SINK_AGENT_ID = run.agentId;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "fictional-signing-secret";
    try {
      await expect(executeHeartbeatRuntime(db, input)).rejects.toThrow();
      expect(adapter.execute).not.toHaveBeenCalled();
    } finally {
      keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    }
  });

  it("allows claimed remote Stop recovery when the observer sink is unavailable", async () => {
    const { input, run } = await fixture(true);
    const keys = ["PAPERCLIP_OBSERVER_SINK_SOCKET", "PAPERCLIP_OBSERVER_SINK_COMPANY_ID", "PAPERCLIP_OBSERVER_SINK_AGENT_ID"] as const;
    const saved = keys.map(key => process.env[key]);
    process.env.PAPERCLIP_OBSERVER_SINK_SOCKET = join(await realpath(home), "missing-stop-observer.sock");
    process.env.PAPERCLIP_OBSERVER_SINK_COMPANY_ID = run.companyId;
    process.env.PAPERCLIP_OBSERVER_SINK_AGENT_ID = run.agentId;
    const leaseOwner = randomUUID();
    input.runtime.runOptions.nativeLeaseOwner = leaseOwner;
    input.runtime.runOptions.nativeRestartRecovery = { kind: "reattach_remote_runner", runId: run.id, leaseOwner,
      controllerGeneration: 1, providerAttempt: 1, restartKind: "hard", recoveryRequestId: null,
      remote: { providerLeaseId: "fictional", remoteCwd: "/workspace" } };
    const claim = vi.spyOn(nativeStopRecovery, "readClaimedNativeStopRecovery").mockResolvedValue(true);
    const backend = vi.fn(() => ({} as never));
    input.options.nativeSessionBackendFactory = backend;
    try {
      await executeHeartbeatRuntime(db, input);
      expect(backend).toHaveBeenCalledWith(expect.anything(), { recoveryPurpose: "stop_cleanup" });
      expect(executePaperclipNativeSession).toHaveBeenCalledOnce();
    } finally {
      claim.mockRestore();
      keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    }
  });

  it("passes preparation renewal ownership to native dispatch", async () => {
    const { input } = await fixture(true);
    const acquired = vi.fn(async () => undefined);
    input.runtime.runOptions.onNativeExecutionLeaseAcquired = acquired;
    await executeHeartbeatRuntime(db, input);
    expect(executePaperclipNativeSession).toHaveBeenCalledWith(expect.objectContaining({ onExecutionLeaseAcquired: acquired }));
    // Preparation is still protected until the native executor claims its lease.
    expect(acquired).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves the dispatch gate's early return and cleanup (native: %s)", async native => {
    const { input, adapter } = await fixture(native);
    input.control.dispatchResolvedInteractionContinuationWithAtomicGate = async () => ({ dispatched: false });
    expect(await executeHeartbeatRuntime(db, input)).toEqual({ dispatched: false });
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(executePaperclipNativeSession).not.toHaveBeenCalled();
    expect(input.effects.onNativeDispatchStarted).not.toHaveBeenCalled();
    expect(input.effects.onLegacyAdapterEntered).not.toHaveBeenCalled();
    expect(await finalizations()).toHaveLength(0);
    expectCleanup(input);
  });

  it("captures usage and live instruction saves before finalizing a legacy workspace", async () => {
    const { input, adapter, run } = await fixture();
    adapter.execute.mockImplementationOnce(async ctx => {
      expect(input.effects.onLegacyAdapterEntered).toHaveBeenCalledOnce();
      expect(input.effects.onUsageCaptureReady).toHaveBeenCalledOnce();
      await ctx.onProviderStopped?.();
      return { exitCode: 0, signal: null, timedOut: false, usage: { inputTokens: 10, outputTokens: 4 }, costUsd: 0.01, provider: "test" };
    });
    expect(await executeHeartbeatRuntime(db, input)).toMatchObject({ dispatched: true, adapterResult: { usageComplete: true, resultJson: { instructionSave: { state: "saved", revisionId: "during-execution" } } } });
    expect(await read(run.id)).toMatchObject({ status: "running", costAccountingPending: true, usageJson: { inputTokens: 10, outputTokens: 4, accountingReceiptReady: true } });
    expect(await db.select().from(runUsageReceipts)).toHaveLength(1);
    expect(await finalizations()).toMatchObject([{ status: "succeeded" }]);
    expectCleanup(input);
  });

  it("preserves Stop metadata and marks no-work accounting without manufacturing a receipt", async () => {
    const { input, adapter, run } = await fixture();
    await db.update(heartbeatRuns).set({ status: "cancelled", resultJson: { stoppedByUser: true } }).where(eq(heartbeatRuns.id, run.id));
    adapter.execute.mockResolvedValueOnce({ exitCode: 0, signal: null, timedOut: false, executionRecovery: { kind: "bootstrap", providerWorkStarted: false } });
    await executeHeartbeatRuntime(db, input);
    expect(await read(run.id)).toMatchObject({ status: "cancelled", resultJson: { stoppedByUser: true }, usageJson: { accountingProviderWorkStarted: false } });
    expect(await db.select().from(runUsageReceipts)).toHaveLength(0);
    expectCleanup(input);
  });

  it("records the failed workspace and keeps the original provider error", async () => {
    const { input, adapter } = await fixture();
    const error = new Error("provider failed");
    adapter.execute.mockRejectedValueOnce(error);
    await expect(executeHeartbeatRuntime(db, input)).rejects.toBe(error);
    expect(await finalizations()).toMatchObject([{ status: "failed", metadata: { errorMessage: "provider failed" } }]);
    expect(input.effects.onLegacyAdapterEntered).toHaveBeenCalledOnce();
    expectCleanup(input);
  });

  it.each([
    [new NativeCancellationPendingRecoveryError(), null],
    [new NativeControllerDetachedForRestartError(), "onNativeSessionResumeScheduled"],
    [new NativeRunnerOwnershipUnverifiedError(), "onNativeOwnershipHeld"],
    [new NativeWorkspaceFinalizationBusyError(), "onNativeWorkspaceFinalizeScheduled"],
    [new NativeWorkspaceFinalizationOwnershipLostError(), "onNativeWorkspaceFinalizeScheduled"],
  ] as const)("transfers recovery ownership for %s before cleanup", async (error, effect) => {
    const { input } = await fixture(true);
    vi.mocked(executePaperclipNativeSession).mockRejectedValueOnce(error);
    input.instructions.releaseInstructionCopy = vi.fn(async () => {
      if (effect) expect(input.effects[effect]).toHaveBeenCalledOnce();
    });
    await expect(executeHeartbeatRuntime(db, input)).rejects.toBe(error);
    expect(input.effects.onNativeDispatchStarted).toHaveBeenCalledOnce();
    expect(input.effects.onLegacyAdapterEntered).not.toHaveBeenCalled();
    expect(await finalizations()).toHaveLength(0);
    if (error instanceof NativeControllerDetachedForRestartError) {
      expect(revokeHeartbeatRunGatewayTokens).not.toHaveBeenCalled();
      expect(input.instructions.releaseInstructionCopy).toHaveBeenCalledOnce();
    } else expectCleanup(input);
  });

  it("dispatches native execution with the selected session and persists its usage", async () => {
    const { input, adapter, run } = await fixture(true);
    vi.mocked(executePaperclipNativeSession).mockImplementationOnce(async native => {
      expect(native.execution).toBe(input.runtime.nativeExecution);
      expect(native.runnerInstanceId).toBe(input.runtime.nativeRunnerInstanceId);
      await native.onUsage?.({ usage: { inputTokens: 7, outputTokens: 3 }, complete: true });
      return { exitCode: 0, signal: null, timedOut: false, usageComplete: false };
    });
    expect(await executeHeartbeatRuntime(db, input)).toMatchObject({ dispatched: true, adapterResult: { usage: { inputTokens: 7, outputTokens: 3 }, usageComplete: true } });
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(input.effects.onNativeDispatchStarted).toHaveBeenCalledOnce();
    expect(await read(run.id)).toMatchObject({ status: "running", usageJson: { inputTokens: 7, outputTokens: 3, accountingReceiptReady: true } });
    expect(await finalizations()).toMatchObject([{ status: "succeeded" }]);
    expectCleanup(input);
  });

  it("returns the accepted exact native rate-card price and preserves its live budget hold", async () => {
    const { input, run } = await fixture(true);
    input.workspace.executionTarget = { kind: "remote", transport: "sandbox", remoteCwd: home };
    input.runtime.nativeExecution!.provider = { kind: "codex", model: "gpt-6.1-sol" };
    await db.insert(budgetPolicies).values({ companyId: run.companyId, scopeType: "agent", scopeId: input.agent.id,
      metric: "billed_cents", windowKind: "lifetime", amount: 100, notifyEnabled: false });
    let exact: string | undefined;
    vi.mocked(executePaperclipNativeSession).mockImplementationOnce(async native => {
      expect(native.onUsage).toBeUndefined();
      const delivery = await createNativeUsageDelivery(db, { companyId: run.companyId, runId: run.id,
        runnerInstanceId: native.runnerInstanceId, provider: native.execution.provider,
        billing: { provider: "openai", biller: "openai", billingType: "metered_api" } });
      const event = (sourceSeq: number, eventType: string, payload: Record<string, unknown>): PrpEvent => ({
        sourceKind: "runner", sourceInstanceId: native.runnerInstanceId, runId: run.id, sourceSeq, sourceEventId: `priced-${sourceSeq}`,
        turnId: "priced-turn", eventType, emittedAt: new Date().toISOString(), payload,
      } as PrpEvent);
      await delivery.capture(event(1, "usage.reported", { runDeltaBasis: "run", runDeltaAvailable: true,
        runDelta: { inputTokens: 1000, outputTokens: 100000, providerCostUsd: 0 } }));
      await delivery.capture(event(2, "turn.completed", {}));
      const saved = (await read(run.id)).usageJson!;
      exact = saved.costUsdExact as string;
      expect(Number(exact)).toBe(1.002);
      expect(saved.budgetExposure).toMatchObject({ costCents: "100.2000000" });
      await flushBudgetEvaluationWork(db, { companyId: run.companyId });
      expect((await db.select().from(agents).where(eq(agents.id, input.agent.id)))[0].lifecycleHolds).toContain("budget");
      return { exitCode: 0, signal: null, timedOut: false, usageComplete: true, costUsd: null, model: "gpt-6.1-sol" };
    });
    const result = await executeHeartbeatRuntime(db, input);
    if (!result.dispatched) throw new Error("expected native dispatch");
    expect(result.adapterResult).toMatchObject({ costUsdExact: exact, costStatus: "estimated", usageComplete: true,
      pricingProvenance: { source: "rate_card" }, usage: { inputTokens: 1000, outputTokens: 100000 } });
  });

  it.each(["expected", "wrong"])("finalizes a plugin worktree through its owner (branch: %s)", async branch => {
    const { input } = await fixture(true);
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: input.agent.companyId,
      name: "Plugin worktree", providerType: "plugin", providerRef: "provider:opaque-worktree", cwd: "/workspaces/plugin-only",
      mode: "isolated_workspace", strategyType: "git_worktree", branchName: "task-branch" }).returning();
    input.workspace.persistedExecutionWorkspace = workspace;
    const inspect = vi.spyOn(pluginWorkspaces, "finalizePluginWorkspace").mockResolvedValue({ kind: "inspection",
      branchName: branch === "expected" ? "task-branch" : "other-branch", headSha: "a".repeat(40),
      hasDirtyTrackedFiles: true, hasUntrackedFiles: false, hasLocalOnlyData: true, isMergedIntoBase: false, remotelyRecoverable: false });
    try {
      const result = executeHeartbeatRuntime(db, input);
      if (branch === "expected") {
        await expect(result).resolves.toMatchObject({ dispatched: true });
        expect(await finalizations()).toMatchObject([{ status: "succeeded" }]);
      } else {
        await expect(result).rejects.toThrow("plugin_workspace_branch_mismatch");
        expect((await finalizations()).some(row => row.status === "succeeded")).toBe(false);
      }
      expect(inspect).toHaveBeenCalledWith(db, undefined, expect.objectContaining({ id: workspace.id, providerRef: workspace.providerRef }), { agentId: input.agent.id, runId: input.run.id });
    } finally { inspect.mockRestore(); }
  });

  it("retains the same-run retry signal without recording a failed workspace", async () => {
    const { input, run } = await fixture(true);
    await db.update(heartbeatRuns).set({ nativeIssueId: input.task.issueId }).where(eq(heartbeatRuns.id, run.id));
    await db.insert(nativeRunFinalizations).values({ companyId: run.companyId, issueId: input.task.issueId!, runId: run.id, phase: "retryable_failure" });
    const error = new Error("session connection lost");
    vi.mocked(executePaperclipNativeSession).mockRejectedValueOnce(error);
    await expect(executeHeartbeatRuntime(db, input)).rejects.toMatchObject({
      name: "NativeSessionResumeScheduledError", original: error,
    });
    expect(input.effects.onNativeSessionResumeScheduled).toHaveBeenCalledOnce();
    expect(await finalizations()).toHaveLength(0);
    expectCleanup(input);
  });

  it("logs a pointer to the docs when a same-run retry follows a failed attachment", async () => {
    const { input, run } = await fixture(true);
    await db.update(heartbeatRuns).set({ nativeIssueId: input.task.issueId }).where(eq(heartbeatRuns.id, run.id));
    await db.insert(nativeRunFinalizations).values({ companyId: run.companyId, issueId: input.task.issueId!, runId: run.id, phase: "retryable_failure" });
    const error = new Error('native_session_recovery_failed: Error: PRP command run.attach failed: {"result":{"message":"run.attach requires a settled Codex provider session: active_turn"}}');
    vi.mocked(executePaperclipNativeSession).mockRejectedValueOnce(error);
    await expect(executeHeartbeatRuntime(db, input)).rejects.toMatchObject({ name: "NativeSessionResumeScheduledError", original: error });
    expect(input.output.onLog).toHaveBeenCalledWith("stderr", expect.stringContaining("doc/execution-semantics.md#session-settlement-after-a-run"));
    expect(input.output.onLog).toHaveBeenCalledWith("stderr", expect.stringContaining("run.attach requires a settled Codex provider session: active_turn"));
    expectCleanup(input);
  });

  it("preserves the retained sandbox while native admission waits for its current owner", async () => {
    const { input } = await fixture(true);
    const error = new NativeControllerRecoveryWaitingError(new Date(Date.now() + 60_000));
    vi.mocked(executePaperclipNativeSession).mockRejectedValueOnce(error);
    await expect(executeHeartbeatRuntime(db, input)).rejects.toMatchObject({
      name: "NativeSessionResumeScheduledError", original: error,
    });
    expect(input.effects.onNativeSessionResumeScheduled).toHaveBeenCalledOnce();
    expect(input.effects.onProviderResourceDisposition).not.toHaveBeenCalledWith("stop_and_retain");
    expect(await finalizations()).toHaveLength(0);
  });

  it("records native restoration inside the workspace finalization operation", async () => {
    const { input, run } = await fixture(true);
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
    const exporter = new InMemorySpanExporter();
    const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
    expect(trace.setGlobalTracerProvider(provider)).toBe(true);
    const restore = vi.fn(async () => {
      expect(await finalizations()).toMatchObject([{
        status: "running", metadata: { owningService: "native_workspace_finalizer" },
      }]);
      await measureWorkspaceSyncPhase("workspace.restore", async () => {});
      await measureRunPhase("execution.workspace_commit", async () => {});
    });
    input.workspace.nativeWorkspaceSync = {
      mode: "host_current",
      reference: { schema: "paperclip.native-workspace-sync/v3", state: "prepared",
        descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
        workspaceId: run.id, leaseId: randomUUID(), providerLeaseId: "sandbox", remoteCwd: "/workspace", resourceDisposition: null },
      restoreWorkspace: restore,
      cleanup: vi.fn(async () => {}),
    };
    try {
      expect(await withRunExecutionTiming(run.id, () => executeHeartbeatRuntime(db, input))).toMatchObject({ dispatched: true });
      expect(restore).toHaveBeenCalledOnce();
      expect(await finalizations()).toMatchObject([{
        status: "succeeded", metadata: { owningService: "native_workspace_finalizer" },
      }]);
      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();
      const attempt = spans.find(span => span.name === "task.execution_attempt")!;
      expect(attempt).toBeDefined();
      for (const name of ["execution.usage_startup", "execution.mcp_handoff", "execution.dispatch_admission"]) {
        const startup = spans.filter(span => span.name === name);
        expect(startup).toHaveLength(1);
        expect(startup[0].parentSpanContext?.spanId).toBe(attempt.spanContext().spanId);
      }
      const copyback = spans.filter(span => span.name === "execution.workspace_restore");
      const commit = spans.filter(span => span.name === "execution.workspace_commit");
      expect(copyback).toHaveLength(1);
      expect(commit).toHaveLength(1);
      const finalization = spans.find(span => span.name === "execution.workspace_finalize")!;
      expect(finalization).toBeDefined();
      for (const child of [...copyback, ...commit]) expect(child.parentSpanContext?.spanId).toBe(finalization.spanContext().spanId);
    } finally {
      vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
      trace.disable();
      await provider.shutdown();
    }
  });

  it.each([false, true])("ends admission timing without losing later provider spans (native: %s)", async native => {
    const { input, adapter, run } = await fixture(native);
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector.test");
    const exporter = new InMemorySpanExporter();
    const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
    expect(trace.setGlobalTracerProvider(provider)).toBe(true);
    let release!: (result: Awaited<ReturnType<typeof executePaperclipNativeSession>>) => void;
    const providerResult = new Promise<Awaited<ReturnType<typeof executePaperclipNativeSession>>>(resolve => { release = resolve; });
    const providerWork = async () => {
      const result = await providerResult;
      await createRunPreparationTiming(run.id, "native.controller")("coordinator_release", async () => {});
      return result;
    };
    if (native) vi.mocked(executePaperclipNativeSession).mockImplementationOnce(providerWork);
    else adapter.execute.mockImplementationOnce(providerWork);
    const running = withRunExecutionTiming(run.id, () => executeHeartbeatRuntime(db, input));
    try {
      await vi.waitFor(() => {
        expect(exporter.getFinishedSpans().filter(span => span.name === "execution.dispatch_admission")).toHaveLength(1);
      }, { timeout: 5_000 });
      expect(native ? executePaperclipNativeSession : adapter.execute).toHaveBeenCalledOnce();
      expect(exporter.getFinishedSpans().find(span => span.name === "task.execution_attempt")).toBeUndefined();
      expect(await finalizations()).toHaveLength(0);
      release({ exitCode: 0, signal: null, timedOut: false });
      await running;
      const spans = exporter.getFinishedSpans();
      const attempt = spans.find(span => span.name === "task.execution_attempt")!;
      const later = spans.filter(span => span.name === "native.controller.coordinator_release");
      expect(later).toHaveLength(1);
      expect(later[0].spanContext().traceId).toBe(attempt.spanContext().traceId);
      expect(later[0].parentSpanContext?.spanId).toBe(attempt.spanContext().spanId);
    } finally {
      release({ exitCode: 0, signal: null, timedOut: false });
      await running;
      vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint);
      trace.disable();
      await provider.shutdown();
    }
  });

  it.each(["codex", "grok_bot", "openai_dot"] as const)("retains user files only when %s can access the workspace after a dispatch failure", async provider => {
    const { input, run } = await fixture(true, provider);
    input.workspace.nativeWorkspaceSync = {
      mode: "host_current",
      reference: { schema: "paperclip.native-workspace-sync/v3", state: "prepared",
        descriptorSha256: "a".repeat(64), baselineSha256: "b".repeat(64), finalHostSha256: null,
        workspaceId: run.id, leaseId: randomUUID(), providerLeaseId: "sandbox", remoteCwd: "/workspace", resourceDisposition: "destroy" },
      restoreWorkspace: vi.fn(), cleanup: vi.fn(),
    };
    const error = new Error("runner_remote_process_identity_unavailable");
    vi.mocked(executePaperclipNativeSession).mockRejectedValueOnce(error);
    input.instructions.releaseInstructionCopy = vi.fn(async () => {
      if (provider === "codex") expect(input.effects.onProviderResourceDisposition).toHaveBeenCalledWith("stop_and_retain");
      else expect(input.effects.onProviderResourceDisposition).not.toHaveBeenCalledWith("stop_and_retain");
    });
    await expect(executeHeartbeatRuntime(db, input)).rejects.toBe(error);
    expect(input.workspace.nativeWorkspaceSync.restoreWorkspace).not.toHaveBeenCalled();
    expectCleanup(input);
  });

  it("records a failed barrier if the successful finalization write fails", async () => {
    const { input } = await fixture();
    const error = new Error("finalization write failed");
    vi.spyOn(input.workspace.workspaceOperationRecorder, "recordOperation").mockRejectedValueOnce(error);
    await expect(executeHeartbeatRuntime(db, input)).rejects.toBe(error);
    expect(await finalizations()).toMatchObject([{ status: "failed" }]);
    expectCleanup(input);
  });

  it("retains a failed sandbox restore even when persisting its receipt throws", async () => {
    const { input, adapter, run } = await fixture();
    input.workspace.executionTarget = { kind: "remote", transport: "sandbox", remoteCwd: home };
    const evidence = { workspaceRestoreFailure: "restore_failed", workspaceRestoreDiagnostic: { message: "copy-back failed" } };
    adapter.execute.mockResolvedValueOnce({ exitCode: 0, signal: null, timedOut: false, resultJson: evidence });
    const order: string[] = [];
    input.effects.onWorkspaceRestoreFailure = vi.fn(() => { order.push("restore evidence"); });
    input.effects.onProviderResourceDisposition = vi.fn(() => { order.push("retain sandbox"); });
    input.instructions.releaseInstructionCopy = vi.fn(async () => { order.push("cleanup"); });
    const error = new Error("restore receipt write failed");
    const record = vi.spyOn(legacyRecovery, "recordLegacyWorkspaceRestoreFailure").mockImplementationOnce(async () => {
      order.push("receipt write");
      throw error;
    });
    try {
      await expect(executeHeartbeatRuntime(db, input)).rejects.toBe(error);
      expect(record).toHaveBeenCalledWith(db, run, evidence, input.workspace.workspaceRestoreSource);
      expect(input.effects.onWorkspaceRestoreFailure).toHaveBeenCalledWith(evidence);
      expect(input.effects.onProviderResourceDisposition).toHaveBeenCalledWith("stop_and_retain");
      expect(order).toEqual(["restore evidence", "retain sandbox", "receipt write", "cleanup"]);
      expect(await finalizations()).toMatchObject([{ status: "failed" }]);
      expectCleanup(input);
    } finally { record.mockRestore(); }
  });

  it("runs instruction cleanup even when gateway revocation fails", async () => {
    const { input } = await fixture();
    vi.mocked(revokeHeartbeatRunGatewayTokens).mockRejectedValueOnce(new Error("gateway unavailable"));
    expect(await executeHeartbeatRuntime(db, input)).toMatchObject({ dispatched: true });
    expectCleanup(input);
  });
});
