import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, completionContracts, createDb, environmentLeases, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, statusDecisionEffects, statusDecisions } from "@paperclipai/db";
import type { ControlPlanePort, NativeExecutionInputV1, PrpEvent, PrpTerminalState } from "@paperclipai/paperclip-runner";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT } from "../../vendor/paperclip-runner/testing.js";

const provider = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../vendor/paperclip-runner/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>()), executeNativeSession: provider.execute,
}));
import { executePaperclipNativeSession } from "./native-session-executor.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { readPersistedNativeProviderFailure } from "./native-provider-failure-evidence.js";
import { NATIVE_PROVIDER_OVERLOADED_MESSAGE } from "./native-provider-failure.js";
import { heartbeatService } from "../heartbeat.js";
import { createPostgresWakeQueueAdapter } from "../../modules/wake-queue/adapters/postgres.js";
import { createReleaseIssueExecution } from "../../modules/wake-queue/application/use-cases.js";

describe("durable native provider capacity retry", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID(), otherAgentId = randomUUID();
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-capacity-retry-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Capacity regression", issuePrefix: "CAP" });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Capacity worker", status: "active", adapterType: "paperclip_runner", adapterConfig: { provider: "codex", model: "test-model" } },
      { id: otherAgentId, companyId, name: "New owner", status: "active", adapterType: "paperclip_runner" },
    ]);
  });
  afterAll(async () => { await temporary?.cleanup(); });

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
    const event: PrpEvent = {
      schema: "paperclip.prp.event.v1", runId, normalizedSessionId: native.normalizedSessionId, turnId: native.turnId,
      sourceInstanceId: native.runnerInstanceId, sourceEventId: "overload", sourceSeq: 1, sourceKind: "runner", eventType: "turn.failed", schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(),
      payload: { status: "failed", error: { codexErrorInfo: "serverOverloaded", message: NATIVE_PROVIDER_OVERLOADED_MESSAGE } },
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
      await acceptCapacityFailure(runId, issueId);
      const successors = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, runId)));
      if (failure === 2) {
        expect(successors).toHaveLength(0);
        expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ status: "blocked", unblockDescriptor: { action: expect.stringContaining("Automatic retries exhausted") } });
        break;
      }
      expect(successors).toHaveLength(1);
      const retry = successors[0];
      expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryAttempt: failure + 1, scheduledRetryReason: "native_provider_overloaded", error: NATIVE_PROVIDER_OVERLOADED_MESSAGE,
        contextSnapshot: { issueId, wakeCommentId: "original-message", forceFreshSession: true, executionRetryAccounting: { version: 1, failureRetries: failure + 1, maxTurnContinuations: 0 } } });
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

  it("does not retry or change the task after reassignment", async () => {
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Reassigned capacity task", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "capacity-owner" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, responsibleUserId: "capacity-owner", contextSnapshot: { issueId } });
    await acceptCapacityFailure(runId, issueId, true);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId))).toHaveLength(0);
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]).toMatchObject({ status: "in_progress", assigneeAgentId: otherAgentId });
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).filter(wake => wake.payload?.issueId === issueId)).toHaveLength(0);
  });
});
