import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { assertChatFlowRunCount, collectChatRunEvidence } from "./chat-flow.js";
import { chatProviderRuns, classifyPreDispatchExecutionWait, isBlockedUnstartedWake, isTerminalUnstartedWake, verifyChatAdmissionWaitCoverage } from "./non-execution-wake.js";
it("recognizes only explicitly suppressed wakes that never started execution", () => {
  const run = { status: "cancelled", errorCode: "issue_dependencies_blocked", startedAt: null };
  expect(isBlockedUnstartedWake(run)).toBe(true);
  for (const patch of [{ startedAt: "2026-09-18" }, { startedAt: undefined }, { errorCode: "user_cancelled" }, { status: "failed" }]) {
    expect(isBlockedUnstartedWake({ ...run, ...patch })).toBe(false);
  }
});

it("requires an unstarted terminal suppression on the same terminal task", () => {
  const run = { status: "cancelled", errorCode: "issue_terminal_status", startedAt: null, contextSnapshot: { issueId: "child" } };
  for (const status of ["done", "cancelled"]) {
    expect(isTerminalUnstartedWake(run, [{ id: "child", status }])).toBe(true);
  }
  for (const patch of [{ startedAt: "2026-09-27T09:16:00Z" }, { startedAt: undefined },
    { errorCode: "cancelled" }, { status: "failed" }, { contextSnapshot: undefined },
    { contextSnapshot: { issueId: "other" } }]) {
    expect(isTerminalUnstartedWake({ ...run, ...patch }, [{ id: "child", status: "done" }])).toBe(false);
  }
  expect(isTerminalUnstartedWake(run, [])).toBe(false);
  expect(isTerminalUnstartedWake(run, [{ id: "child", status: "in_progress" }])).toBe(false);
});


const identity = {
  companyId: "10000000-0000-4000-8000-000000000001", agentId: "10000000-0000-4000-8000-000000000002",
  issueId: "10000000-0000-4000-8000-000000000003", commentId: "10000000-0000-4000-8000-000000000004",
  actionId: "10000000-0000-4000-8000-000000000005", waitId: "10000000-0000-4000-8000-000000000006",
  stopId: "10000000-0000-4000-8000-000000000007", wakeId: "10000000-0000-4000-8000-000000000008",
};
function admissionFixture() {
  const row: Record<string, any> = {
    id: identity.waitId, companyId: identity.companyId, agentId: identity.agentId, issueId: identity.issueId,
    wakeupRequestId: identity.wakeId, invocationSource: "on_demand", triggerDetail: "manual", responsibleUserId: "board",
    status: "cancelled", runtimeMode: "legacy", errorCode: "execution_reconciliation_required", error: "Recovering saved work…",
    runnerProfileJson: null, nextEventSeq: 2, logCompressed: false,
    createdAt: "2026-10-30T00:00:03Z", finishedAt: "2026-10-30T00:00:04Z",
    contextSnapshot: { issueId: identity.issueId, source: "issue.comment", wakeReason: "issue_commented",
      wakeCommentId: identity.commentId, wakeCommentIds: [identity.commentId] },
    resultJson: { stopReason: "execution_reconciliation_required", timeoutSource: "stale_queued_run_gate",
      timeoutFired: false, timeoutConfigured: false, effectiveTimeoutSec: 0,
      executionWait: { issueId: identity.issueId, recoveryActionId: identity.actionId } },
  };
  for (const key of ["startedAt", "runtimeModeResolvedAt", "runtimeModeReason", "runtimeModeResolverVersion",
    "runnerInstanceId", "nativeSessionId", "nativeIssueId", "driverKind", "driverVersion", "completionContractId",
    "completionContractSha256", "nativePhase", "sessionIdBefore", "sessionIdAfter", "controllerBootId",
    "controllerLeaseExpiresAt", "executionStage", "processPid", "processGroupId", "processStartedAt", "logStore",
    "logRef", "logBytes", "logSha256", "stdoutExcerpt", "stderrExcerpt", "usageJson", "exitCode", "signal", "externalRunId"]) row[key] = null;
  const event: Record<string, any> = { seq: 1, runId: row.id, companyId: row.companyId, agentId: row.agentId,
    eventType: "lifecycle", stream: "system", level: "warn", message: row.error, payload: { ...row.resultJson.executionWait } };
  for (const key of ["sourceInstanceId", "sourceEventId", "sourceSeq", "sourcePayloadSha256", "protocolSchemaVersion"]) event[key] = null;
  const stopped = { id: identity.stopId, companyId: identity.companyId, agentId: identity.agentId,
    nativeIssueId: identity.issueId, contextSnapshot: { issueId: identity.issueId }, runtimeMode: "native", status: "cancelled", finishedAt: "2026-10-30T00:00:01Z",
    resultJson: { nativeCancellation: { schema: "paperclip.native-cancellation.v1", runId: identity.stopId,
      companyId: identity.companyId, issueId: identity.issueId, scope: "run", reasonCode: "cancellation_run_only",
      dispatchState: "acknowledged", dispatched: true } } };
  const seed = { ...stopped, id: "10000000-0000-4000-8000-000000000009", status: "succeeded", resultJson: {} };
  const reset = { id: "10000000-0000-4000-8000-000000000010", companyId: identity.companyId, agentId: identity.agentId,
    runtimeMode: "legacy", status: "succeeded", startedAt: "2026-10-30T00:00:05Z", finishedAt: "2026-10-30T00:00:06Z",
    contextSnapshot: { conversationReset: true, wakeCommentId: identity.commentId, commentId: identity.commentId,
      conversationSessionGeneration: 1 }, resultJson: { conversationReset: true } };
  const fresh = { ...seed, id: "10000000-0000-4000-8000-000000000011", startedAt: "2026-10-30T00:00:07Z",
    sessionIdBefore: null, contextSnapshot: { issueId: identity.issueId, conversationSessionGeneration: 1 } };
  const action = { id: identity.actionId, companyId: identity.companyId, sourceIssueId: identity.issueId,
    status: "resolved", outcome: "cancelled", resolvedAt: "2026-10-30T00:00:05Z", fingerprint: `native-workspace:${identity.stopId}`, evidence: { runId: identity.stopId,
      automaticRecovery: { policy: "preserve_without_replay_v1", replay: "explicit_user_continuation", runId: identity.stopId },
      explicitUserContinuation: { previousRunId: identity.stopId, commentId: identity.commentId, actorId: "board",
        runId: reset.id, queuedCommentRequestId: identity.wakeId, commentBodyHash: createHash("sha256").update("/new").digest("hex") },
      systemRecovery: { schema: "paperclip.system-recovery.v1", sourceRunId: identity.stopId, state: "complete",
        phase: "reconcile_effects", preservationOperationIds: ["10000000-0000-4000-8000-000000000012"] },
      workspaceRecovery: { schema: "paperclip.workspace-recovery.v1", runId: identity.stopId, status: "recovered" } } };
  return { row, event, final: { runs: [seed, stopped, row, reset, fresh],
    runEvidence: [{ runId: row.id, log: null, logOmissionReason: "pre_dispatch_execution_wait", events: [event] }],
    companyId: identity.companyId, agentId: identity.agentId, stoppedRunId: identity.stopId,
    issue: { id: identity.issueId, companyId: identity.companyId, assigneeAgentId: identity.agentId,
      conversationSessionGeneration: 1, conversationBoundaryCommentId: identity.commentId },
    comments: [{ id: identity.commentId, companyId: identity.companyId, issueId: identity.issueId, body: "/new",
      authorType: "user", deletedAt: null, authorUserId: "board", authorAgentId: null, createdByRunId: null, createdAt: "2026-10-30T00:00:02Z" }],
    recoverySources: [{ runId: identity.stopId, recoveryActionId: identity.actionId, response: { actions: [action],
      sourceInspection: { schema: "paperclip.workspace-source-inspection.v1", actionId: identity.actionId,
        runId: identity.stopId, scope: "recorded_source_identity", status: "verified" } } }] } };
}

it("counts only exact pre-dispatch waits provisionally without requiring a future reset", () => {
  const { row, event } = admissionFixture();
  const receipt = classifyPreDispatchExecutionWait(row, [event]);
  expect(receipt).toMatchObject({ runId: row.id, kind: "pre_dispatch_execution_wait" });
  expect(chatProviderRuns([{ id: "provider" }, row as any], [receipt!])).toEqual([{ id: "provider" }]);
  expect(row.status).toBe("cancelled");
});

it("requires complete receipt and rejects provider authority rather than filtering cancelled or legacy rows", () => {
  for (const patch of [{ runtimeMode: "native" }, { status: "failed" }, { errorCode: "operator_cancelled" },
    { startedAt: "2026-10-30" }, { startedAt: undefined }, { processPid: 12 }, { controllerBootId: identity.wakeId },
    { runnerProfileJson: { nativeExecutionInput: {} } }, { nativeSessionId: identity.wakeId }, { logRef: "log" },
    { nextEventSeq: 3 }, { wakeupRequestId: null }, { resultJson: { stopReason: "execution_reconciliation_required" } }]) {
    const { row, event } = admissionFixture();
    expect(classifyPreDispatchExecutionWait({ ...row, ...patch }, [event]), JSON.stringify(patch)).toBeNull();
  }
  for (const patch of [{ stream: "stdout" }, { sourceEventId: "native-event" }, { seq: 2 }, { runId: identity.stopId },
    { companyId: identity.stopId }, { eventType: "provider.event" }, { payload: { issueId: identity.issueId, recoveryActionId: identity.stopId } }]) {
    const { row, event } = admissionFixture();
    expect(classifyPreDispatchExecutionWait(row, [{ ...event, ...patch }]), JSON.stringify(patch)).toBeNull();
  }
  const { row, event } = admissionFixture();
  expect(classifyPreDispatchExecutionWait(row, [])).toBeNull();
  expect(classifyPreDispatchExecutionWait(row, [event, { ...event, seq: 2, eventType: "provider.event" }])).toBeNull();
});

it("requires preserved source, saved human reset and all three actual native providers at final grading", () => {
  const { final } = admissionFixture();
  const original = structuredClone(final);
  const waits = verifyChatAdmissionWaitCoverage(final);
  expect(waits).toHaveLength(1);
  expect(chatProviderRuns(final.runs as any, waits)).toHaveLength(3);
  expect(final.runs).toHaveLength(5);
  expect(final).toEqual(original);
});

it("rejects incomplete, cross-scope or unrecovered final proof without treating an admission wait as a reset", () => {
  const mutations: Array<(f: any) => void> = [
    f => { f.comments[0].body = "/new unrelated"; },
    f => { f.comments[0].authorType = "system"; }, f => { f.comments[0].deletedAt = "2026-10-30T00:00:03Z"; }, f => { f.comments[0].authorAgentId = identity.agentId; },
    f => { f.comments[0].createdByRunId = identity.stopId; }, f => { f.comments[0].issueId = identity.stopId; },
    f => { f.comments[0].authorUserId = "other"; }, f => { f.stoppedRunId = identity.waitId; },
    f => { f.runs[1].resultJson.nativeCancellation.dispatchState = "pending"; },
    f => { f.runs[1].resultJson.nativeCancellation.runId = identity.waitId; },
    f => { f.runs[3].contextSnapshot.wakeCommentId = identity.wakeId; }, f => { f.runs[3].status = "cancelled"; },
    f => { f.runs[4].contextSnapshot.conversationSessionGeneration = 0; }, f => { f.runs[4].runtimeMode = "legacy"; },
    f => { f.runs[4].sessionIdBefore = "old"; }, f => { f.runs.push({ ...f.runs[4], id: identity.wakeId }); },
    f => { f.runs.push(structuredClone(f.runs[2])); }, f => { f.runEvidence[0].log = {}; },
    f => { f.recoverySources = []; }, f => { f.recoverySources[0].runId = identity.waitId; },
    f => { f.recoverySources[0].response.actions[0].companyId = identity.waitId; },
    f => { f.recoverySources[0].response.actions[0].sourceIssueId = identity.waitId; },
    f => { f.recoverySources[0].response.actions[0].evidence.runId = identity.waitId; },
    f => { f.recoverySources[0].response.actions[0].evidence.systemRecovery.state = "awaiting_evidence"; },
    f => { f.recoverySources[0].response.actions[0].evidence.automaticRecovery.replay = "blocked"; },
    f => { f.recoverySources[0].response.actions[0].evidence.explicitUserContinuation.runId = identity.waitId; },
    f => { f.recoverySources[0].response.actions[0].evidence.explicitUserContinuation.queuedCommentRequestId = identity.waitId; },
    f => { f.recoverySources[0].response.actions[0].evidence.explicitUserContinuation.commentBodyHash = "0".repeat(64); },
    f => { f.recoverySources[0].response.actions[0].evidence.systemRecovery.preservationOperationIds = []; },
    f => { f.recoverySources[0].response.actions[0].evidence.workspaceRecovery.status = "blocked"; },
    f => { f.recoverySources[0].response.sourceInspection.status = "blocked"; },
    f => { f.recoverySources[0].response.sourceInspection.actionId = identity.waitId; },
  ];
  for (const mutate of mutations) {
    const { final } = admissionFixture(); mutate(final);
    expect(() => verifyChatAdmissionWaitCoverage(final)).toThrow("Chat admission wait:");
  }
});


it("keeps the actual chat provider-count assertion at three and preserves raw admission rows", () => {
  const { final } = admissionFixture();
  const wait = verifyChatAdmissionWaitCoverage(final);
  expect(() => assertChatFlowRunCount({ suiteId: "kimi-qualification", task: { expectedRunCount: 3 },
    runs: final.runs.filter(row => row.runtimeMode !== "legacy" || row.status === "cancelled") as any })).toThrow("Declared total provider-run bounds");
  expect(() => assertChatFlowRunCount({ suiteId: "kimi-qualification", task: { expectedRunCount: 3 },
    runs: chatProviderRuns(final.runs as any, wait) })).not.toThrow();
  expect(final.runs).toHaveLength(5);
});

it("captures the actual complete public wait stream without requesting a nonexistent provider log", async () => {
  const { row, event } = admissionFixture();
  const get = vi.fn(async (path: string) => {
    if (path.includes("/events?")) return [event];
    throw new Error("provider log must not be omitted for unverified evidence");
  });
  expect(await collectChatRunEvidence({ get } as any, row as any, true)).toEqual({
    runId: row.id, log: null, logOmissionReason: "pre_dispatch_execution_wait", events: [event],
  });
  expect(get).toHaveBeenCalledTimes(1);
  await expect(collectChatRunEvidence({ get } as any, { ...row, processPid: 99 } as any, true)).rejects.toThrow("provider log must not be omitted");
  await expect(collectChatRunEvidence({ get } as any, row as any)).rejects.toThrow("provider log must not be omitted");
});


it("permits only a predecessor-correlated historical before-session hint at final grading", () => {
  const { row, event, final } = admissionFixture();
  row.sessionIdBefore = "session_historical";
  (final.runs[0] as Record<string, any>).sessionIdAfter = "session_historical";
  (final.runs[1] as Record<string, any>).sessionIdBefore = "session_historical";
  expect(classifyPreDispatchExecutionWait(row, [event])).toBeTruthy();
  expect(verifyChatAdmissionWaitCoverage(final)).toHaveLength(1);
  row.sessionIdBefore = "session_foreign";
  expect(() => verifyChatAdmissionWaitCoverage(final)).toThrow("historical_session_hint");
});
