import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, completionContracts, nativeRunResults, workspaceOperations, createDb, environmentLeases, heartbeatRuns, issueComments, issueRecoveryActions, issues, nativeRunFinalizations, statusDecisionEffects, statusDecisions } from "@paperclipai/db";
import type { ControlPlanePort, NativeExecutionInputV1, PrpEvent, PrpTerminalState } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT } from "../../vendor/paperclip-runner/testing.js";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
const sentry = vi.hoisted(() => ({ captureRunFailure: vi.fn() }));
vi.mock("../../sentry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sentry.js")>()), captureRunFailure: sentry.captureRunFailure,
}));
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()), executeNativeSession: provider.execute,
}));
import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { endSupersededNativeFinalizationRuns, finalizeNativeRun, NATIVE_FINALIZATION_SUPERSEDED } from "./native-run-finalizer.js";
import { projectCommittedRun } from "./native-run-projection.js";
import { NATIVE_RUN_FINALIZATION_WORK_QUERY } from "../idle-sleep-safety.js";
import { nativeResponsePresentationCandidates } from "./native-response-presentation-query.js";
import { admitExplicitNativeContinuation } from "../explicit-native-continuation.js";
import { readPersistedNativeProviderFailure } from "./native-provider-failure-evidence.js";
import { NATIVE_PROVIDER_OVERLOADED_MESSAGE } from "./native-provider-failure.js";
import { heartbeatService } from "../heartbeat.js";
import { createPostgresWakeQueueAdapter } from "../../modules/wake-queue/adapters/postgres.js";
import { createReleaseIssueExecution } from "../../modules/wake-queue/application/use-cases.js";
import { buildExecutionContinuation } from "../execution-continuation.js";
import { waitForPendingRunFailureReports } from "../run-failure-report.js";
import { projectTaskInterruption } from "../task-interruption-presentation.js";

describe("durable native provider capacity retry", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID();
  const providerDisplayMessage = "Distinctive upstream explanation for the task display only.";
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_SENTRY_RUN_FAILURES", "unexpected");
    temporary = await startEmbeddedPostgresTestDatabase("native-capacity-retry-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Capacity regression", issuePrefix: "CAP" });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Capacity worker", status: "active", adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "test-model" } },
      { id: otherAgentId, companyId, name: "New owner", status: "active", adapterType: "paperclip_runner" },
    ]);
  });
  afterAll(async () => { vi.unstubAllEnvs(); await temporary?.cleanup(); });

  async function acceptCapacityFailure(runId: string, issueId: string, mutateOwner = false) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [run] = await db.update(heartbeatRuns).set({ status: "running", runtimeMode: "native", nativeIssueId: issueId, error: null, errorCode: null }).where(eq(heartbeatRuns.id, runId)).returning();
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const contractInput = buildNativeCompletionContract(issue, { revision: contract.revision });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1", binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: { kind: "codex", model: "test-model" },
      task: { identifier: issueId, title: issue.title, description: null, prompt: "Continue the task using its history.", workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1", contract: contractInput },
      interactionResponses: [], credentialBindings: [],
    };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, runId));
    const providerFailure = { schema: "paperclip.provider-failure.v1", provider: "openai", phase: "turn",
      category: "overloaded", message: providerDisplayMessage, retryability: "transient" };
    const event: PrpEvent = {
      schema: "paperclip.prp.event.v1", runId, normalizedSessionId: native.normalizedSessionId, turnId: native.turnId,
      sourceInstanceId: native.runnerInstanceId, sourceEventId: "overload", sourceSeq: 1, sourceKind: "runner", eventType: "turn.failed", schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(),
      payload: { status: "failed", error: { codexErrorInfo: "serverOverloaded", message: NATIVE_PROVIDER_OVERLOADED_MESSAGE, providerFailure } },
    };
    const terminal: PrpTerminalState = { schema: "paperclip.prp.terminal.v1", turnTerminalState: "failed", runTerminalState: "failed", reportedWorkDisposition: "needs_review" };
    const result = { ...CONTROL_PLANE_CONFORMANCE_RESULT, reportedWorkDisposition: "needs_review" as const,
      summary: "I started investigating the task.", completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, contractRevision: contractInput.revision } };
    provider.execute.mockReset().mockImplementation(async (options: { controlPlane: ControlPlanePort }) => {
      await options.controlPlane.openRun({ identity: { companyId, issueId, runId, agentId, sessionId: native.normalizedSessionId }, backendKind: "mock", sourceInstanceId: native.runnerInstanceId });
      await options.controlPlane.appendEvent(event);
      await options.controlPlane.completeRun({ result, terminal, turnId: native.turnId });
      return { result, terminal, turnId: native.turnId, normalizedSessionId: native.normalizedSessionId, providerSessionId: "fixture-session", driverKind: "codex_app_server", driverVersion: "fixture", nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
    });
    const unexpected = async () => { throw new Error("Unexpected provider call"); };
    const adapter = await executePaperclipNativeSession({ db, execution, runnerInstanceId: native.runnerInstanceId, backend: { descriptor: unexpected, openSession: unexpected } });
    expect(adapter).toMatchObject({ errorCode: "native_provider_overloaded", errorMessage: NATIVE_PROVIDER_OVERLOADED_MESSAGE });
    const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(persisted.errorCode).toBeNull(); // Restart before adapter metadata is saved.
    expect(await readPersistedNativeProviderFailure(db, persisted, native.turnId, terminal)).toMatchObject({ errorCode: "native_provider_overloaded" });
    expect(await readPersistedNativeProviderFailure(db, { ...persisted, runnerProfileJson: null }, native.turnId, terminal)).toBeNull();
    expect(await readPersistedNativeProviderFailure(db, persisted, "different-turn", terminal)).toBeNull();
    if (mutateOwner) await db.update(issues).set({ assigneeAgentId: otherAgentId, executionRunId: null }).where(eq(issues.id, issueId));
    for (let replay = 0; replay < 2; replay++) await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    expect(provider.execute).toHaveBeenCalledTimes(1);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]).toMatchObject({ status: "failed", error: NATIVE_PROVIDER_OVERLOADED_MESSAGE, errorCode: "native_provider_overloaded" });
    const [recoveredRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(recoveredRun.resultJson).toMatchObject({ providerFailure });
    expect(projectTaskInterruption(issue, { run: recoveredRun, paused: false, approval: false }))
      .toMatchObject({ providerFailure });
    expect(await db.select().from(statusDecisions).where(eq(statusDecisions.runId, runId))).toHaveLength(1);
  }

  it("retries after one and two minutes across restart/replay, then stops", async () => {
    const issueId = randomUUID(), originalRunId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Capacity task", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "capacity-owner" });
    await db.insert(heartbeatRuns).values({ id: originalRunId, companyId, agentId, responsibleUserId: "capacity-owner", contextSnapshot: { issueId, wakeCommentId: "original-message" } });
    let runId: string = originalRunId;
    const unexpected = vi.fn(async () => { throw new Error("Unexpected recovery"); });
    const release = createReleaseIssueExecution({
      issueLock: createPostgresWakeQueueAdapter(db, { resolveResponsibleUserId: unexpected, getRoutineEnv: unexpected, resolveSessionBeforeForWakeup: unexpected }),
      recovery: { escalateStrandedAssignedIssue: unexpected, escalateStrandedRecoveryIssueInPlace: unexpected },
    });
    for (let failure = 0; failure <= 2; failure++) {
      const before = Date.now();
      sentry.captureRunFailure.mockClear();
      await acceptCapacityFailure(runId, issueId);
      await waitForPendingRunFailureReports();
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, runId)));
      if (failure === 2) {
        expect(successors).toHaveLength(0);
        // Exhaustion ends automatic recovery, so Sentry receives the failure.
        expect(sentry.captureRunFailure).toHaveBeenCalledOnce();
        expect(sentry.captureRunFailure.mock.calls[0]![0]).toMatchObject({ runId, runStatus: "failed" });
        expect(JSON.stringify(sentry.captureRunFailure.mock.calls)).not.toContain(providerDisplayMessage);
        expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ status: "blocked", unblockDescriptor: { action: expect.stringContaining("Automatic retries exhausted") } });
        break;
      }
      expect(successors).toHaveLength(1);
      const retry = successors[0];
      expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: failure + 1, scheduledRetryReason: "native_provider_overloaded", error: NATIVE_PROVIDER_OVERLOADED_MESSAGE,
        contextSnapshot: { issueId, forceFreshSession: true, executionRetryAccounting: { version: 1, failureRetries: failure + 1, maxTurnContinuations: 0 } } });
      expect(retry.contextSnapshot).not.toHaveProperty("wakeCommentId");
      // The scheduled retry owns recovery; this failure stays out of Sentry.
      expect(sentry.captureRunFailure).not.toHaveBeenCalled();
      expect(retry.scheduledRetryAt!.getTime() - before).toBeGreaterThanOrEqual(60_000 * 2 ** failure);
      expect(retry.scheduledRetryAt!.getTime() - Date.now()).toBeLessThanOrEqual(60_000 * 2 ** failure);
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, retry.id));
      expect(wakes).toHaveLength(1);
      const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, runId));
      expect(await db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.decisionId, decision.id))).toMatchObject([{ effectKind: "schedule_retry", targetType: "heartbeat_run", targetId: retry.id }]);
      expect((await release({ companyId, runId, now: new Date() })).outcome.kind).toBe("released");
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);
      const schedulerAfterRestart = heartbeatService(db, { runtimeEnv: {} });
      expect(await schedulerAfterRestart.promoteDueScheduledRetries(new Date())).toMatchObject({ promoted: 0 });
      expect(await schedulerAfterRestart.promoteDueScheduledRetries(retry.scheduledRetryAt!)).toMatchObject({ promoted: 1, runIds: [retry.id] });
      runId = retry.id;
    }
    expect(unexpected).not.toHaveBeenCalled();
  });

  it("uses failed-run history without lending a resumed task's consumed continuation receipt", async () => {
    const issueId = randomUUID(), runId = randomUUID(), olderRunId = randomUUID(), commentId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Resumed capacity task", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "capacity-owner" });
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorUserId: "capacity-owner", authorType: "user", body: "Continue the investigation." });
    const consumedContext = { issueId, wakeCommentId: commentId, wakeCommentIds: [commentId],
      explicitUserContinuation: { previousRunId: olderRunId, commentId },
      previousRunId: olderRunId, resumeIntent: "continue", paperclipTurnContext: "Previously delivered context" };
    await db.insert(heartbeatRuns).values([
      { id: olderRunId, companyId, agentId, status: "failed", contextSnapshot: { issueId } },
      { id: runId, companyId, agentId, responsibleUserId: "capacity-owner", contextSnapshot: consumedContext },
    ]);
    await acceptCapacityFailure(runId, issueId);
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
    expect(retry.contextSnapshot).not.toHaveProperty("explicitUserContinuation");
    expect(retry.contextSnapshot).not.toHaveProperty("wakeCommentId");
    expect(retry.contextSnapshot).not.toHaveProperty("resumeIntent");
    expect(retry.contextSnapshot).not.toHaveProperty("paperclipTurnContext");
    const continuation = await buildExecutionContinuation({ db, companyId, issueId, agentId,
      runId: retry.id, context: retry.contextSnapshot!, summary: null, exposeLowTrustRaw: false });
    expect(continuation).toMatchObject({ trigger: { sourceRunId: runId }, objective: "Continue the investigation.",
      messages: [expect.objectContaining({ id: commentId, body: "Continue the investigation." })] });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0].contextSnapshot)
      .toEqual(consumedContext);
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, retry.id));
  });

  it("does not claim a capacity retry before predecessor cleanup settles", async () => {
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Cleanup capacity task", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "capacity-owner" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, responsibleUserId: "capacity-owner", contextSnapshot: { issueId } });
    await acceptCapacityFailure(runId, issueId);
    const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null }).where(eq(issues.id, issueId));
    const scheduler = heartbeatService(db, { runtimeEnv: {} });
    expect(await scheduler.promoteDueScheduledRetries(retry.scheduledRetryAt!)).toMatchObject({ promoted: 1 });
    await db.insert(environmentLeases).values({ companyId, heartbeatRunId: runId, provider: "local", status: "pending_cleanup", cleanupStatus: "failed" });
    await scheduler.resumeQueuedRuns();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry.id)))[0].status).toBe("queued");
    expect(provider.execute).toHaveBeenCalledTimes(1);
    // Do not leave a runnable fixture behind for the next case.
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, retry.id));
  });

  /**
   * The agent's finish was accepted, then the provider refused a later request
   * in the same turn (Antigravity streams its final reply after the finish).
   */
  async function acceptResultThenProviderFailure(runId: string, issueId: string, failure: {
    provider: NativeExecutionInputV1["provider"]; error: Record<string, unknown>; savedByOlderRelease?: boolean;
  }) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [run] = await db.update(heartbeatRuns).set({ status: "running", runtimeMode: "native", nativeIssueId: issueId }).where(eq(heartbeatRuns.id, runId)).returning();
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({ db, run, issue, environmentLeaseId: randomUUID() });
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const contractInput = buildNativeCompletionContract(issue, { revision: contract.revision });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    const execution: NativeExecutionInputV1 = {
      schema: "paperclip.native-execution-input.v1", binding: { companyId, runId, issueId, agentId, executionWorkspaceId: runId },
      provider: failure.provider,
      task: { identifier: issueId, title: issue.title, description: null, prompt: "Continue the task using its history.", workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: failure.provider.kind === "opencode" ? "opencode_server" : "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract.id, sha256: contract.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1", contract: contractInput },
      interactionResponses: [], credentialBindings: [],
    };
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, runId));
    const event: PrpEvent = {
      schema: "paperclip.prp.event.v1", runId, normalizedSessionId: native.normalizedSessionId, turnId: native.turnId,
      sourceInstanceId: native.runnerInstanceId, sourceEventId: "after-finish", sourceSeq: 1, sourceKind: "runner", eventType: "turn.failed", schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(),
      payload: { status: "failed", error: failure.error },
    };
    const terminal: PrpTerminalState = { schema: "paperclip.prp.terminal.v1", turnTerminalState: "failed", runTerminalState: "failed", reportedWorkDisposition: "done" };
    const result = { ...CONTROL_PLANE_CONFORMANCE_RESULT, summary: "The file is written and verified.",
      completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, contractRevision: contractInput.revision } };
    provider.execute.mockReset().mockImplementation(async (options: { controlPlane: ControlPlanePort }) => {
      await options.controlPlane.openRun({ identity: { companyId, issueId, runId, agentId, sessionId: native.normalizedSessionId }, backendKind: "mock", sourceInstanceId: native.runnerInstanceId });
      await options.controlPlane.appendEvent(event);
      await options.controlPlane.completeRun({ result, terminal, turnId: native.turnId });
      if (failure.savedByOlderRelease) {
        // A result row saved before this release has no accepted outcome.
        const [saved] = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId));
        const { acceptedOutcome: _dropped, ...older } = saved.resultJson as Record<string, unknown>;
        await db.update(nativeRunResults).set({ resultJson: older }).where(eq(nativeRunResults.id, saved.id));
        const [accepting] = await db.select({ resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        await db.update(heartbeatRuns).set({ resultJson: { ...accepting.resultJson,
          prpRunTerminalState: terminal.runTerminalState, prpTurnTerminalState: terminal.turnTerminalState } }).where(eq(heartbeatRuns.id, runId));
      }
      return { result, terminal, turnId: native.turnId, normalizedSessionId: native.normalizedSessionId, providerSessionId: "fixture-session", driverKind: "codex_app_server", driverVersion: "fixture", nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
    });
    const unexpected = async () => { throw new Error("Unexpected provider call"); };
    const adapter = await executePaperclipNativeSession({ db, execution, runnerInstanceId: native.runnerInstanceId, backend: { descriptor: unexpected, openSession: unexpected } });
    for (let replay = 0; replay < 2; replay++) await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    // The durable projection pass re-derives the run status from the saved
    // result after a restart or deploy; it must reach the same outcome.
    const [projectedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    await projectCommittedRun({ db, run: projectedRun, coordinator });
    return adapter;
  }

  /** A later finalization attempt was superseded: the run ends from its saved terminal state. */
  async function endAsSuperseded(runId: string) {
    await db.update(nativeRunFinalizations).set({ phase: "terminal_failure", failureCode: NATIVE_FINALIZATION_SUPERSEDED, failureDetail: {} })
      .where(eq(nativeRunFinalizations.runId, runId));
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null, errorCode: null, error: null }).where(eq(heartbeatRuns.id, runId));
    expect(await endSupersededNativeFinalizationRuns(db, [runId])).toEqual([runId]);
    return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0];
  }

  const capacityRefusal = { schema: "paperclip.provider-failure.v1", provider: "antigravity", phase: "turn", category: "overloaded",
    message: "No capacity available for model gemini-3.8-flash-low on the server", providerCode: "UNAVAILABLE", httpStatus: 503, retryability: "transient" };
  // The finalizer re-reads the pinned execution input, and a v1 input cannot
  // carry an ACPX provider. The rule reads only the typed failure, so a v1
  // provider carries Antigravity's exact refusal here.
  const typedProvider = { kind: "opencode", model: "google/gemini-3.8-flash-low" } as NativeExecutionInputV1["provider"];

  it.each([
    ["typed capacity refusal (Antigravity 503)", typedProvider, { code: "provider_turn_failed", message: capacityRefusal.message, providerFailure: capacityRefusal }],
    ["typed rate limit (Antigravity 429)", typedProvider, { code: "provider_turn_failed", message: "Slow down", providerFailure: { ...capacityRefusal, category: "rate_limit", httpStatus: 429, providerCode: "RESOURCE_EXHAUSTED" } }],
    ["Codex serverOverloaded", { kind: "codex", model: "test-model" } as NativeExecutionInputV1["provider"], { codexErrorInfo: "serverOverloaded", message: NATIVE_PROVIDER_OVERLOADED_MESSAGE }],
  ])("keeps an accepted finish as the outcome after a later %s, without a retry", async (_name, runProvider, error) => {
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Finished before capacity refusal", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "capacity-owner" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, responsibleUserId: "capacity-owner", contextSnapshot: { issueId } });
    sentry.captureRunFailure.mockClear();
    const adapter = await acceptResultThenProviderFailure(runId, issueId, { provider: runProvider, error });
    await waitForPendingRunFailureReports();
    expect(adapter).toMatchObject({ exitCode: 0, errorMessage: null, nativeFinalization: { terminal: { runTerminalState: "succeeded" } } });
    expect(adapter.errorCode).toBeUndefined();
    expect(adapter.resultJson).not.toHaveProperty("providerFailure");
    expect(Object.keys(adapter.resultJson?.providerFailureAfterAcceptedResult as object).sort()).toEqual(["category", "provider"]);
    expect(adapter.resultJson?.providerFailureAfterAcceptedResult).toMatchObject({ category: expect.stringMatching(/^(overloaded|rate_limit|server_overloaded)$/) });
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(finished).toMatchObject({ status: "succeeded", error: null, errorCode: null });
    // Recovery paths that settle from the saved run read this state.
    expect(finished.resultJson).toMatchObject({ prpRunTerminalState: "succeeded" });
    // A restart after the live finalizer committed but before heartbeat saved
    // the run status leaves it running; the projection pass settles it.
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, runId));
    const [restarted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const [coordinator] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
    await projectCommittedRun({ db, run: restarted, coordinator });
    await waitForPendingRunFailureReports();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]).toMatchObject({ status: "succeeded", errorCode: null });
    // A reply not yet published (restart, failed publication) is recovered for this succeeded run.
    const replies = nativeResponsePresentationCandidates(undefined, undefined, runId).as("pending_native_response");
    expect((await db.select().from(replies)).map(row => row.id)).toEqual([runId]);
    // A message the user queued and then sent proceeds once cleanup has finished.
    const commentId = randomUUID(), queueId = randomUUID(), blocked: string[] = [];
    await db.insert(issueComments).values({ id: commentId, companyId, issueId, authorType: "user", authorUserId: "capacity-owner", body: "One more thing." });
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId, agentId, source: "on_demand", reason: "issue_commented",
      status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "capacity-owner",
      payload: { issueId, _paperclipWakeContext: { wakeCommentIds: [commentId] },
        queuedCommentInterrupt: { actorId: "capacity-owner", requestedAt: new Date().toISOString() } } });
    await db.transaction(tx => admitExplicitNativeContinuation({ db: tx as unknown as typeof db, companyId, issueId, agentId,
      actorType: "user", actorId: "capacity-owner", reason: "issue_commented", commentId, successorRunId: randomUUID(),
      queuedCommentInterruptId: queueId, dryRun: true, onBlocked: reason => blocked.push(reason) }));
    expect(blocked).not.toContain("cleanup_pending");
    await db.update(agentWakeupRequests).set({ status: "cancelled" }).where(eq(agentWakeupRequests.id, queueId));
    // Idle sleep treats this settled finalization as history, not pending work.
    await db.insert(workspaceOperations).values({ companyId, issueId, heartbeatRunId: runId, phase: "workspace_finalize", status: "succeeded" });
    await db.update(heartbeatRuns).set({ costAccountingPending: false }).where(eq(heartbeatRuns.id, runId));
    const pending = await db.execute(sql.raw(NATIVE_RUN_FINALIZATION_WORK_QUERY.replace("WHERE (", `WHERE f.run_id = '${runId}' AND (`)));
    expect(Array.from(pending)).toHaveLength(0);
    expect(await endAsSuperseded(runId)).toMatchObject({ status: "succeeded" });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ status: "done" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId))).toHaveLength(0);
    expect(sentry.captureRunFailure).not.toHaveBeenCalled();
    expect(provider.execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a model the connection cannot use", { code: "antigravity_model_unavailable", message: "Not available", providerFailure: { ...capacityRefusal, category: "model_unavailable", retryability: "requires_action" } }],
    ["an exhausted allowance", { code: "provider_turn_failed", message: "Quota", providerFailure: { ...capacityRefusal, category: "quota_exhausted", retryability: "requires_action" } }],
    ["a rejected sign-in", { code: "provider_turn_failed", message: "Denied", providerFailure: { ...capacityRefusal, category: "authentication", retryability: "requires_action" } }],
    ["an untyped failure", { code: "provider_turn_failed", message: "Something broke" }],
  ])("still fails the run after an accepted finish followed by %s", async (_name, error) => {
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Finished before a real failure", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "capacity-owner" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, responsibleUserId: "capacity-owner", contextSnapshot: { issueId } });
    const adapter = await acceptResultThenProviderFailure(runId, issueId, { provider: typedProvider, error });
    await waitForPendingRunFailureReports();
    expect(adapter).toMatchObject({ exitCode: 1, nativeFinalization: { terminal: { runTerminalState: "failed" } } });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0].status).toBe("failed");
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].status).not.toBe("done");
    for (const retry of await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId)))
      await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, retry.id));
  });

  it("keeps a result saved by an older release on its recorded outcome through projection", async () => {
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Saved before the accepted outcome", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "capacity-owner" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, responsibleUserId: "capacity-owner", contextSnapshot: { issueId } });
    await acceptResultThenProviderFailure(runId, issueId, { provider: typedProvider, savedByOlderRelease: true,
      error: { code: "provider_turn_failed", message: capacityRefusal.message, providerFailure: capacityRefusal } });
    // The finalizer, the projection and the superseded path all keep the saved failed terminal.
    const [settled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(settled).toMatchObject({ status: "failed", resultJson: { prpRunTerminalState: "failed" } });
    expect(await endAsSuperseded(runId)).toMatchObject({ status: "failed" });
    for (const retry of await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId)))
      await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, retry.id));
  });

  it("does not retry or change the task after reassignment", async () => {
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Reassigned capacity task", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "capacity-owner" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, responsibleUserId: "capacity-owner", contextSnapshot: { issueId } });
    sentry.captureRunFailure.mockClear();
    await acceptCapacityFailure(runId, issueId, true);
    await waitForPendingRunFailureReports();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId))).toHaveLength(0);
    // No retry owns this failure, so it remains reportable.
    expect(sentry.captureRunFailure).toHaveBeenCalledOnce();
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ status: "in_progress", assigneeAgentId: otherAgentId });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).filter(wake => wake.payload?.issueId === issueId)).toHaveLength(0);
  });
});
