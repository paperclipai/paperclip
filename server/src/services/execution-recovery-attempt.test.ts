import { describe, expect, it } from "vitest";
import { accountingForScheduledRetry, executionFailureRetryCount, executionRetryAttemptCount } from "./execution-recovery-attempt.js";
import { RUNNER_REVISION_WAIT_RETRY_REASON } from "./runner-revision-mismatch.js";
import { RUNNER_REVISION_WAIT_RETRY_REASON as DISPATCH_RUNNER_REVISION_WAIT_RETRY_REASON } from "../modules/run-dispatch/index.js";

describe("failure attempts across resource waits", () => {
  it("preserves prior failures through subscription waits without trusting unrelated context", () => {
    expect(executionFailureRetryCount({ scheduledRetryReason: "ai_connection_busy", scheduledRetryAttempt: 12,
      contextSnapshot: { failureRetriesBeforeAiConnectionWait: 1 } })).toBe(1);
    expect(executionFailureRetryCount({ scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 2,
      contextSnapshot: { failureRetriesBeforeAiConnectionWait: 0 } })).toBe(2);
    for (const count of [undefined, -1, 1.5, "0"]) {
      expect(executionFailureRetryCount({ scheduledRetryReason: "ai_connection_busy", scheduledRetryAttempt: 4,
        contextSnapshot: { failureRetriesBeforeAiConnectionWait: count } })).toBe(4);
    }
  });
  it("preserves prior failures through repeated workspace waits", () => {
    expect(executionFailureRetryCount({ scheduledRetryReason: "workspace_busy", scheduledRetryAttempt: 12,
      contextSnapshot: { failureRetriesBeforeWorkspaceWait: 1 } })).toBe(1);
  });
  it("does not trust a caller-supplied count outside a server-created workspace retry", () => {
    expect(executionFailureRetryCount({ scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 2,
      contextSnapshot: { failureRetriesBeforeWorkspaceWait: 0 } })).toBe(2);
  });
  it("keeps ambiguous historical counts without treating a historical productive count as failures", () => {
    expect(executionFailureRetryCount({ scheduledRetryReason: "workspace_busy", scheduledRetryAttempt: 4 })).toBe(4);
    expect(executionFailureRetryCount({ scheduledRetryReason: "max_turns_continuation", scheduledRetryAttempt: 4 })).toBe(0);
  });
});

describe("persisted independent accounting", () => {
  it.each(["max_turns_continuation", "issue_disposition_repair", "workspace_busy", "ai_connection_busy", "ai_connection_pool_wait", "runner_revision_wait"])("%s cannot erase prior infrastructure debits or spend more", scheduledRetryReason => {
    expect(executionFailureRetryCount({ scheduledRetryReason, scheduledRetryAttempt: 20,
      contextSnapshot: { executionRetryAccounting: { version: 1, failureRetries: 2, maxTurnContinuations: 1 } },
    })).toBe(2);
  });
  it("never lowers the current failure count from a partial or stale ledger", () => {
    for (const executionRetryAccounting of [
      { version: 1, failureRetries: 0, maxTurnContinuations: 1 },
      { version: 1, failureRetries: -1, maxTurnContinuations: 1 },
      { version: 1, failureRetries: "0", maxTurnContinuations: 1 },
      { version: 2, failureRetries: 0, maxTurnContinuations: 1 },
    ]) expect(executionFailureRetryCount({ scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 2,
      contextSnapshot: { executionRetryAccounting },
    })).toBe(2);
  });
});

describe("Runner update waits", () => {
  it("uses the same retry reason as run dispatch", () => {
    expect(RUNNER_REVISION_WAIT_RETRY_REASON).toBe(DISPATCH_RUNNER_REVISION_WAIT_RETRY_REASON);
  });
  const ledger = (failureRetries: number) => ({ executionRetryAccounting: { version: 1, failureRetries, maxTurnContinuations: 0 } });
  it("never spend the failure retry budget", () => {
    const waited = { scheduledRetryReason: "runner_revision_wait", scheduledRetryAttempt: 9, contextSnapshot: ledger(0) };
    expect(executionRetryAttemptCount(waited, "runner_revision_wait")).toBe(9);
    expect(accountingForScheduledRetry(waited, "runner_revision_wait", 10)).toMatchObject({ failureRetries: 0 });
    expect(executionFailureRetryCount(waited)).toBe(0);
    expect(executionRetryAttemptCount(waited, "transient_failure")).toBe(0);
  });
  it("keep failures recorded before the wait and are not shortened by them", () => {
    const failed = { scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 1, contextSnapshot: ledger(1) };
    expect(executionRetryAttemptCount(failed, "runner_revision_wait")).toBe(0);
    const waited = { scheduledRetryReason: "runner_revision_wait", scheduledRetryAttempt: 3,
      contextSnapshot: { ...ledger(1), executionRetryAccounting: accountingForScheduledRetry(failed, "runner_revision_wait", 3) } };
    expect(executionFailureRetryCount(waited)).toBe(1);
    expect(executionRetryAttemptCount(waited, "transient_failure")).toBe(1);
  });
});
