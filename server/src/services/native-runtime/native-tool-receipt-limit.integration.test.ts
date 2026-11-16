import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, completionContracts, createDb, heartbeatRuns, issueRecoveryActions, issues, nativeRunFinalizations, statusDecisionEffects, statusDecisions } from "@paperclipai/db";
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
import { NATIVE_TOOL_RECEIPT_LIMIT_CODE, NATIVE_TOOL_RECEIPT_LIMIT_CONTINUATION_DELAY_MS, NATIVE_TOOL_RECEIPT_LIMIT_HINT,
  readPersistedNativeToolReceiptLimitStop } from "./native-tool-receipt-limit.js";
import { heartbeatService } from "../heartbeat.js";
import { createPostgresWakeQueueAdapter } from "../../modules/wake-queue/adapters/postgres.js";
import { createReleaseIssueExecution } from "../../modules/wake-queue/application/use-cases.js";
import { taskInterruptionPresentation } from "../task-interruption-presentation.js";

describe("native turn stopped at its tool receipt limit", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID();
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("native-tool-receipt-limit-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Receipt limit regression", issuePrefix: "RCL" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Receipt worker", status: "active", adapterType: "paperclip_runner", adapterConfig: { provider: "opencode", model: "test-model" } });
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function stopAtReceiptLimit(runId: string, issueId: string, diagnosticCode: string) {
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
      sourceInstanceId: native.runnerInstanceId, sourceEventId: "receipt-limit", sourceSeq: 1, sourceKind: "runner", eventType: "harness.diagnostic", schemaVersion: 1, priority: 0, emittedAt: new Date().toISOString(),
      payload: { provider: "opencode", code: diagnosticCode, operationId: "get_task", callId: "call-80",
        message: "The active provider turn reached its durable semantic-tool receipt limit and was interrupted", paperclipExecuted: false },
    };
    const terminal: PrpTerminalState = { schema: "paperclip.prp.terminal.v1", turnTerminalState: "interrupted", runTerminalState: "cancelled", reportedWorkDisposition: "needs_review" };
    const result = { ...CONTROL_PLANE_CONFORMANCE_RESULT, reportedWorkDisposition: "needs_review" as const,
      summary: "The OpenCode run stopped before it completed.",
      completionClaim: { ...CONTROL_PLANE_CONFORMANCE_RESULT.completionClaim, contractRevision: contractInput.revision },
      attentionRequests: [{ kind: "review" as const, summary: "Review the stopped OpenCode run before continuing.", ownerClass: "human" as const }] };
    provider.execute.mockReset().mockImplementation(async (options: { controlPlane: ControlPlanePort }) => {
      await options.controlPlane.openRun({ identity: { companyId, issueId, runId, agentId, sessionId: native.normalizedSessionId }, backendKind: "mock", sourceInstanceId: native.runnerInstanceId });
      await options.controlPlane.appendEvent(event);
      await options.controlPlane.completeRun({ result, terminal, turnId: native.turnId });
      return { result, terminal, turnId: native.turnId, normalizedSessionId: native.normalizedSessionId, providerSessionId: "fixture-session", driverKind: "codex_app_server", driverVersion: "fixture", nativeEventCount: 1, highestContiguousSourceSeq: 1, usage: null };
    });
    const unexpected = async () => { throw new Error("Unexpected provider call"); };
    await executePaperclipNativeSession({ db, execution, runnerInstanceId: native.runnerInstanceId, backend: { descriptor: unexpected, openSession: unexpected } });
    for (let replay = 0; replay < 2; replay++) await finalizeNativeRun({ db, runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    expect(provider.execute).toHaveBeenCalledTimes(1);
    return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!;
  }

  function release() {
    const unexpected = vi.fn(async () => { throw new Error("Unexpected recovery"); });
    return createReleaseIssueExecution({
      issueLock: createPostgresWakeQueueAdapter(db, { resolveResponsibleUserId: unexpected, getRoutineEnv: unexpected, resolveSessionBeforeForWakeup: unexpected }),
      recovery: { escalateStrandedAssignedIssue: unexpected, escalateStrandedRecoveryIssueInPlace: unexpected },
    });
  }

  it("continues the task at once in a fresh session and shows no Retry", async () => {
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Parallel reads task", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "receipt-owner" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, responsibleUserId: "receipt-owner", contextSnapshot: { issueId, wakeCommentId: "original-message" } });
    const stopped = await stopAtReceiptLimit(runId, issueId, NATIVE_TOOL_RECEIPT_LIMIT_CODE);
    expect(stopped.status).toBe("cancelled");
    expect(await readPersistedNativeToolReceiptLimitStop(db, stopped)).toBe(true);

    const [retry, ...others] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.retryOfRunId, runId)));
    expect(others).toHaveLength(0);
    expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: NATIVE_TOOL_RECEIPT_LIMIT_CODE, scheduledRetryAttempt: 1,
      contextSnapshot: { issueId, forceFreshSession: true, livenessContinuationSourceRunId: runId,
        livenessContinuationReason: NATIVE_TOOL_RECEIPT_LIMIT_CODE, livenessContinuationInstruction: NATIVE_TOOL_RECEIPT_LIMIT_HINT } });
    expect(retry!.contextSnapshot).not.toHaveProperty("wakeCommentId");
    expect(retry!.scheduledRetryAt!.getTime() - Date.now()).toBeLessThanOrEqual(NATIVE_TOOL_RECEIPT_LIMIT_CONTINUATION_DELAY_MS);
    const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, runId));
    expect(decision).toMatchObject({ reasonCode: NATIVE_TOOL_RECEIPT_LIMIT_CODE });
    expect(await db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.decisionId, decision!.id)))
      .toEqual(expect.arrayContaining([expect.objectContaining({ effectKind: "schedule_retry", targetType: "heartbeat_run", targetId: retry!.id })]));

    expect((await release()({ companyId, runId, now: new Date() })).outcome.kind).toBe("released");
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue).toMatchObject({ status: "in_progress", assigneeAgentId: agentId });
    expect(await taskInterruptionPresentation(db, issue!)).toMatchObject({ state: "retry_scheduled", canRetry: false, userAction: null });
    const scheduler = heartbeatService(db, { runtimeEnv: {} });
    expect(await scheduler.promoteDueScheduledRetries(new Date())).toMatchObject({ promoted: 0 });
    expect(await scheduler.promoteDueScheduledRetries(retry!.scheduledRetryAt!)).toMatchObject({ promoted: 1, runIds: [retry!.id] });
    expect(await taskInterruptionPresentation(db, issue!)).toMatchObject({ state: "working", canRetry: false, userAction: null });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, retry!.id))).toHaveLength(1);
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, retry!.id));
  });

  it("leaves another cancelled turn to its existing recovery", async () => {
    const issueId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Other diagnostic task", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: "receipt-owner" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, responsibleUserId: "receipt-owner", contextSnapshot: { issueId } });
    const stopped = await stopAtReceiptLimit(runId, issueId, "semantic_tool_denied");
    expect(await readPersistedNativeToolReceiptLimitStop(db, stopped)).toBe(false);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId))).toHaveLength(0);
    const [decision] = await db.select().from(statusDecisions).where(eq(statusDecisions.runId, runId));
    expect(decision).toMatchObject({ reasonCode: "cancellation_run_only" });
  });
});
