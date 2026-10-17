import { QUEUED_RUN_STALENESS_ERROR_CODES } from "../modules/run-dispatch/domain/policy.js";
import { isPreDispatchCancel, isPreDispatchReviewWait } from "./pre-dispatch-review-wait.js";
import { expect, it } from "vitest";
import { legacyExecutionNeedsReconciliation } from "./legacy-execution-recovery.js";

const stopped = {
  runtimeMode: "legacy", status: "cancelled", errorCode: "cancelled",
  resultJson: {
    executionCancellation: { state: "acknowledged" },
    executionRecovery: { kind: "interrupted", providerStopped: true, sessionPreserved: true, actionOutcomes: "settled" },
  },
};

it.each(["workspace_git_scan_timeout", "workspace_git_scan_saturated"])("does not invent unknown provider actions after exhausted %s bootstrap retries", (errorCode) => {
  const run = { runtimeMode: "legacy", status: "failed", errorCode, scheduledRetryAttempt: 2,
    resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } };
  expect(legacyExecutionNeedsReconciliation(run)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...run, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...run, resultJson: {
    executionRecovery: { kind: "bootstrap", providerWorkStarted: true },
  } })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...run, errorCode: "setup_failed" })).toBe(true);
});

it("permits subscription waits only with explicit evidence that provider work never started", () => {
  const waiting = {
    runtimeMode: "legacy", status: "cancelled", errorCode: "ai_connection_busy", scheduledRetryAttempt: 12,
    resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false } },
  };
  expect(legacyExecutionNeedsReconciliation(waiting)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, status: "failed" })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, errorCode: "cancelled" })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {
    executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: true },
  } })).toBe(true);
});

it("allows a confirmed interrupted checkpoint without treating ordinary cancellation as replay permission", () => {
  expect(legacyExecutionNeedsReconciliation(stopped)).toBe(false);
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {} })).toBe(true);
  expect(legacyExecutionNeedsReconciliation({ ...stopped, status: "failed" })).toBe(true);
});

it.each([
  { providerStopped: false }, { sessionPreserved: false }, { actionOutcomes: "unknown" },
])("retains the hold for incomplete interruption evidence: %j", (missing) => {
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {
    ...stopped.resultJson,
    executionRecovery: { ...stopped.resultJson.executionRecovery, ...missing },
  } })).toBe(true);
});

it("retains the hold until the provider actually acknowledges cancellation", () => {
  expect(legacyExecutionNeedsReconciliation({ ...stopped, resultJson: {
    ...stopped.resultJson, executionCancellation: { state: "requested" },
  } })).toBe(true);
});

 it("continues a conversation without requiring receipts, even after automatic attempts are exhausted", () => {
  for (const status of ["failed", "timed_out", "interrupted", "cancelled"]) {
    expect(legacyExecutionNeedsReconciliation({
      runtimeMode: "legacy", status, errorCode: "process_lost", scheduledRetryAttempt: 2,
      resultJson: { conversationContinuation: "continue_conversation_v1" },
    })).toBe(false);
  }
});

it("retries a busy AI subscription only when no provider work started", () => {
   const waiting = { runtimeMode: "legacy", status: "cancelled", errorCode: "ai_connection_busy", scheduledRetryAttempt: 10,
     resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false } } };
   expect(legacyExecutionNeedsReconciliation(waiting)).toBe(false);
   expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: {} })).toBe(true);
   expect(legacyExecutionNeedsReconciliation({ ...waiting, resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: true } } })).toBe(true);
 });


it.each(["failed", "timed_out", "cancelled"])("holds an unsafe archive after %s even with conversation or bootstrap evidence", (status) => {
  expect(legacyExecutionNeedsReconciliation({ runtimeMode: "legacy", status, errorCode: "workspace_restore_failed", resultJson: {
    workspaceRestoreFailure: "restore_unsafe_archive", conversationContinuation: "continue_conversation_v1",
    executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, stopReason: "max_turns",
  } })).toBe(true);
});


it("retains conversation retry eligibility for a transient restore lock timeout", () => {
  expect(legacyExecutionNeedsReconciliation({ runtimeMode: "legacy", status: "failed", errorCode: "workspace_restore_failed", resultJson: {
    workspaceRestoreFailure: "restore_lock_timeout", conversationContinuation: "continue_conversation_v1",
  } })).toBe(false);
});


it("recognizes only an unclaimed pre-dispatch review wait receipt", () => {
  const run = { runtimeMode: "legacy", status: "cancelled", errorCode: "issue_continuation_waiting_on_review",
    startedAt: null, runtimeModeResolvedAt: null, processPid: null, processGroupId: null,
    processStartedAt: null, nativeIssueId: null, nativeSessionId: null, sessionIdAfter: null,
    controllerBootId: null, controllerLeaseExpiresAt: null, executionStage: null,
    resultJson: { stopReason: "issue_continuation_waiting_on_review", timeoutSource: "stale_queued_run_gate" } };
  expect(isPreDispatchReviewWait(run)).toBe(true);
  expect(legacyExecutionNeedsReconciliation(run)).toBe(true);
  for (const patch of [
    { startedAt: new Date() }, { processPid: 123 }, { processGroupId: 123 },
    { processStartedAt: new Date() }, { nativeSessionId: "provider-session" }, { nativeIssueId: "native-task" },
    { sessionIdAfter: "provider-session" }, { runtimeModeResolvedAt: new Date() },
    { controllerBootId: "live-controller" }, { controllerLeaseExpiresAt: new Date() }, { executionStage: "preparing" },
    { errorCode: "operator_interrupted" }, { resultJson: {} },
    { resultJson: { ...run.resultJson, stopReason: "cancelled" } },
    { resultJson: { ...run.resultJson, workspaceRestoreFailure: "restore_unsafe_archive" } },
  ]) expect(isPreDispatchReviewWait({ ...run, ...patch })).toBe(false);
});

it.each(["issue_assignee_changed", "issue_dependencies_blocked"])("treats a dispatcher %s cancel with no start evidence as a pre-dispatch cancel only", (errorCode) => {
  const run = { runtimeMode: "legacy", status: "cancelled", errorCode,
    startedAt: null, runtimeModeResolvedAt: null, processPid: null, processGroupId: null,
    processStartedAt: null, nativeIssueId: null, nativeSessionId: null, sessionIdAfter: null,
    controllerBootId: null, controllerLeaseExpiresAt: null, executionStage: null,
    resultJson: { stopReason: errorCode, timeoutSource: "stale_queued_run_gate" } };
  expect(isPreDispatchCancel(run)).toBe(true);
  expect(isPreDispatchReviewWait(run)).toBe(false);
  // The synchronous classifier stays conservative; the evidence-backed wrapper grants the exemption.
  expect(legacyExecutionNeedsReconciliation(run)).toBe(true);
  for (const patch of [
    { startedAt: new Date() }, { processPid: 123 }, { processGroupId: 123 }, { sessionIdAfter: "provider-session" },
    { errorCode: "execution_reconciliation_required", resultJson: { ...run.resultJson, stopReason: "execution_reconciliation_required" } },
    { errorCode: "operator_interrupted", resultJson: { ...run.resultJson, stopReason: "operator_interrupted" } },
    { resultJson: {} },
  ]) expect(isPreDispatchCancel({ ...run, ...patch })).toBe(false);
});

it.each(QUEUED_RUN_STALENESS_ERROR_CODES)("classifies staleness code %s deliberately", (errorCode) => {
  const run = { runtimeMode: "legacy", status: "cancelled", errorCode,
    startedAt: null, runtimeModeResolvedAt: null, processPid: null, processGroupId: null,
    processStartedAt: null, nativeIssueId: null, nativeSessionId: null, sessionIdAfter: null,
    controllerBootId: null, controllerLeaseExpiresAt: null, executionStage: null,
    resultJson: { stopReason: errorCode, timeoutSource: "stale_queued_run_gate" } };
  // A code reporting an already-recorded hold is not a pre-dispatch cancel. A
  // response wait needs its connection-intent snapshot, so the code alone fails.
  expect(isPreDispatchCancel(run)).toBe(
    errorCode !== "execution_reconciliation_required" && errorCode !== "issue_waiting_for_response");
});

it("accepts a response wait only with its resolved connection-intent snapshot", () => {
  const contextSnapshot = { connectionIntentResolution: "existing_connection", source: "connection_intent.resolved",
    interactionKind: "connection_intent", interactionStatus: "expired", mutation: "interaction", interactionId: "i-1" };
  const run = { runtimeMode: "legacy", status: "cancelled", errorCode: "issue_waiting_for_response",
    startedAt: null, runtimeModeResolvedAt: null, processPid: null, processGroupId: null,
    processStartedAt: null, nativeIssueId: null, nativeSessionId: null, sessionIdAfter: null,
    controllerBootId: null, controllerLeaseExpiresAt: null, executionStage: null, contextSnapshot,
    resultJson: { stopReason: "issue_waiting_for_response", timeoutSource: "stale_queued_run_gate" } };
  expect(isPreDispatchCancel(run)).toBe(true);
  expect(isPreDispatchReviewWait(run)).toBe(true);
  expect(isPreDispatchCancel({ ...run, contextSnapshot: { ...contextSnapshot, interactionStatus: "pending" } })).toBe(false);
  expect(isPreDispatchCancel({ ...run, resultJson: { ...run.resultJson, timeoutSource: "dependency_gate" } })).toBe(false);
});

it("accepts the claim-time dependency gate source only for its own code", () => {
  const run = { runtimeMode: "legacy", status: "cancelled", errorCode: "issue_dependencies_blocked",
    startedAt: null, runtimeModeResolvedAt: null, processPid: null, processGroupId: null,
    processStartedAt: null, nativeIssueId: null, nativeSessionId: null, sessionIdAfter: null,
    controllerBootId: null, controllerLeaseExpiresAt: null, executionStage: null,
    resultJson: { stopReason: "issue_dependencies_blocked", timeoutSource: "dependency_gate" } };
  expect(isPreDispatchCancel(run)).toBe(true);
  expect(isPreDispatchCancel({ ...run, errorCode: "issue_assignee_changed",
    resultJson: { stopReason: "issue_assignee_changed", timeoutSource: "dependency_gate" } })).toBe(false);
});
