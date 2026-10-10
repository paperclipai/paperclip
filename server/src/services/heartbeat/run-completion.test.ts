import type { Db } from "@paperclipai/db";
import { agents, agentWakeupRequests, companies, costEvents, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import * as usageReceipts from "../usage-receipts.js";
import { createAgentIdentityRedactor } from "../agent-identity-redaction.js";
import { UnresolvedWorkspaceBaseRefError } from "../workspace-runtime.js";
import { createHeartbeatLifecycle, type HeartbeatLifecycleDependencies } from "./run-lifecycle.js";
import { createHeartbeatRunPreparation, ConfigurationIncompleteFailure } from "./run-preparation.js";
import { createHeartbeatRunState, getAdapterSessionCodec } from "./run-state.js";
import { buildEffectiveRunSessionConfigMetadata } from "./workspaces.js";
import { createHeartbeatRunCompletion, type CompleteHeartbeatRunInput, type FailHeartbeatRunInput, type HeartbeatRunCompletionDependencies } from "./run-completion.js";

vi.mock("../live-events.js", () => ({ publishLiveEvent: vi.fn() }));

type Dependencies = HeartbeatRunCompletionDependencies;
function callbacks(db: Db) {
  const state = createHeartbeatRunState(db);
  const lifecycleDeps = {
    ...state, ...createHeartbeatRunPreparation(db),
    issuesSvc: { addComment: vi.fn(), listReviewAttention: vi.fn() },
    recovery: { escalateStrandedAssignedIssue: vi.fn() },
    companySkills: { completeTestRunForIssue: vi.fn() },
    budgets: { getInvocationBlock: vi.fn(async () => null) },
    treeControlSvc: { getActivePauseHoldGate: vi.fn(async () => null) },
    enqueueWakeup: vi.fn(),
    getCurrentUserRedactionOptions: vi.fn(async () => ({ enabled: false })),
    getAgentInvokability: vi.fn<HeartbeatLifecycleDependencies["getAgentInvokability"]>(async () => ({ invokable: true })),
    emitTerminalAgentTaskRun: vi.fn(), budgetHooks: {},
  } satisfies HeartbeatLifecycleDependencies;
  const lifecycle = createHeartbeatLifecycle(db, lifecycleDeps);
  return {
    ...state, ...lifecycle,
    setRunStatusIfRunning: vi.fn(lifecycle.setRunStatusIfRunning),
    setWakeupStatus: vi.fn(lifecycle.setWakeupStatus),
    upsertTaskSession: vi.fn(state.upsertTaskSession),
    clearTaskSessions: vi.fn(state.clearTaskSessions),
    classifyAndPersistRunLiveness: vi.fn<Dependencies["classifyAndPersistRunLiveness"]>(async run => run),
    completeSkillTestRunForHeartbeatOutcome: vi.fn<Dependencies["completeSkillTestRunForHeartbeatOutcome"]>(async () => null),
    refreshContinuationSummaryForRun: vi.fn<Dependencies["refreshContinuationSummaryForRun"]>(async () => null),
    findRunIssueComment: vi.fn<Dependencies["findRunIssueComment"]>(async () => null),
    findLatestCompletedFinalAgentMessage: vi.fn<Dependencies["findLatestCompletedFinalAgentMessage"]>(async () => null),
    finalizeIssueCommentPolicy: vi.fn<Dependencies["finalizeIssueCommentPolicy"]>(async () => ({ outcome: "not_applicable", queuedRun: null })),
    handleIssueReviewPathDisposition: vi.fn<Dependencies["handleIssueReviewPathDisposition"]>(async () => undefined),
    handleRunLivenessContinuation: vi.fn<Dependencies["handleRunLivenessContinuation"]>(),
    handleSuccessfulRunHandoff: vi.fn<Dependencies["handleSuccessfulRunHandoff"]>(),
    updateRuntimeState: vi.fn<Dependencies["updateRuntimeState"]>(),
    scheduleBoundedRetryForRun: vi.fn<Dependencies["scheduleBoundedRetryForRun"]>(),
    scheduleInteractionContinuationInfrastructureRetryIfEligible: vi.fn<Dependencies["scheduleInteractionContinuationInfrastructureRetryIfEligible"]>(async () => null),
    timerClaimWasFirstHeartbeat: vi.fn<Dependencies["timerClaimWasFirstHeartbeat"]>(() => undefined),
    releaseIssueExecutionAndPromote: vi.fn<Dependencies["releaseIssueExecutionAndPromote"]>(async () => undefined),
    finalizeAgentStatus: vi.fn<Dependencies["finalizeAgentStatus"]>(async () => undefined),
    enqueueWakeup: vi.fn<Dependencies["enqueueWakeup"]>(),
    issuesSvc: { addComment: vi.fn<Dependencies["issuesSvc"]["addComment"]>() },
    recovery: { reconcileLegacyContinuation: vi.fn<Dependencies["recovery"]["reconcileLegacyContinuation"]>(), reconcileResolvedDependencyWakeBackstop: vi.fn<Dependencies["recovery"]["reconcileResolvedDependencyWakeBackstop"]>() },
    getCurrentUserRedactionOptions: lifecycleDeps.getCurrentUserRedactionOptions,
    budgetHooks: {},
    runLogStore: { finalize: vi.fn<Dependencies["runLogStore"]["finalize"]>(async () => ({ bytes: 123, sha256: "log-hash", compressed: true })) },
    traceStore: { finalize: vi.fn<Dependencies["traceStore"]["finalize"]>() },
    processRunCancellationSettlements: new Map<string, { settled: Promise<void>; failed: boolean }>(),
    failedProcessRunCancellations: new Map<string, { settled: Promise<void>; failed: boolean }>(),
  } satisfies Dependencies;
}

it("constructs completion handlers without querying or starting work", () => {
  const access = vi.fn(() => { throw new Error("Unexpected database access"); });
  const db = new Proxy({}, { get: access }) as Db;
  const deps = callbacks(db);
  createHeartbeatRunCompletion(db, deps);
  expect(access).not.toHaveBeenCalled();
  for (const callback of Object.values(deps)) if (vi.isMockFunction(callback)) expect(callback).not.toHaveBeenCalled();
});

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("heartbeat run completion boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    // Keep the accounting transaction real without reading provider receipt files.
    vi.spyOn(usageReceipts, "indexPendingUsageReceipts").mockResolvedValue(new Map());
    vi.spyOn(usageReceipts, "recoverPendingRunUsageReceipts").mockResolvedValue([]);
    database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-completion");
    db = createDb(database.connectionString);
    await db.execute(sql`set client_min_messages = warning`);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); vi.restoreAllMocks(); });
  beforeEach(async () => { await db.execute(sql`truncate table companies restart identity cascade`); });

  async function fixture(patch: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
    const [company] = await db.insert(companies).values({ name: "Completion", issuePrefix: "CMP" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Completing agent", adapterType: "process" }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id, source: "on_demand", status: "claimed" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, wakeupRequestId: wake.id, status: "running", runtimeMode: "legacy", ...patch }).returning();
    const deps = callbacks(db);
    const controller = new AbortController();
    const input: CompleteHeartbeatRunInput = {
      run, agent, issueId: null, issueRef: null, signal: controller.signal,
      output: { handle: { store: "local_file", logRef: "test-log" }, outputProgressState: { pending: { bytes: 7 } }, flushOutputProgress: vi.fn(async () => {}), stdoutExcerpt: "answer", stderrExcerpt: "diagnostic" },
      session: { runtimeForAdapter: { sessionId: null, sessionDisplayId: null }, previousSessionParams: null, taskKey: "completion-task", configuredModel: "test-model",
        sessionConfigMetadata: await buildEffectiveRunSessionConfigMetadata({ adapterType: agent.adapterType, effectiveAdapterConfig: {}, agentRuntimeConfig: {}, issueOverrides: null, workspaceConfig: null, environment: null, environmentEnv: null, projectEnv: null, routineEnv: null, runtimeSkills: [] }),
      },
      readFailureReportSecrets: () => [],
      adapterResult: { exitCode: 0, signal: null, timedOut: false, sessionId: "provider-session", sessionParams: { sessionId: "provider-session" }, usage: { inputTokens: 20, cachedInputTokens: 5, outputTokens: 8 }, usageBasis: "per_run", costUsd: 0.01, provider: "test", model: "test-model", resultJson: { finalResponse: "Completed the work." } },
      sessionCodec: getAdapterSessionCodec(agent.adapterType), taskSessionForRun: null, sessionCompaction: { rotate: false, reason: null }, configFreshnessResultMetadata: { version: 1 }, runLedgerScope: {}, currentUserRedactionOptions: { enabled: false }, providerTraceCapture: true, onProviderTraceFinalized: vi.fn(), issueContext: null, onLog: vi.fn(async () => {}),
    };
    const completion = createHeartbeatRunCompletion(db, deps);
    const failure = (err: unknown): FailHeartbeatRunInput => ({ ...input, runId: run.id, err, identityRedactor: createAgentIdentityRedactor("private-identity-material"), requiredWorkspaceRestoreEvidence: { workspaceRestoreFailure: { reason: "missing_base" } }, legacyAdapterEntered: true, goalCheckpointSession: { current: null }, previousSessionDisplayId: "previous-session", taskSession: null });
    const setup = (outerErr: unknown) => ({ run, runId: run.id, outerErr, identityRedactor: createAgentIdentityRedactor(), readFailureReportSecrets: () => [] });
    return { run, agent, wake, deps, controller, input, completion, failure, setup };
  }
  const read = (id: string) => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)).then(rows => rows[0]!);

  it("persists usage, accounting, final logs, presentation and the next task session", async () => {
    const f = await fixture();
    await f.completion.completeRun(f.input);
    expect(await read(f.run.id)).toMatchObject({ status: "succeeded", sessionIdAfter: "provider-session", logBytes: 123, logSha256: "log-hash", logCompressed: true, stdoutExcerpt: "answer", costAccountingPending: false, costAccountedAt: expect.any(Date), usageJson: { inputTokens: 20, cachedInputTokens: 5, outputTokens: 8, usageSource: "per_run", configFreshness: { version: 1 } }, resultJson: { presentationDecision: { commentAction: "none" } } });
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, f.run.id))).toHaveLength(1);
    expect((await f.deps.getTaskSession(f.agent.companyId, f.agent.id, f.agent.adapterType, "completion-task"))?.sessionDisplayId).toBe("provider-session");
    expect(f.input.output.outputProgressState.pending?.bytes).toBe(123);
    expect(f.input.onProviderTraceFinalized).toHaveBeenCalledOnce();
    expect(f.deps.setWakeupStatus).toHaveBeenCalledWith(f.wake.id, "completed", expect.any(Object));
    expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledOnce();
    expect(f.deps.finalizeAgentStatus).toHaveBeenCalledWith(f.agent.id, "succeeded", null, expect.any(Object));
  });

  it.each([
    { name: "successful terminal cleanup", expected: "succeeded", patch: {} },
    { name: "real auth failure", expected: "failed", patch: { errorCode: "claude_auth_required", errorMessage: "Failed to authenticate" } },
    { name: "forced cleanup", expected: "failed", patch: { resultJson: { subtype: "success", is_error: false, unmanagedBackgroundTask: { kind: "terminal_result_cleanup", stopped: true, terminalResultSeen: true, signal: "SIGKILL", forceKilled: true } } } },
    { name: "explicit stop", expected: "cancelled", patch: {}, stop: true },
  ])("records $name without rewriting the physical cleanup exit", async ({ expected, patch, stop }) => {
    const f = await fixture(); f.agent.adapterType = "claude_local";
    Object.assign(f.input.adapterResult, { exitCode: 143, signal: null, timedOut: false, errorMessage: null,
      resultJson: { type: "result", subtype: "success", is_error: false, unmanagedBackgroundTask: {
        kind: "terminal_result_cleanup", stopped: true, terminalResultSeen: true, signal: "SIGTERM", forceKilled: false,
      } }, ...patch });
    if (stop) f.controller.abort();
    await f.completion.completeRun(f.input);
    expect(await read(f.run.id)).toMatchObject({ status: expected, exitCode: 143 });
  });

  it.each([
    { timedOut: true, expected: "timed_out", errorCode: "timeout" },
    { signal: "SIGTERM", expected: "failed", errorCode: "adapter_failed" },
    { errorMessage: "provider quota", errorCode: "provider_quota", expected: "failed" },
  ])("keeps adapter outcome classification ($expected, $errorCode)", async ({ expected, ...result }) => {
    const f = await fixture();
    Object.assign(f.input.adapterResult, result);
    await f.completion.completeRun(f.input);
    expect(await read(f.run.id)).toMatchObject({ status: expected, errorCode: result.errorCode });
    expect(f.deps.finalizeAgentStatus).toHaveBeenCalledWith(f.agent.id, expected, expect.any(String), expect.objectContaining({ keepIdleOnFailure: result.errorCode === "provider_quota" }));
  });

  it.each(["completeRun", "failRun"] as const)("waits for an owned Stop before %s can write a competing outcome", async operation => {
    const f = await fixture();
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    f.deps.processRunCancellationSettlements.set(f.run.id, { settled, failed: false });
    const completion = operation === "completeRun" ? f.completion.completeRun(f.input) : f.completion.failRun(f.failure(new Error("late adapter error")));
    await Promise.resolve();
    expect(f.deps.setRunStatusIfRunning).not.toHaveBeenCalled();
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
    f.controller.abort();
    settle();
    await completion;
    expect((await read(f.run.id)).status).toBe("cancelled");
    if (operation === "completeRun") {
      expect((await read(f.run.id)).sessionIdAfter).toBe("provider-session");
      expect(f.deps.finalizeAgentStatus).toHaveBeenCalledWith(f.agent.id, "cancelled", expect.any(String), expect.any(Object));
    } else expect(f.deps.finalizeAgentStatus).not.toHaveBeenCalled();
  });

  it("does not publish or overwrite a conflicting terminal transition that wins the compare-and-set", async () => {
    const f = await fixture();
    const write = f.deps.setRunStatusIfRunning.getMockImplementation()!;
    f.deps.setRunStatusIfRunning.mockImplementationOnce(async (...args) => {
      await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled", resultJson: { winner: "Stop" } }).where(eq(heartbeatRuns.id, f.run.id));
      return write(...args);
    });
    await f.completion.completeRun(f.input);
    expect(await read(f.run.id)).toMatchObject({ status: "cancelled", resultJson: { winner: "Stop" }, sessionIdAfter: null });
    expect(f.deps.setWakeupStatus).not.toHaveBeenCalled();
    expect(f.deps.updateRuntimeState).not.toHaveBeenCalled();
    expect(f.deps.releaseIssueExecutionAndPromote).not.toHaveBeenCalled();
    expect(f.deps.finalizeAgentStatus).not.toHaveBeenCalled();
  });

  it("retains native completion metadata when reconciliation already committed the same terminal status", async () => {
    const finishedAt = new Date("2026-10-09T12:00:00Z");
    const f = await fixture({ runtimeMode: "native", status: "succeeded", finishedAt, resultJson: { durable: "accepted" }, usageJson: { durableReceipt: "native" } });
    f.input.adapterResult.nativeFinalization = { schema: "paperclip.native-finalization.v1", runtimeMode: "native", runId: f.run.id, companyId: f.run.companyId, issueId: "unused", result: {}, terminal: { schema: "paperclip.prp.terminal.v1", turnTerminalState: "completed", runTerminalState: "succeeded", reportedWorkDisposition: "done" }, turnId: null, sourceInstanceId: "test", normalizedSessionId: "native-session", providerSessionId: null, driverKind: "test", driverVersion: "1", nativeEventCount: 1, highestContiguousSourceSeq: 1, workspaceFinalizeStatus: "succeeded" };
    await f.completion.completeRun(f.input);
    expect(await read(f.run.id)).toMatchObject({ status: "succeeded", finishedAt, sessionIdAfter: "provider-session", resultJson: { durable: "accepted" }, usageJson: { durableReceipt: "native", inputTokens: 20 } });
    expect(f.deps.updateRuntimeState).toHaveBeenCalledOnce();
  });

  it("reports trace completion before a later write throws and reads output after log finalization", async () => {
    const f = await fixture();
    let excerpt = "before finalize";
    Object.defineProperty(f.input.output, "stdoutExcerpt", { get: () => excerpt });
    f.deps.runLogStore.finalize.mockImplementationOnce(async () => { excerpt = "last provider output"; return { bytes: 99, compressed: false }; });
    const writeError = new Error("write failed");
    f.deps.setRunStatusIfRunning.mockRejectedValueOnce(writeError);
    await expect(f.completion.completeRun(f.input)).rejects.toBe(writeError);
    expect(f.input.onProviderTraceFinalized).toHaveBeenCalledOnce();
    expect(f.deps.setRunStatusIfRunning).toHaveBeenCalledWith(f.run.id, "succeeded", expect.objectContaining({ stdoutExcerpt: "last provider output", logBytes: 99 }), expect.any(Object));
  });

  it("keeps a failed trace finalization eligible for the executor's cleanup retry", async () => {
    const f = await fixture();
    f.deps.traceStore.finalize.mockRejectedValueOnce(new Error("trace store unavailable"));
    await f.completion.completeRun(f.input);
    expect((await read(f.run.id)).status).toBe("succeeded");
    expect(f.input.onProviderTraceFinalized).not.toHaveBeenCalled();
  });

  it("keeps completion and session persistence moving after a response comment fails", async () => {
    const f = await fixture();
    f.input.adapterResult.resultJson = { finalResponseDisposition: "final", finalResponse: "Completed the work." };
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Report the result" }).returning();
    f.input.issueId = issue.id;
    f.input.issueRef = issue;
    f.input.issueContext = await createHeartbeatRunPreparation(db).getIssueExecutionContext(f.run.companyId, issue.id);
    f.deps.issuesSvc.addComment.mockRejectedValueOnce(new Error("comment unavailable"));
    await f.completion.completeRun(f.input);
    expect(f.deps.issuesSvc.addComment).toHaveBeenCalledOnce();
    expect(f.input.onLog).toHaveBeenCalledWith("stderr", expect.stringContaining("comment unavailable"));
    expect((await read(f.run.id)).status).toBe("succeeded");
    expect(f.deps.upsertTaskSession).toHaveBeenCalledOnce();
    expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledOnce();
    expect(f.deps.finalizeAgentStatus).toHaveBeenCalledOnce();
  });

  it("clears only the completed task session when the adapter requests a reset", async () => {
    const f = await fixture();
    f.input.adapterResult.clearSession = true;
    await f.completion.completeRun(f.input);
    expect(f.deps.clearTaskSessions).toHaveBeenCalledWith(f.run.companyId, f.agent.id, { taskKey: "completion-task", adapterType: "process", expectedRunId: f.run.id });
    expect(f.deps.upsertTaskSession).not.toHaveBeenCalled();
  });

  it("redacts execution failures, retains restore evidence and resumes the latest checkpoint", async () => {
    const f = await fixture();
    const failure = f.failure(new Error("private-identity-material crashed"));
    failure.goalCheckpointSession.current = { params: { sessionId: "checkpoint" }, displayId: "checkpoint" };
    await f.completion.failRun(failure);
    const run = await read(f.run.id);
    expect(run).toMatchObject({ status: "failed", errorCode: "adapter_failed", logBytes: 123, resultJson: { workspaceRestoreFailure: { reason: "missing_base" } } });
    expect(run.error).not.toContain("private-identity-material");
    expect((await f.deps.getTaskSession(f.agent.companyId, f.agent.id, f.agent.adapterType, "completion-task"))?.sessionDisplayId).toBe("checkpoint");
    expect(f.deps.finalizeAgentStatus).toHaveBeenCalledOnce();
  });

  it("still records failure and releases issue ownership when log finalization and progress flushing fail", async () => {
    const f = await fixture();
    f.deps.runLogStore.finalize.mockRejectedValueOnce(new Error("log unavailable"));
    f.input.output.flushOutputProgress = vi.fn(async () => { throw new Error("progress unavailable"); });
    await f.completion.failRun(f.failure(new Error("adapter failed")));
    expect((await read(f.run.id)).status).toBe("failed");
    expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledOnce();
    expect(f.deps.finalizeAgentStatus).toHaveBeenCalledOnce();
  });

  it("keeps durable result-less native failure authoritative and suppresses generic replacement recovery", async () => {
    const f = await fixture({ runtimeMode: "native", status: "failed", errorCode: "native_result_missing" });
    const [issue] = await db.insert(issues).values({ companyId: f.run.companyId, title: "Native recovery" }).returning();
    await db.update(heartbeatRuns).set({ nativeIssueId: issue.id }).where(eq(heartbeatRuns.id, f.run.id));
    await db.insert(nativeRunFinalizations).values({ runId: f.run.id, companyId: f.run.companyId, issueId: issue.id, phase: "terminal_failure", failureCode: "native_result_missing" });
    await f.completion.failRun(f.failure(new Error("transport ended")));
    expect((await read(f.run.id)).errorCode).toBe("native_result_missing");
    expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledWith(expect.objectContaining({ id: f.run.id }), { suppressImmediateRecovery: true });
  });

  it("records a setup configuration gap without inventing provider work or applying comment policy", async () => {
    const f = await fixture();
    await f.completion.failRunSetup(f.setup(new ConfigurationIncompleteFailure("missing credential", { configurationIncomplete: { reason: "missing_binding" } })));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "configuration_incomplete", resultJson: { configurationIncomplete: { reason: "missing_binding" }, executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } });
    expect(f.deps.finalizeIssueCommentPolicy).not.toHaveBeenCalled();
    expect(f.deps.releaseIssueExecutionAndPromote).toHaveBeenCalledOnce();
    expect(f.deps.finalizeAgentStatus).toHaveBeenCalledOnce();
  });

  it("retains the default branch needed to repair an unresolved workspace base ref", async () => {
    const f = await fixture();
    const error = new UnresolvedWorkspaceBaseRefError({
      requestedRef: "main", recoveryIdentityRef: "origin/main", attemptedRefs: ["origin/main"], defaultBranch: "master",
    });
    await f.completion.failRunSetup(f.setup(error));
    expect(await read(f.run.id)).toMatchObject({ status: "failed", errorCode: "configuration_incomplete", resultJson: {
      configurationIncomplete: { reason: "workspace_base_ref_unresolved", requestedRef: "main", defaultBranch: "master", attemptedRefs: ["origin/main"], fingerprint: "workspace_base_ref:origin/main" },
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    } });
  });

  it("leaves a winning terminal outcome and agent state untouched after a late setup error", async () => {
    const f = await fixture({ status: "succeeded", resultJson: { winner: "completion" } });
    await f.completion.failRunSetup(f.setup(new Error("late setup error")));
    expect(await read(f.run.id)).toMatchObject({ status: "succeeded", resultJson: { winner: "completion" } });
    expect(f.deps.setWakeupStatus).not.toHaveBeenCalled();
    expect(f.deps.releaseIssueExecutionAndPromote).not.toHaveBeenCalled();
    expect(f.deps.finalizeAgentStatus).not.toHaveBeenCalled();
  });
});
