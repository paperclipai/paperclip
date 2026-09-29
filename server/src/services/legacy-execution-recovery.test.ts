import { expect, it } from "vitest";
import { legacyExecutionNeedsReconciliation, shouldStampBootstrapExecutionRecovery } from "./legacy-execution-recovery.js";

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


it("stamps bootstrap for process adapters that fail before spawn, not HTTP post-dispatch", () => {
  const base = {
    legacyAdapterEntered: true,
    runtimeMode: "legacy" as const,
    processPid: null,
    processStartedAt: null,
  };
  // Process / pre-spawn: missing command leaves null PID → bootstrap.
  expect(shouldStampBootstrapExecutionRecovery({ ...base, adapterType: "process" })).toBe(true);
  expect(shouldStampBootstrapExecutionRecovery({ ...base, adapterType: "cursor" })).toBe(true);
  expect(shouldStampBootstrapExecutionRecovery({ ...base, adapterType: "claude_local" })).toBe(true);
  expect(shouldStampBootstrapExecutionRecovery({ ...base, adapterType: "grok_local" })).toBe(true);
  // HTTP/cloud adapters do not record processPid; null PID after entry is not bootstrap.
  expect(shouldStampBootstrapExecutionRecovery({ ...base, adapterType: "http" })).toBe(false);
  expect(shouldStampBootstrapExecutionRecovery({ ...base, adapterType: "cursor_cloud" })).toBe(false);
  expect(shouldStampBootstrapExecutionRecovery({ ...base, adapterType: "hermes_gateway" })).toBe(false);
  expect(shouldStampBootstrapExecutionRecovery({ ...base, adapterType: "openclaw_gateway" })).toBe(false);
  expect(shouldStampBootstrapExecutionRecovery({ ...base, adapterType: null })).toBe(false);
  // Spawned process adapters already started provider work.
  expect(shouldStampBootstrapExecutionRecovery({
    ...base, adapterType: "cursor", processPid: 4242, processStartedAt: new Date(),
  })).toBe(false);
  // Adapter never entered remains bootstrap for any adapter type.
  expect(shouldStampBootstrapExecutionRecovery({
    legacyAdapterEntered: false, runtimeMode: "legacy", adapterType: "http",
  })).toBe(true);
  expect(shouldStampBootstrapExecutionRecovery({
    legacyAdapterEntered: false, runtimeMode: "native", adapterType: "cursor",
  })).toBe(false);
});
